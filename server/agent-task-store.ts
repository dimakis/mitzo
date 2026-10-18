import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AgentTaskIdSchema,
  AgentTaskRecordSchema,
  SaveAgentTaskSchema,
  RemoveAgentTaskSchema,
  type AgentTaskRecord,
} from '@mitzo/protocol';
import { z } from 'zod';
import { SymposiumProfileStore } from './symposium-profiles.js';

const Owner = z.string().trim().min(1).max(128);
const fingerprint = (input: unknown) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');
type Row = { record: string };
export class AgentTaskError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 404 | 409,
  ) {
    super(message);
  }
}

/** Task definitions share the profile/event database and its backup boundary.
 * Append-only revisions and retry receipts commit in one immediate transaction.
 * This store has no provider, credential, scheduling or session dependency. */
export class AgentTaskStore {
  private readonly db: Database.Database;
  private readonly profiles: SymposiumProfileStore;
  constructor(
    path: string,
    private readonly sharedDb?: Database.Database,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = sharedDb ?? new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.profiles = new SymposiumProfileStore(path, this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_task_revisions (
        owner TEXT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL,
        record TEXT NOT NULL, PRIMARY KEY(owner, task_id, revision)
      );
      CREATE TABLE IF NOT EXISTS agent_task_retries (
        owner TEXT NOT NULL, idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        result TEXT NOT NULL, PRIMARY KEY(owner, idempotency_key)
      );
    `);
  }
  close() {
    if (!this.sharedDb && this.db.open) this.db.close();
  }
  get(owner: string, taskId: string, revision?: number): AgentTaskRecord | null {
    Owner.parse(owner);
    AgentTaskIdSchema.parse(taskId);
    if (revision !== undefined) z.number().int().positive().parse(revision);
    const row = (
      revision === undefined
        ? this.db
            .prepare(
              'SELECT record FROM agent_task_revisions WHERE owner=? AND task_id=? ORDER BY revision DESC LIMIT 1',
            )
            .get(owner, taskId)
        : this.db
            .prepare(
              'SELECT record FROM agent_task_revisions WHERE owner=? AND task_id=? AND revision=?',
            )
            .get(owner, taskId, revision)
    ) as Row | undefined;
    if (!row) return null;
    const record = AgentTaskRecordSchema.parse(JSON.parse(row.record));
    return revision === undefined && record.deleted ? null : record;
  }
  list(owner: string): AgentTaskRecord[] {
    Owner.parse(owner);
    const rows = this.db
      .prepare(
        `SELECT r.record FROM agent_task_revisions r
      WHERE r.owner=? AND r.revision=(SELECT MAX(h.revision) FROM agent_task_revisions h
        WHERE h.owner=r.owner AND h.task_id=r.task_id) ORDER BY r.task_id`,
      )
      .all(owner) as Row[];
    return rows
      .map((row) => AgentTaskRecordSchema.parse(JSON.parse(row.record)))
      .filter((record) => !record.deleted);
  }
  private retry(
    owner: string,
    key: string,
    input: unknown,
    execute: () => AgentTaskRecord,
  ): AgentTaskRecord {
    Owner.parse(owner);
    return this.db
      .transaction(() => {
        const hash = fingerprint(input);
        const prior = this.db
          .prepare(
            'SELECT fingerprint,result FROM agent_task_retries WHERE owner=? AND idempotency_key=?',
          )
          .get(owner, key) as { fingerprint: string; result: string } | undefined;
        if (prior) {
          if (prior.fingerprint !== hash)
            throw new AgentTaskError('Conflicting task idempotency key', 409);
          return AgentTaskRecordSchema.parse(JSON.parse(prior.result));
        }
        const saved = execute();
        const json = JSON.stringify(saved);
        this.db
          .prepare('INSERT INTO agent_task_revisions VALUES (?,?,?,?)')
          .run(owner, saved.taskId, saved.revision, json);
        this.db
          .prepare('INSERT INTO agent_task_retries VALUES (?,?,?,?)')
          .run(owner, key, hash, json);
        return saved;
      })
      .immediate();
  }
  save(owner: string, input: unknown): AgentTaskRecord {
    const request = SaveAgentTaskSchema.parse(input);
    return this.retry(owner, request.idempotencyKey, { operation: 'save', ...request }, () => {
      const head = this.db
        .prepare(
          'SELECT MAX(revision) AS revision FROM agent_task_revisions WHERE owner=? AND task_id=?',
        )
        .get(owner, request.taskId) as { revision: number | null };
      const current = this.get(owner, request.taskId);
      if ((head.revision ?? 0) !== request.expectedRevision || (head.revision && !current))
        throw new AgentTaskError('Task revision conflict', 409);
      const binding = request.definition.profile;
      const profile = this.profiles.get(owner, binding.profileId, binding.revision);
      if (!profile) throw new AgentTaskError('Profile revision not found', 404);
      if (profile.contentHash !== binding.contentHash)
        throw new AgentTaskError('Profile content hash conflict', 409);
      const now = new Date().toISOString();
      return {
        taskId: request.taskId,
        revision: request.expectedRevision + 1,
        definition: request.definition,
        configuration:
          !request.definition.objective.trim() ||
          !request.definition.execution ||
          !request.definition.workspace
            ? { state: 'draft' }
            : { state: 'blocked', reason: 'admission-unavailable' },
        deleted: false,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
    });
  }
  remove(owner: string, input: unknown): AgentTaskRecord {
    const request = RemoveAgentTaskSchema.parse(input);
    return this.retry(owner, request.idempotencyKey, { operation: 'remove', ...request }, () => {
      const current = this.get(owner, request.taskId);
      if (!current) throw new AgentTaskError('Task not found', 404);
      if (current.revision !== request.expectedRevision)
        throw new AgentTaskError('Task revision conflict', 409);
      return {
        ...current,
        revision: current.revision + 1,
        deleted: true,
        updatedAt: new Date().toISOString(),
      };
    });
  }
}
