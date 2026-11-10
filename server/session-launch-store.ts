import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  SessionLaunchConfigSchema,
  SessionLaunchRecordSchema,
  type SessionLaunchConfig,
  type SessionLaunchRecord,
} from '@mitzo/protocol';
import { z } from 'zod';

export class SessionLaunchError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
export type SessionLaunchEdits = {
  title: string;
  prompt: string;
  configuration: SessionLaunchConfig;
};
export type SessionLaunchApprovalEffect = (database: Database.Database) => void;
export type RetainedSessionLaunch = SessionLaunchRecord & {
  allocationId: string | null;
  commandId: string | null;
  preparationId: string | null;
};
export function publicSessionLaunchRecord(record: RetainedSessionLaunch): SessionLaunchRecord {
  const publicRecord: Partial<RetainedSessionLaunch> = { ...record };
  delete publicRecord.allocationId;
  delete publicRecord.commandId;
  delete publicRecord.preparationId;
  return SessionLaunchRecordSchema.parse(publicRecord);
}
type Envelope = {
  owner: string;
  fingerprint: string;
  claimed: boolean;
  record: RetainedSessionLaunch;
};
const retainedRecord = SessionLaunchRecordSchema.extend({
  allocationId: z.uuid().nullable(),
  commandId: z.uuid().nullable(),
  preparationId: z.string().min(1).nullable(),
});
const envelopeSchema = z.strictObject({
  owner: z.string().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  claimed: z.boolean(),
  record: retainedRecord,
});
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
/** Private request ledger shares the ordinary EventStore's backup lifetime.
 * It records intent and parentage; ordinary command receipts own execution. */
