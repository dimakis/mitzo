import Database from 'better-sqlite3';
import {
  SessionLaunchConfigSchema,
  SessionLaunchDefaultSaveSchema,
  type SessionLaunchDefaults,
} from '@mitzo/protocol';

/** Same stable operator subject as Agent Library. Login identities authorize
 * access but never become the persistence key for a user's preferences. */
export const SESSION_LAUNCH_OWNER = 'user';
export class SessionLaunchDefaultsConflict extends Error {}

export class SessionLaunchDefaultsStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS session_launch_defaults (
      owner TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      configuration TEXT
    )`);
  }
  get(owner: string): SessionLaunchDefaults {
    return this.read(this.db, owner);
  }
  private read(database: Database.Database, owner: string): SessionLaunchDefaults {
    const row = database
      .prepare('SELECT revision,configuration FROM session_launch_defaults WHERE owner=?')
      .get(owner) as { revision: number; configuration: string | null } | undefined;
    return row
      ? {
          revision: row.revision,
          configuration:
            row.configuration === null
              ? null
              : SessionLaunchConfigSchema.parse(JSON.parse(row.configuration)),
        }
      : { revision: 0, configuration: null };
  }
  save(owner: string, raw: unknown): SessionLaunchDefaults {
    return this.db.transaction(() => this.saveInTransaction(owner, raw, this.db)).immediate();
  }
  /** Approval and its optional default save commit through one SQLite writer. */
  saveInTransaction(
    owner: string,
    raw: unknown,
    database: Database.Database,
  ): SessionLaunchDefaults {
    const input = SessionLaunchDefaultSaveSchema.parse(raw);
    if (!owner.trim()) throw Error('Authenticated operator required');
    if (!database.inTransaction) throw Error('An owning approval transaction is required');
    const previous = this.read(database, owner);
    if (previous.revision !== input.expectedRevision)
      throw new SessionLaunchDefaultsConflict(
        'Session defaults changed. Reload them before saving.',
      );
    const revision = previous.revision + 1;
    database
      .prepare(
        `INSERT INTO session_launch_defaults(owner,revision,configuration) VALUES (?,?,?)
        ON CONFLICT(owner) DO UPDATE SET revision=excluded.revision,configuration=excluded.configuration`,
      )
      .run(
        owner,
        revision,
        input.configuration === null ? null : JSON.stringify(input.configuration),
      );
    return { revision, configuration: input.configuration };
  }
  close() {
    this.db.close();
  }
}
