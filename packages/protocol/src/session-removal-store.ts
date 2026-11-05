import type Database from 'better-sqlite3';

export type SessionRemovalPhase = 'closing' | 'releasing' | 'completed' | 'failed';
export interface SessionRemovalRecord {
  sessionId: string;
  operationId: string;
  fingerprint: string;
  phase: SessionRemovalPhase;
  error: string | null;
  updatedAt: number;
  releaseStarted: boolean;
  preparationCompleted: boolean;
}

/** Shares the event database and its admission transactions. A failed or
 * interrupted removal remains fenced; absence of a process never clears it. */
export class SessionRemovalStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS session_resource_removals (
      session_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE,
      fingerprint TEXT NOT NULL, phase TEXT NOT NULL, error TEXT, updated_at INTEGER NOT NULL
    )`);
    if (
      !(
        db.prepare('PRAGMA table_info(session_resource_removals)').all() as Array<{ name: string }>
      ).some((column) => column.name === 'release_started')
    )
      db.exec(
        'ALTER TABLE session_resource_removals ADD COLUMN release_started INTEGER NOT NULL DEFAULT 0',
      );
    if (
      !(
        db.prepare('PRAGMA table_info(session_resource_removals)').all() as Array<{ name: string }>
      ).some((column) => column.name === 'preparation_completed')
    )
      db.exec(
        'ALTER TABLE session_resource_removals ADD COLUMN preparation_completed INTEGER NOT NULL DEFAULT 0',
      );
  }
  read(sessionId: string): SessionRemovalRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT session_id AS sessionId, operation_id AS operationId,
      fingerprint, phase, error, updated_at AS updatedAt, release_started AS releaseStarted,
      preparation_completed AS preparationCompleted
      FROM session_resource_removals WHERE session_id=?`,
      )
      .get(sessionId) as
      | (Omit<SessionRemovalRecord, 'releaseStarted' | 'preparationCompleted'> & {
          releaseStarted: number;
          preparationCompleted: number;
        })
      | undefined;
    return (
      row && {
        ...row,
        releaseStarted: row.releaseStarted === 1,
        preparationCompleted: row.preparationCompleted === 1,
      }
    );
  }
  assertAdmissible(sessionId: string): void {
    if (this.read(sessionId))
      throw Error('This chat is being removed. Review its removal before starting more work.');
  }
  assertArchivable(sessionId?: string): void {
    if (
      this.db
        .prepare(
          `SELECT 1 FROM session_resource_removals
       WHERE release_started=1 AND phase!='completed' ${sessionId === undefined ? '' : 'AND session_id=?'} LIMIT 1`,
        )
        .get(...(sessionId === undefined ? [] : [sessionId]))
    )
      throw Error('Resource release has started. Review its outcome before archiving.');
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
          .prepare(
            'INSERT INTO session_resource_removals(session_id,operation_id,fingerprint,phase,error,updated_at) VALUES(?,?,?,?,?,?)',
          )
          .run(sessionId, operationId, fingerprint, 'closing', null, Date.now());
        return this.read(sessionId)!;
      })
      .immediate();
  }
  markPrepared(sessionId: string, operationId: string): SessionRemovalRecord {
    if (
      this.db
        .prepare(
          `UPDATE session_resource_removals SET preparation_completed=1,updated_at=?
         WHERE session_id=? AND operation_id=? AND phase='closing' AND release_started=0`,
        )
        .run(Date.now(), sessionId, operationId).changes !== 1
    )
      throw Error('Removal preparation changed. Review before retrying.');
    return this.read(sessionId)!;
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
          `UPDATE session_resource_removals SET phase=?,error=?,updated_at=?,release_started=MAX(release_started,?)
      WHERE session_id=? AND operation_id=? AND phase=?
        AND (? != 'releasing' OR preparation_completed=1)`,
        )
        .run(
          phase,
          error,
          Date.now(),
          phase === 'releasing' ? 1 : 0,
          sessionId,
          operationId,
          expected,
          phase,
        ).changes !== 1
    )
      throw Error('Removal operation changed. Review before retrying.');
    return this.read(sessionId)!;
  }
  keep(sessionId: string, operationId: string) {
    if (
      this.db
        .prepare(
          'DELETE FROM session_resource_removals WHERE session_id=? AND operation_id=? AND release_started=0',
        )
        .run(sessionId, operationId).changes !== 1
    )
      throw Error('Resource release has started. Review the original removal.');
  }
}
