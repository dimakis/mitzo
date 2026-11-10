import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { DeploymentOperation } from './deployment-store.js';

export function maintenanceFingerprint(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string') throw Error('Complete maintenance evidence required');
  return createHash('sha256').update(encoded).digest('hex');
}

export function readMaintenancePendingCommands(db: Database.Database) {
  return db
    .prepare(
      "SELECT * FROM send_commands WHERE json_extract(ordinary_admission,'$.state') IN ('reserved','uncertain') OR (preparing=1 AND error IS NULL) ORDER BY client_msg_id",
    )
    .all() as Array<{
    client_msg_id: string;
    session_id: string;
    ordinary_admission: string | null;
  }>;
}

type Auth = DeploymentOperation['auth'];
export interface DrainedMaintenancePort {
  /** Real signed operator plus persistent expiry/revocation at this boundary. */
  authorize(): Auth;
  /** Source process, job respawn and ordinary helpers must be excluded. */
  assertSourceExcluded(): void;
  /** Exact current owners completed naturally; no cancellation/missing-row inference. */
  assertDrained(quarantinedIds: readonly string[]): {
    retainedSessionIds: string[];
    proofSha256: string;
    sessions: Array<{
      sessionId: string;
      snapshot: Record<string, unknown>;
      completionSha256: string;
      custodySha256: string;
    }>;
  };
}

/** Offline-only handoff. Original uncertainty and source operation bytes remain
 * unchanged; quarantine is permanent and cannot grant execution authority. */