export class SessionLaunchStore {
  private db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS session_launch_requests (
      proposal_id TEXT PRIMARY KEY, owner TEXT NOT NULL, source_session_id TEXT NOT NULL,
      request_id TEXT NOT NULL, child_session_id TEXT, data TEXT NOT NULL,
      UNIQUE(owner,source_session_id,request_id));
      CREATE INDEX IF NOT EXISTS idx_session_launch_child ON session_launch_requests(child_session_id);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS session_chat_links (
      owner TEXT NOT NULL, first_id TEXT NOT NULL, second_id TEXT NOT NULL,
      first_title TEXT NOT NULL, second_title TEXT NOT NULL,
      PRIMARY KEY(owner,first_id,second_id));`);
  }
  close() {
    this.db.close();
  }
  /** Symmetric navigation only: never an authorization, launch or copied history. */
  link(owner: string, first: string, second: string, firstTitle: string, secondTitle: string) {
    if (first === second) throw new SessionLaunchError('Choose a different chat.', 400);
    if (first > second)
      [first, second, firstTitle, secondTitle] = [second, first, secondTitle, firstTitle];
    this.db
      .prepare('INSERT OR IGNORE INTO session_chat_links VALUES(?,?,?,?,?)')
      .run(owner, first, second, firstTitle, secondTitle);
  }
  unlink(owner: string, first: string, second: string) {
    if (first > second) [first, second] = [second, first];
    this.db
      .prepare('DELETE FROM session_chat_links WHERE owner=? AND first_id=? AND second_id=?')
      .run(owner, first, second);
  }
  linked(sessionId: string, owner: string): Array<{ sessionId: string; title: string }> {
    const rows = this.db
      .prepare(
        'SELECT first_id,second_id,first_title,second_title FROM session_chat_links WHERE owner=? AND (first_id=? OR second_id=?) ORDER BY rowid DESC',
      )
      .all(owner, sessionId, sessionId) as Array<{
      first_id: string;
      second_id: string;
      first_title: string;
      second_title: string;
    }>;
    return rows.map((row) =>
      row.first_id === sessionId
        ? { sessionId: row.second_id, title: row.second_title }
        : { sessionId: row.first_id, title: row.first_title },
    );
  }
  private read(id: string): Envelope {
    const row = this.db
      .prepare('SELECT data FROM session_launch_requests WHERE proposal_id=?')
      .get(id) as { data: string } | undefined;
    if (!row) throw new SessionLaunchError('Session launch not found.', 404);
    return envelopeSchema.parse(JSON.parse(row.data));
  }
  private save(envelope: Envelope) {
    envelope = envelopeSchema.parse(envelope);
    this.db
      .prepare('UPDATE session_launch_requests SET child_session_id=?,data=? WHERE proposal_id=?')
      .run(envelope.record.childSessionId, JSON.stringify(envelope), envelope.record.proposalId);
    return structuredClone(envelope.record);
  }
  private mutate(id: string, action: (entry: Envelope) => void) {
    return this.db
      .transaction(() => {
        const entry = this.read(id);
        action(entry);
        return this.save(entry);
      })
      .immediate();
  }
  get(id: string, owner: string): RetainedSessionLaunch {
    const entry = this.read(id);
    if (entry.owner !== owner) throw new SessionLaunchError('Session launch not found.', 404);
    return structuredClone(entry.record);
  }
  forRequest(
    sourceSessionId: string,
    owner: string,
    requestId: string,
  ): RetainedSessionLaunch | undefined {
    const row = this.db
      .prepare(
        'SELECT data FROM session_launch_requests WHERE owner=? AND source_session_id=? AND request_id=?',
      )
      .get(owner, sourceSessionId, requestId) as { data: string } | undefined;
    return row ? envelopeSchema.parse(JSON.parse(row.data)).record : undefined;
  }
  forSession(sessionId: string, owner: string): RetainedSessionLaunch[] {
    return (
      this.db
        .prepare(
          'SELECT data FROM session_launch_requests WHERE owner=? AND (source_session_id=? OR child_session_id=?) ORDER BY rowid',
        )
        .all(owner, sessionId, sessionId) as Array<{ data: string }>
    ).map((row) => envelopeSchema.parse(JSON.parse(row.data)).record);
  }
  propose(
    input: SessionLaunchEdits & {
      operatorId: string;
      sourceSessionId: string;
      requestId: string;
      originalInput?: unknown;
    },
  ): RetainedSessionLaunch {
    return this.db
      .transaction(() => {
        SessionLaunchConfigSchema.parse(input.configuration);
        const fingerprint = createHash('sha256')
          .update(JSON.stringify(canonical(input.originalInput ?? input)))
          .digest('hex');
        const row = this.db
          .prepare(
            'SELECT data FROM session_launch_requests WHERE owner=? AND source_session_id=? AND request_id=?',
          )
          .get(input.operatorId, input.sourceSessionId, input.requestId) as
          { data: string } | undefined;
        if (row) {
          const previous = envelopeSchema.parse(JSON.parse(row.data));
          if (previous.fingerprint !== fingerprint)
            throw new SessionLaunchError('Session launch request identity changed.');
          return previous.record;
        }
        const now = Date.now();
        const record: RetainedSessionLaunch = {
          proposalId: randomUUID(),
          requestId: input.requestId,
          sourceSessionId: input.sourceSessionId,
          title: input.title,
          prompt: input.prompt,
          configuration: structuredClone(input.configuration),
          revision: 1,
          state: 'pending',
          childSessionId: null,
          createdAt: now,
          updatedAt: now,
          allocationId: null,
          commandId: null,
          preparationId: null,
        };
        const envelope: Envelope = { owner: input.operatorId, fingerprint, claimed: false, record };
        envelopeSchema.parse(envelope);
        this.db
          .prepare('INSERT INTO session_launch_requests VALUES(?,?,?,?,?,?)')
          .run(
            record.proposalId,
            input.operatorId,
            input.sourceSessionId,
            input.requestId,
            null,
            JSON.stringify(envelope),
          );
        return structuredClone(record);
      })
      .immediate();
  }
  approve(
    id: string,
    owner: string,
    edits: SessionLaunchEdits,
    expectedRevision: number,
    beforeApply?: SessionLaunchApprovalEffect,
  ) {
    edits = SessionLaunchRecordSchema.pick({
      title: true,
      prompt: true,
      configuration: true,
    }).parse({
      title: edits.title,
      prompt: edits.prompt,
      configuration: edits.configuration,
    });
    this.get(id, owner);
    return this.mutate(id, (entry) => {
      const r = entry.record;
      if (r.state !== 'pending') {
        if (r.state === 'cancelled') throw new SessionLaunchError('Session launch was cancelled.');
        if (
          !isDeepStrictEqual(
            { title: r.title, prompt: r.prompt, configuration: r.configuration },
            edits,
          )
        )
          throw new SessionLaunchError('The approved launch identity changed.');
        return;
      }
      if (r.revision !== expectedRevision)
        throw new SessionLaunchError('Session launch revision changed.');
      beforeApply?.(this.db);
      Object.assign(r, structuredClone(edits), {
        allocationId: randomUUID(),
        commandId: randomUUID(),
        state: 'starting',
        revision: r.revision + 1,
        updatedAt: Date.now(),
      });
    });
  }
  /** A lost controller never automatically repeats preparation or dispatch. */
  claimStart(id: string): boolean {
    return this.db
      .transaction(() => {
        const entry = this.read(id);
        if (entry.claimed || entry.record.state !== 'starting') return false;
        entry.claimed = true;
        this.save(entry);
        return true;
      })
      .immediate();
  }
  claimResume(id: string, owner: string, expectedRevision: number) {
    this.get(id, owner);
    return this.mutate(id, (entry) => {
      if (entry.record.state !== 'uncertain' || entry.record.revision !== expectedRevision)
        throw new SessionLaunchError(
          'Startup changed. Reload its current receipt before resuming.',
        );
      if (!entry.record.allocationId || !entry.record.commandId)
        throw new SessionLaunchError('Original startup operation required.');
      entry.claimed = true;
      Object.assign(entry.record, {
        state: 'starting',
        error: undefined,
        revision: entry.record.revision + 1,
        updatedAt: Date.now(),
      });
    });
  }
  markPrepared(id: string, childSessionId: string, preparationId: string) {
    return this.mutate(id, (entry) => {
      const r = entry.record;
      if (
        (r.childSessionId && r.childSessionId !== childSessionId) ||
        (r.preparationId && r.preparationId !== preparationId)
      )
        throw new SessionLaunchError('Allocated session identity changed.');
      if (!['starting', 'created', 'uncertain'].includes(r.state))
        throw new SessionLaunchError('Launch is not starting.');
      Object.assign(r, {
        childSessionId,
        preparationId,
        state: r.state === 'uncertain' ? 'uncertain' : 'created',
        revision: r.revision + 1,
        updatedAt: Date.now(),
      });
    });
  }
  markRunning(id: string) {
    return this.mutate(id, (entry) => {
      if (
        !entry.record.childSessionId ||
        !['starting', 'created', 'uncertain', 'running'].includes(entry.record.state)
      )
        throw new SessionLaunchError('Allocated session required.');
      Object.assign(entry.record, {
        state: 'running',
        error: undefined,
        revision: entry.record.revision + 1,
        updatedAt: Date.now(),
      });
    });
  }
  fail(id: string, error: string, uncertain = false) {
    return this.mutate(id, (entry) => {
      if (['running', 'cancelled'].includes(entry.record.state)) return;
      const state = uncertain ? 'uncertain' : 'failed';
      if (entry.record.state === state && entry.record.error === error) return;
      Object.assign(entry.record, {
        state,
        error,
        revision: entry.record.revision + 1,
        updatedAt: Date.now(),
      });
    });
  }
  cancel(id: string, owner: string, expectedRevision: number) {
    this.get(id, owner);
    return this.mutate(id, (entry) => {
      if (entry.record.state === 'cancelled') return;
      if (entry.record.state !== 'pending')
        throw new SessionLaunchError('Only a pending launch can be cancelled.');
      if (entry.record.revision !== expectedRevision)
        throw new SessionLaunchError('Session launch revision changed.');
      Object.assign(entry.record, {
        state: 'cancelled',
        revision: entry.record.revision + 1,
        updatedAt: Date.now(),
      });
    });
  }
}
