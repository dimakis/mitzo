import type Database from 'better-sqlite3';
import type { AuthSession } from './interactive-auth-core.js';
/** Durable login leases; neither JWTs nor credentials are retained. */
export class TerminalOwnerStore {
  constructor(private db: Database.Database) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS operator_terminal_owners (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)',
    );
  }
  read(id: string) {
    return this.db
      .prepare(
        'SELECT id, expires_at AS expiresAt, revoked FROM operator_terminal_owners WHERE id=?',
      )
      .get(id) as (AuthSession & { revoked: number }) | undefined;
  }
  bind(session: AuthSession) {
    if (!Number.isSafeInteger(session.expiresAt) || session.expiresAt <= Date.now())
      throw Error('Operator session expired');
    this.db
      .prepare('INSERT OR IGNORE INTO operator_terminal_owners (id,expires_at) VALUES (?,?)')
      .run(session.id, session.expiresAt);
    const saved = this.read(session.id)!;
    if (saved.revoked || saved.expiresAt !== session.expiresAt)
      throw Error('Operator session unavailable');
  }
  retire(id: string) {
    this.db
      .prepare(
        'INSERT INTO operator_terminal_owners (id,expires_at,revoked) VALUES (?,0,1) ON CONFLICT(id) DO UPDATE SET revoked=1',
      )
      .run(id);
  }
  runningOwners() {
    return this.db
      .prepare(
        "SELECT DISTINCT o.id,o.expires_at AS expiresAt,o.revoked FROM operator_terminal_owners o JOIN operator_terminals t ON t.owner=o.id WHERE t.state='running'",
      )
      .all() as (AuthSession & { revoked: number })[];
  }
}