export class DeploymentMaintenanceStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS deployment_quarantines (
      session_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL,
      original_commands TEXT NOT NULL
    )`);
  }
  assertControl(sessionId: string): void {
    if (this.isQuarantined(sessionId))
      throw Error('Historical execution is quarantined; retained history is read-only');
  }
  isQuarantined(sessionId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM deployment_quarantines WHERE session_id=?')
      .get(sessionId);
  }
  sessionIds(): string[] {
    return (
      this.db
        .prepare('SELECT session_id FROM deployment_quarantines ORDER BY session_id')
        .all() as Array<{ session_id: string }>
    ).map((row) => row.session_id);
  }
  /** Expected fingerprints are the operator-reviewed original pending rows.
   * No age threshold or missing custody is treated as a settled outcome. */
  adopt(
    input: {
      id: string;
      sourceOperationId: string;
      sourceOperationSha256: string;
      authorityId: string;
      sourceCommit: string;
      targetCommit: string;
      expectedRunningSessions: Array<{ sessionId: string; targetSha256: string }>;
      expectedCommands: Array<{ commandId: string; sha256: string }>;
    },
    port: DrainedMaintenancePort,
  ): DeploymentOperation {
    port.assertSourceExcluded();
    return this.db
      .transaction(() => {
        port.assertSourceExcluded();
        const auth = port.authorize();
        const row = this.db
          .prepare('SELECT data FROM deployment_operations WHERE id=? AND held=1')
          .get(input.sourceOperationId) as { data: string } | undefined;
        if (!row || maintenanceFingerprint(row.data) !== input.sourceOperationSha256)
          throw Error('Exact original source hold required');
        const source = JSON.parse(row.data) as DeploymentOperation;
        if (
          source.id !== input.sourceOperationId ||
          source.sourceCommit !== input.sourceCommit ||
          source.targetCommit !== input.targetCommit ||
          source.phase !== 'capturing' ||
          source.sessions.length ||
          source.activationHash ||
          source.maintenance ||
          source.auth.id !== auth.id ||
          source.auth.expiresAt !== auth.expiresAt
        )
          throw Error('Original uncaptured source hold and operator required');
        if (
          !input.authorityId ||
          input.id === source.id ||
          this.db.prepare('SELECT 1 FROM deployment_operations WHERE id=?').get(input.id)
        )
          throw Error('Fresh maintenance identity and authority required');
        const commands = readMaintenancePendingCommands(this.db);
        const expected = new Map(
          input.expectedCommands.map((command) => [command.commandId, command.sha256]),
        );
        if (
          !commands.length ||
          expected.size !== input.expectedCommands.length ||
          commands.length !== expected.size ||
          commands.some(
            (command) =>
              expected.get(command.client_msg_id) !== maintenanceFingerprint(command) ||
              JSON.parse(command.ordinary_admission ?? '{}').state !== 'uncertain',
          )
        )
          throw Error('Exact reviewed historical uncertainty required');
        const ids = [...new Set(commands.map((command) => command.session_id))].sort();
        for (const id of ids) {
          // Legacy is_active can disagree with ENDED. Preserve that row; actual
          // current owner/native exclusion belongs to the required drained port.
          const session = this.db
            .prepare('SELECT state,execution_phase FROM sessions WHERE session_id=?')
            .get(id) as { state: string; execution_phase: string | null } | undefined;
          if (
            !session ||
            session.state !== 'ENDED' ||
            (session.execution_phase !== null && session.execution_phase !== 'TERMINAL') ||
            this.isQuarantined(id)
          )
            throw Error('Only ended historical sessions may be quarantined');
        }
        const drained = port.assertDrained(ids);
        if (
          !/^[a-f0-9]{64}$/.test(drained.proofSha256) ||
          new Set(drained.retainedSessionIds).size !== drained.retainedSessionIds.length ||
          drained.retainedSessionIds.some((id) => ids.includes(id))
        )
          throw Error('Distinct drained current owners and proof required');
        const running = new Map(
          input.expectedRunningSessions.map((owner) => [owner.sessionId, owner.targetSha256]),
        );
        if (
          running.size !== input.expectedRunningSessions.length ||
          drained.sessions.length !== running.size ||
          new Set(drained.sessions.map((owner) => owner.sessionId)).size !== running.size ||
          drained.sessions.some(
            (owner) =>
              !drained.retainedSessionIds.includes(owner.sessionId) ||
              running.get(owner.sessionId) !== maintenanceFingerprint(owner.snapshot.target) ||
              !/^[a-f0-9]{64}$/.test(owner.completionSha256) ||
              !/^[a-f0-9]{64}$/.test(owner.custodySha256),
          )
        )
          throw Error('Exactly the captured running targets may receive continuation');
        port.assertSourceExcluded();
        const current = port.authorize();
        if (current.id !== auth.id || current.expiresAt !== auth.expiresAt)
          throw Error('Maintenance operator changed');
        const operation: DeploymentOperation = {
          id: input.id,
          sourceCommit: source.sourceCommit,
          targetCommit: source.targetCommit,
          auth,
          phase: 'activating',
          sessions: drained.sessions.map((owner) => ({
            sessionId: owner.sessionId,
            snapshot: owner.snapshot,
            interruptId: randomUUID(),
            resumeId: randomUUID(),
            state: 'paused',
            error: null,
            drainedProof: {
              kind: 'naturally-completed-v1',
              targetSha256: running.get(owner.sessionId)!,
              completionSha256: owner.completionSha256,
              custodySha256: owner.custodySha256,
              handoffSha256: drained.proofSha256,
            },
          })),
          createdAt: Date.now(),
          maintenance: {
            kind: 'drained-handoff-v1',
            sourceOperationId: source.id,
            sourceOperationSha256: input.sourceOperationSha256,
            authorityHash: createHash('sha256').update(input.authorityId).digest('hex'),
            proofSha256: drained.proofSha256,
            retainedSessionIds: drained.retainedSessionIds,
            quarantinedSessionIds: ids,
          },
        };
        for (const id of ids)
          this.db
            .prepare('INSERT INTO deployment_quarantines VALUES(?,?,?)')
            .run(
              id,
              input.id,
              JSON.stringify(commands.filter((command) => command.session_id === id)),
            );
        // Retire only the hold bit. Do not rewrite the installed operation's phase
        // or forge its activation capability or pause settlement.
        this.db
          .prepare('UPDATE deployment_operations SET held=0 WHERE id=? AND held=1')
          .run(source.id);
        this.db
          .prepare('INSERT INTO deployment_operations(id,data,held) VALUES(?,?,1)')
          .run(operation.id, JSON.stringify(operation));
        if (
          maintenanceFingerprint(readMaintenancePendingCommands(this.db)) !==
            maintenanceFingerprint(commands) ||
          (
            this.db.prepare('SELECT data FROM deployment_operations WHERE id=?').get(source.id) as {
              data: string;
            }
          ).data !== row.data
        )
          throw Error('Original historical evidence changed during handoff');
        return operation;
      })
      .immediate();
  }
}
