import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PortableProfileDefinitionSchema } from './symposium-profile-portability.js';
import { AgentTaskProposalInputSchema, AgentTaskRecordSchema } from '@mitzo/protocol';
import { AgentTaskStore } from './agent-task-store.js';
import { AgentTaskService } from './agent-task-service.js';
import { SymposiumProfileStore } from './symposium-profiles.js';

const Id = z.string().trim().min(1).max(128);
export const ProfileProposalInputSchema = z.strictObject({
  suggestedProfileId: Id.optional(),
  definition: PortableProfileDefinitionSchema,
});
const SaveProposalSchema = z.strictObject({
  profileId: Id,
  expectedRevision: z.number().int().nonnegative(),
  definition: PortableProfileDefinitionSchema,
});
type ProposalInput = z.infer<typeof ProfileProposalInputSchema>;
type ProposalRow = {
  proposal_id: string;
  session_id: string;
  suggested_profile_id: string | null;
  definition: string;
  state: 'pending' | 'saved' | 'discarded';
  created_at: number;
  saved_profile_id: string | null;
  saved_revision: number | null;
  saved_request_hash: string | null;
  request_hash: string;
  kind: 'profile' | 'task';
  task_request: string | null;
  saved_task_record: string | null;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const publicRow = (row: ProposalRow) => ({
  proposalId: row.proposal_id,
  sessionId: row.session_id,
  suggestedProfileId: row.suggested_profile_id,
  definition: PortableProfileDefinitionSchema.parse(JSON.parse(row.definition)),
  state: row.state,
  createdAt: row.created_at,
  savedProfileId: row.saved_profile_id,
  savedRevision: row.saved_revision,
});

/** Agent calls create proposals only. Saving requires a separate authenticated user request. */
export class SymposiumProfileProposalStore {
  private readonly db: Database.Database;
  private readonly profiles: SymposiumProfileStore;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS symposium_profile_proposals (
      owner TEXT NOT NULL,
      proposal_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      suggested_profile_id TEXT,
      definition TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'saved', 'discarded')),
      created_at INTEGER NOT NULL,
      saved_profile_id TEXT,
      saved_revision INTEGER,
      saved_request_hash TEXT,
      PRIMARY KEY (owner, proposal_id),
      UNIQUE (owner, session_id, idempotency_key)
    )`);
    if (
      !(this.db.pragma('table_info(symposium_profile_proposals)') as { name: string }[]).some(
        (column) => column.name === 'saved_request_hash',
      )
    )
      this.db.exec('ALTER TABLE symposium_profile_proposals ADD COLUMN saved_request_hash TEXT');
    for (const [name, declaration] of [
      ['kind', "TEXT NOT NULL DEFAULT 'profile'"],
      ['task_request', 'TEXT'],
      ['saved_task_record', 'TEXT'],
    ]) {
      if (
        !(this.db.pragma('table_info(symposium_profile_proposals)') as { name: string }[]).some(
          (column) => column.name === name,
        )
      )
        this.db.exec(`ALTER TABLE symposium_profile_proposals ADD COLUMN ${name} ${declaration}`);
    }
    this.profiles = new SymposiumProfileStore(dbPath, this.db);
  }
  close() {
    this.profiles.close();
    this.db.close();
  }

  propose(owner: string, sessionId: string, idempotencyKey: string, input: ProposalInput) {
    Id.parse(owner);
    Id.parse(sessionId);
    Id.parse(idempotencyKey);
    const value = ProfileProposalInputSchema.parse(input);
    const requestHash = hash(value);
    return this.db
      .transaction(() => {
        const retry = this.db
          .prepare(
            `SELECT * FROM symposium_profile_proposals
        WHERE owner = ? AND session_id = ? AND idempotency_key = ?`,
          )
          .get(owner, sessionId, idempotencyKey) as ProposalRow | undefined;
        if (retry) {
          if (retry.kind !== 'profile' || retry.request_hash !== requestHash)
            throw new Error('Conflicting proposal idempotency key');
          return publicRow(retry);
        }
        const proposalId = randomUUID();
        this.db
          .prepare(
            `INSERT INTO symposium_profile_proposals
        (owner, proposal_id, session_id, idempotency_key, request_hash,
         suggested_profile_id, definition, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          )
          .run(
            owner,
            proposalId,
            sessionId,
            idempotencyKey,
            requestHash,
            value.suggestedProfileId ?? null,
            JSON.stringify(value.definition),
            Date.now(),
          );
        return this.get(owner, sessionId, proposalId)!;
      })
      .immediate();
  }

  private taskRow(owner: string, sessionId: string, proposalId: string) {
    Id.parse(owner);
    Id.parse(sessionId);
    Id.parse(proposalId);
    return this.db
      .prepare(
        `SELECT * FROM symposium_profile_proposals WHERE owner=? AND session_id=? AND proposal_id=? AND kind='task'`,
      )
      .get(owner, sessionId, proposalId) as ProposalRow | undefined;
  }
  private publicTask(row: ProposalRow) {
    const input = AgentTaskProposalInputSchema.parse(JSON.parse(row.task_request!));
    return {
      kind: 'task' as const,
      proposalId: row.proposal_id,
      sessionId: row.session_id,
      ...input,
      state: row.state,
      createdAt: row.created_at,
      savedTask: row.saved_task_record
        ? AgentTaskRecordSchema.parse(JSON.parse(row.saved_task_record))
        : null,
    };
  }
  proposeTask(owner: string, sessionId: string, idempotencyKey: string, input: unknown) {
    Id.parse(owner);
    Id.parse(sessionId);
    Id.parse(idempotencyKey);
    const request = AgentTaskProposalInputSchema.parse(input);
    const requestHash = hash({ kind: 'task', ...request });
    return this.db
      .transaction(() => {
        const retry = this.db
          .prepare(
            `SELECT * FROM symposium_profile_proposals WHERE owner=? AND session_id=? AND idempotency_key=?`,
          )
          .get(owner, sessionId, idempotencyKey) as ProposalRow | undefined;
        if (retry) {
          if (retry.kind !== 'task' || retry.request_hash !== requestHash)
            throw Error('Conflicting proposal idempotency key');
          return this.publicTask(retry);
        }
        const proposalId = randomUUID();
        this.db
          .prepare(
            `INSERT INTO symposium_profile_proposals (owner,proposal_id,session_id,idempotency_key,request_hash,definition,state,created_at,kind,task_request) VALUES (?,?,?,?,?,?,'pending',?,'task',?)`,
          )
          .run(
            owner,
            proposalId,
            sessionId,
            idempotencyKey,
            requestHash,
            JSON.stringify(request.definition),
            Date.now(),
            JSON.stringify(request),
          );
        return this.publicTask(this.taskRow(owner, sessionId, proposalId)!);
      })
      .immediate();
  }
  listTaskProposals(owner: string, sessionId: string) {
    Id.parse(owner);
    Id.parse(sessionId);
    return (
      this.db
        .prepare(
          `SELECT * FROM symposium_profile_proposals WHERE owner=? AND session_id=? AND kind='task' AND state IN ('pending','saved') ORDER BY created_at,proposal_id`,
        )
        .all(owner, sessionId) as ProposalRow[]
    ).map((row) => this.publicTask(row));
  }
  saveTask(owner: string, sessionId: string, proposalId: string, input: unknown) {
    const request = AgentTaskProposalInputSchema.parse(input);
    const requestHash = hash(request);
    return this.db
      .transaction(() => {
        const row = this.taskRow(owner, sessionId, proposalId);
        if (!row) throw Error('Task proposal not found');
        if (row.state === 'saved') {
          if (row.saved_request_hash !== requestHash)
            throw Error('Conflicting task proposal save request');
          return AgentTaskRecordSchema.parse(JSON.parse(row.saved_task_record!));
        }
        if (row.state !== 'pending') throw Error('Task proposal was discarded');
        const original = AgentTaskProposalInputSchema.parse(JSON.parse(row.task_request!));
        if (
          request.taskId !== original.taskId ||
          request.expectedRevision !== original.expectedRevision
        )
          throw Error('Task proposal identity or revision conflict');
        const tasks = new AgentTaskService(new AgentTaskStore(this.db.name, this.db));
        const saved = tasks.save(owner, {
          ...request,
          idempotencyKey: `task-proposal:${proposalId}`,
        });
        this.db
          .prepare(
            `UPDATE symposium_profile_proposals SET state='saved',saved_request_hash=?,saved_task_record=? WHERE owner=? AND session_id=? AND proposal_id=? AND state='pending'`,
          )
          .run(requestHash, JSON.stringify(saved), owner, sessionId, proposalId);
        return saved;
      })
      .immediate();
  }
  discardTask(owner: string, sessionId: string, proposalId: string) {
    return this.db
      .transaction(() => {
        const row = this.taskRow(owner, sessionId, proposalId);
        if (!row) throw Error('Task proposal not found');
        if (row.state === 'saved') throw Error('Saved task proposal cannot be discarded');
        this.db
          .prepare(
            `UPDATE symposium_profile_proposals SET state='discarded' WHERE owner=? AND session_id=? AND proposal_id=? AND state='pending'`,
          )
          .run(owner, sessionId, proposalId);
        return this.publicTask(this.taskRow(owner, sessionId, proposalId)!);
      })
      .immediate();
  }

  get(owner: string, sessionId: string, proposalId: string) {
    Id.parse(owner);
    Id.parse(sessionId);
    Id.parse(proposalId);
    const row = this.db
      .prepare(
        `SELECT * FROM symposium_profile_proposals
      WHERE owner = ? AND session_id = ? AND proposal_id = ? AND kind = 'profile'`,
      )
      .get(owner, sessionId, proposalId) as ProposalRow | undefined;
    return row ? publicRow(row) : null;
  }

  listPending(owner: string, sessionId: string) {
    Id.parse(owner);
    Id.parse(sessionId);
    return (
      this.db
        .prepare(
          `SELECT * FROM symposium_profile_proposals
      WHERE owner = ? AND session_id = ? AND kind = 'profile' AND state = 'pending' ORDER BY created_at, proposal_id`,
        )
        .all(owner, sessionId) as ProposalRow[]
    ).map(publicRow);
  }

  discard(owner: string, sessionId: string, proposalId: string) {
    return this.db
      .transaction(() => {
        const proposal = this.get(owner, sessionId, proposalId);
        if (!proposal) throw new Error('Profile proposal not found');
        if (proposal.state === 'saved')
          throw new Error('Saved profile proposal cannot be discarded');
        if (proposal.state === 'pending') {
          const updated = this.db
            .prepare(
              `UPDATE symposium_profile_proposals
          SET state = 'discarded' WHERE owner = ? AND session_id = ? AND proposal_id = ?
          AND state = 'pending'`,
            )
            .run(owner, sessionId, proposalId);
          if (updated.changes !== 1) throw new Error('Profile proposal state changed');
        }
        return this.get(owner, sessionId, proposalId)!;
      })
      .immediate();
  }

  save(owner: string, sessionId: string, proposalId: string, input: unknown) {
    const request = SaveProposalSchema.parse(input);
    const requestHash = hash(request);
    return this.db
      .transaction(() => {
        const proposal = this.db
          .prepare(
            `SELECT * FROM symposium_profile_proposals
        WHERE owner = ? AND session_id = ? AND proposal_id = ? AND kind = 'profile'`,
          )
          .get(owner, sessionId, proposalId) as ProposalRow | undefined;
        if (!proposal) throw new Error('Profile proposal not found');
        if (proposal.state === 'saved') {
          if (proposal.saved_request_hash !== requestHash)
            throw new Error('Conflicting profile proposal save request');
          const saved = this.profiles.get(
            owner,
            proposal.saved_profile_id!,
            proposal.saved_revision!,
          );
          if (!saved) throw new Error('Saved proposal profile revision is missing');
          return saved;
        }
        if (proposal.state !== 'pending') throw new Error('Profile proposal was discarded');
        const saved = this.profiles.save(owner, {
          ...request,
          idempotencyKey: `proposal:${proposalId}`,
        });
        const updated = this.db
          .prepare(
            `UPDATE symposium_profile_proposals
          SET state = 'saved', saved_profile_id = ?, saved_revision = ?, saved_request_hash = ?
          WHERE owner = ? AND session_id = ? AND proposal_id = ? AND state = 'pending'`,
          )
          .run(saved.profileId, saved.revision, requestHash, owner, sessionId, proposalId);
        if (updated.changes !== 1) throw new Error('Profile proposal state changed');
        return saved;
      })
      .immediate();
  }
}
