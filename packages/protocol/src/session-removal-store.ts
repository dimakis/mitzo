import type Database from 'better-sqlite3';

export type SessionRemovalPhase = 'closing' | 'releasing' | 'completed' | 'failed';
export interface SessionRemovalRecord {
  sessionId: string;
  operationId: string;
  fingerprint: string;
  phase: SessionRemovalPhase;
  error: string | null;
  updatedAt: number;
}

/** Shares the event database and its admission transactions. A failed or
 * interrupted removal remains fenced; absence of a process never clears it. */
export class SessionRemovalStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS session_resource_removals (
      session_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE,
      fingerprint TEXT NOT NULL, phase TEXT NOT NULL, error TEXT, updated_at INTEGER NOT NULL
    )`);
  }
  read(sessionId: string): SessionRemovalRecord | undefined {
    return this.db
      .prepare(
        `SELECT session_id AS sessionId, operation_id AS operationId,
      fingerprint, phase, error, updated_at AS updatedAt
      FROM session_resource_removals WHERE session_id=?`,
      )
      .get(sessionId) as SessionRemovalRecord | undefined;
  }
  assertAdmissible(sessionId: string): void {
    if (this.read(sessionId))
      throw Error('This chat is being removed. Review its removal before starting more work.');
  }
  begin(sessionId: string, operationId: string, fingerprint: string): SessionRemovalRecord {
    if (!sessionId || !operationId || !fingerprint) throw Error('Exact removal identity required');
    return this.db
      .transaction(() => {
        const existing = this.read(sessionId);
        if (existing) {
          if (existing.operationId !== operationId || existing.fingerprint !== fingerprint)
            throw Error('Removal identity changed. Review the original operation.');
          return existing;
        }
        this.db
          .prepare('INSERT INTO session_resource_removals VALUES(?,?,?,?,?,?)')
          .run(sessionId, operationId, fingerprint, 'closing', null, Date.now());
        return this.read(sessionId)!;
      })
      .immediate();
  }
  transition(
    sessionId: string,
    operationId: string,
    expected: SessionRemovalPhase,
    phase: SessionRemovalPhase,
    error: string | null = null,
  ): SessionRemovalRecord {
    const allowed: Record<SessionRemovalPhase, readonly SessionRemovalPhase[]> = {
      closing: ['releasing', 'failed'],
      releasing: ['completed', 'failed'],
      failed: ['closing'],
      completed: [],
    };
    if (!allowed[expected].includes(phase)) throw Error('Invalid removal transition');
    if (
      this.db
        .prepare(
          `UPDATE session_resource_removals SET phase=?,error=?,updated_at=?
      WHERE session_id=? AND operation_id=? AND phase=?`,
        )
        .run(phase, error, Date.now(), sessionId, operationId, expected).changes !== 1
    )
      throw Error('Removal operation changed. Review before retrying.');
    return this.read(sessionId)!;
  }
}
