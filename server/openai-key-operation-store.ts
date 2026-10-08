import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export type KeyOperationPhase =
  'prepared' | 'keychain_written' | 'gateway_started' | 'complete' | 'aborted';
export interface KeyOperation {
  id: string;
  accountId: string;
  binding: string;
  phase: KeyOperationPhase;
  gatewayVersion: string;
  keychainBeforeVersion: string | null;
  errorCode: string | null;
  verifiedAt: number | null;
  revision: number;
}

/** Intent and acknowledgements only. Credential values and digests never enter SQLite. */
export class OpenAIKeyOperationStore {
  private db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS openai_key_operations (
      id TEXT PRIMARY KEY, accountId TEXT NOT NULL, binding TEXT NOT NULL,
      phase TEXT NOT NULL, gatewayVersion TEXT NOT NULL,
      keychainBeforeVersion TEXT, errorCode TEXT, verifiedAt INTEGER,
      revision INTEGER NOT NULL, createdAt INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS openai_key_pending
      ON openai_key_operations(accountId) WHERE phase NOT IN ('complete','aborted');`);
  }
  latest(accountId: string): KeyOperation | undefined {
    return this.db
      .prepare(
        'SELECT * FROM openai_key_operations WHERE accountId=? ORDER BY revision DESC LIMIT 1',
      )
      .get(accountId) as KeyOperation | undefined;
  }
  completed(accountId: string): KeyOperation | undefined {
    return this.db
      .prepare(
        "SELECT * FROM openai_key_operations WHERE accountId=? AND phase='complete' ORDER BY revision DESC LIMIT 1",
      )
      .get(accountId) as KeyOperation | undefined;
  }
  pending(): KeyOperation[] {
    return this.db
      .prepare("SELECT * FROM openai_key_operations WHERE phase NOT IN ('complete','aborted')")
      .all() as KeyOperation[];
  }
  begin(
    input: Pick<KeyOperation, 'accountId' | 'binding' | 'gatewayVersion' | 'keychainBeforeVersion'>,
  ): KeyOperation {
    return this.db.transaction(() => {
      const operation: KeyOperation = {
        ...input,
        id: randomUUID(),
        phase: 'prepared',
        errorCode: null,
        verifiedAt: null,
        revision: (this.latest(input.accountId)?.revision ?? 0) + 1,
      };
      this.db
        .prepare(
          'INSERT INTO openai_key_operations VALUES (@id,@accountId,@binding,@phase,@gatewayVersion,@keychainBeforeVersion,@errorCode,@verifiedAt,@revision,@createdAt)',
        )
        .run({ ...operation, createdAt: Date.now() });
      return operation;
    })();
  }
  update(
    id: string,
    fields: Partial<Pick<KeyOperation, 'phase' | 'gatewayVersion' | 'errorCode' | 'verifiedAt'>>,
  ) {
    const allowed = ['phase', 'gatewayVersion', 'errorCode', 'verifiedAt'];
    const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
    if (!entries.length) return;
    this.db
      .prepare(
        `UPDATE openai_key_operations SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`,
      )
      .run(...entries.map(([, value]) => value), id);
  }
  close() {
    this.db.close();
  }
}
