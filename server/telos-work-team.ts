import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import {
  TelosTeamCommandSchema,
  TelosTeamMembershipSchema,
  TelosTeamReceiptSchema,
  type TelosTeamCommand,
  type TelosTeamMembership,
  type TelosTeamView,
  type TelosTeamReceipt,
} from '@mitzo/protocol';
import { TelosWorkError } from './telos-work-store.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ownerRoles = new Set(['orchestrator', 'feature_lead', 'slice_owner']);
function conflict(message: string): never {
  throw new TelosWorkError('conflict', message);
}

function readPersistedTeam<T>(data: string, schema: { parse(value: unknown): T }): T {
  try {
    return schema.parse(JSON.parse(data));
  } catch (cause) {
    // Persisted validation is a storage failure, not invalid caller input.
    // Retain the original parse cause for the existing sanitized diagnostics.
    throw new Error('Invalid persisted Telos team data', { cause });
  }
}

/** Uses the canonical work owner's connection and transaction. No allocation,
 * context adoption, model dispatch, formal assignment or permission mutation. */
export class TelosWorkTeam {
  constructor(private readonly db: Database.Database) {}

  read(itemId: string): TelosTeamView {
    const rows = this.db
      .prepare(
        'SELECT membership_id,data FROM telos_work_team_memberships WHERE item_id=? ORDER BY seq',
      )
      .all(itemId) as { membership_id: string; data: string }[];
    const members = rows.map((row) => {
      const member = readPersistedTeam(row.data, TelosTeamMembershipSchema);
      if (member.membershipId !== row.membership_id)
        throw new Error('Team membership identity mismatch');
      return member;
    });
    return { itemId, revision: digest({ itemId, members }), members };
  }

  execute(
    raw: unknown,
    actorId: string,
    assertCurrent: (input: TelosTeamCommand) => void,
  ): { receipt: TelosTeamReceipt; changed: boolean } {
    const input = TelosTeamCommandSchema.parse(raw);
    return this.db
      .transaction(() => {
        const fingerprint = digest(input);
        const saved = this.db
          .prepare(
            'SELECT fingerprint,receipt FROM telos_work_team_commands WHERE actor_id=? AND request_id=?',
          )
          .get(actorId, input.requestId) as { fingerprint: string; receipt: string } | undefined;
        if (saved) {
          if (saved.fingerprint !== fingerprint)
            conflict('Team command identity reused with different input');
          return {
            receipt: readPersistedTeam(saved.receipt, TelosTeamReceiptSchema),
            changed: false,
          };
        }
        const team = this.read(input.itemId);
        if (team.revision !== input.expectedRevision)
          conflict('Team revision conflict; read the current team before retrying');
        const commandId = randomUUID();
        const now = new Date().toISOString();
        const previous =
          input.operation === 'link'
            ? undefined
            : team.members.find((member) => member.membershipId === input.membershipId);
        if (input.operation !== 'link' && previous?.state !== 'current')
          conflict('Current team membership required; retain the original operation for recovery');

        let next: TelosTeamMembership | undefined;
        if (input.operation !== 'unlink') {
          if (
            previous &&
            (previous.role !== input.role || previous.conversationId === input.conversationId)
          )
            conflict('Replacement requires the same role and a different conversation');
          if (
            team.members.some(
              (member) =>
                member.state === 'current' &&
                member.membershipId !== previous?.membershipId &&
                member.role === input.role &&
                (ownerRoles.has(input.role) || member.conversationId === input.conversationId),
            )
          )
            conflict(
              'A current member already holds this role; explicitly replace the existing membership',
            );
          if (
            input.reportsToMembershipId !== null &&
            !team.members.some(
              (member) =>
                member.membershipId === input.reportsToMembershipId &&
                member.state === 'current' &&
                member.membershipId !== previous?.membershipId,
            )
          )
            conflict('Reporting target must be a current member of this team');
          next = TelosTeamMembershipSchema.parse({
            membershipId: randomUUID(),
            conversationId: input.conversationId,
            displayName: input.displayName,
            role: input.role,
            responsibility: input.responsibility,
            reportsToMembershipId: input.reportsToMembershipId,
            state: 'current',
            linkedAt: now,
            linkedBy: actorId,
            endedAt: null,
            endedBy: null,
            operationId: commandId,
            replacedByMembershipId: null,
          });
        }
        // Requalify host authority and compatible session selection at the actual
        // writer boundary. Completed receipts above do not become new actions.
        assertCurrent(input);
        if (previous)
          this.db
            .prepare('UPDATE telos_work_team_memberships SET data=? WHERE membership_id=?')
            .run(
              JSON.stringify({
                ...previous,
                state: 'former',
                endedAt: now,
                endedBy: actorId,
                operationId: commandId,
                replacedByMembershipId: next?.membershipId ?? null,
              }),
              previous.membershipId,
            );
        if (next)
          this.db
            .prepare(
              'INSERT INTO telos_work_team_memberships(membership_id,item_id,data) VALUES(?,?,?)',
            )
            .run(next.membershipId, input.itemId, JSON.stringify(next));
        const receipt = TelosTeamReceiptSchema.parse({
          requestId: input.requestId,
          commandId,
          actorId,
          team: this.read(input.itemId),
        });
        this.db
          .prepare(
            'INSERT INTO telos_work_team_commands(actor_id,request_id,fingerprint,receipt) VALUES(?,?,?,?)',
          )
          .run(actorId, input.requestId, fingerprint, JSON.stringify(receipt));
        return { receipt, changed: true };
      })
      .immediate();
  }
}
