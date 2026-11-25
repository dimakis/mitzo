import type Database from 'better-sqlite3';
import { ContextMeasurementSchema, type ContextMeasurement } from './context-measurement.js';
import {
  contextSnapshotScopeKey,
  ContextSnapshotReasonSchema,
  type ContextSnapshotScope,
  type ContextSnapshotReason,
} from './context-snapshot.js';

interface Row {
  revision: number;
  snapshot: string | null;
  reason: string | null;
}
/** Borrows the EventStore database; no provider acquisition, usage accounting or new DB owner. */
export class ContextSnapshotStore {
  constructor(
    private readonly owner: {
      database(): Database.Database;
      hasSession(id: string): boolean;
    },
  ) {
    owner.database().exec(`CREATE TABLE IF NOT EXISTS context_snapshots (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, snapshot TEXT, reason TEXT
    );
    CREATE TABLE IF NOT EXISTS context_snapshot_requests (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      PRIMARY KEY(session_id, request_id)
    );`);
  }
  read(sessionId: string): {
    revision: number;
    snapshot?: ContextMeasurement;
    reason?: ContextSnapshotReason;
  } {
    const row = this.owner
      .database()
      .prepare('SELECT revision,snapshot,reason FROM context_snapshots WHERE session_id=?')
      .get(sessionId) as Row | undefined;
    if (!row) return { revision: 0 };
    return {
      revision: row.revision,
      snapshot: row.snapshot ? ContextMeasurementSchema.parse(JSON.parse(row.snapshot)) : undefined,
      reason: row.reason ? ContextSnapshotReasonSchema.parse(row.reason) : undefined,
    };
  }
  save(
    sessionId: string,
    raw: unknown,
    scope: ContextSnapshotScope,
    expectedRevision: number,
    assertCurrent: () => void,
  ): boolean {
    const snapshot = ContextMeasurementSchema.parse(raw);
    if (
      snapshot.identity.sessionId !== sessionId ||
      snapshot.identity.scope !== 'parent' ||
      contextSnapshotScopeKey(snapshot) !== contextSnapshotScopeKey(scope)
    )
      throw Error('Context snapshot scope mismatch');
    return this.owner
      .database()
      .transaction(() => {
        const asserted: unknown = assertCurrent();
        if (asserted !== undefined) throw Error('Synchronous context snapshot authority required');
        if (!this.owner.hasSession(sessionId)) throw Error('Context snapshot session unavailable');
        const previous = this.read(sessionId);
        if (previous.revision !== expectedRevision) return false;
        if (
          previous.snapshot &&
          contextSnapshotScopeKey(previous.snapshot) === contextSnapshotScopeKey(snapshot) &&
          previous.snapshot.observedAt >= snapshot.observedAt
        )
          return false;
        this.owner
          .database()
          .prepare(
            `INSERT INTO context_snapshots(session_id,revision,snapshot,reason)
        VALUES(?,?,?,NULL) ON CONFLICT(session_id) DO UPDATE SET
        revision=excluded.revision,snapshot=excluded.snapshot,reason=NULL`,
          )
          .run(sessionId, previous.revision + 1, JSON.stringify(snapshot));
        return true;
      })
      .immediate();
  }
  invalidate(sessionId: string, reason: ContextSnapshotReason): void {
    ContextSnapshotReasonSchema.parse(reason);
    if (!this.owner.hasSession(sessionId)) return;
    // Also fence pending first observations when there is no retained snapshot yet.
    this.owner
      .database()
      .prepare(
        `INSERT INTO context_snapshots(session_id,revision,reason)
      VALUES(?,1,?) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1,reason=excluded.reason`,
      )
      .run(sessionId, reason);
  }
  /** A durable dispatch claim prevents repeating an uncertain full/token-count request after restart. */
  claim(
    sessionId: string,
    requestId: string,
    fingerprint: string,
  ): 'claimed' | 'duplicate' | 'conflict' {
    if (!this.owner.hasSession(sessionId)) throw Error('Context snapshot session unavailable');
    const db = this.owner.database();
    return db
      .transaction(() => {
        const row = db
          .prepare(
            'SELECT fingerprint FROM context_snapshot_requests WHERE session_id=? AND request_id=?',
          )
          .get(sessionId, requestId) as { fingerprint: string } | undefined;
        if (row) return row.fingerprint === fingerprint ? 'duplicate' : 'conflict';
        db.prepare('INSERT INTO context_snapshot_requests VALUES(?,?,?)').run(
          sessionId,
          requestId,
          fingerprint,
        );
        return 'claimed';
      })
      .immediate();
  }
}
