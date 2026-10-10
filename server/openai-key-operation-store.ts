import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { CredentialReference } from './credentials.js';

export interface OpenAIKeyResourceBindings {
  credentialBinding: string | null;
  providerIdBinding: string | null;
  providerNameBinding: string | null;
}
/** Hash lookup coordinates, never credential values; property order cannot change identity. */
export function openAIKeyResourceBindings(account: {
  credentialRef: CredentialReference;
  providerId?: string;
  providerName?: string;
}): OpenAIKeyResourceBindings {
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const ref = account.credentialRef;
  return {
    credentialBinding: hash([ref.provider, ref.service, ref.account]),
    providerIdBinding: account.providerId ? hash(account.providerId) : null,
    providerNameBinding: account.providerName ? hash(account.providerName) : null,
  };
}
export function hasOtherOpenAIKeyResourceOwner(
  db: Database.Database,
  accountId: string,
  resources: OpenAIKeyResourceBindings,
): boolean {
  // Older intent lacks individual coordinates. Preserve it and refuse aliases until reconciled.
  return !!db
    .prepare(
      `SELECT 1 FROM openai_key_operations WHERE accountId != @accountId AND (
    credentialBinding = @credentialBinding OR providerIdBinding = @providerIdBinding OR
    providerNameBinding = @providerNameBinding OR credentialBinding IS NULL OR
    providerIdBinding IS NULL OR providerNameBinding IS NULL
  ) LIMIT 1`,
    )
    .get({ accountId, ...resources });
}

export type KeyOperationPhase =
  'prepared' | 'keychain_written' | 'gateway_started' | 'complete' | 'aborted';
export interface KeyOperation extends OpenAIKeyResourceBindings {
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

/** Intent, nonsecret resource coordinates and acknowledgements only. No key values or their digests. */
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
    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(openai_key_operations)').all() as { name: string }[]).map(
        (column) => column.name,
      ),
    );
    for (const column of ['credentialBinding', 'providerIdBinding', 'providerNameBinding']) {
      if (!columns.has(column))
        this.db.exec(`ALTER TABLE openai_key_operations ADD COLUMN ${column} TEXT`);
    }
  }
  hasOtherResourceOwner(accountId: string, resources: OpenAIKeyResourceBindings): boolean {
    return hasOtherOpenAIKeyResourceOwner(this.db, accountId, resources);
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
  unresolvedLegacyChange(accountId: string, binding: string): KeyOperation | undefined {
    // Failed attempts do not reconcile an earlier credential edit or binding change.
    // Only a later completed replacement receipt clears that history.
    return this.db
      .prepare(
        `SELECT * FROM openai_key_operations WHERE accountId=?
        AND ((phase='aborted' AND errorCode='ACCOUNT_CHANGED') OR binding != ?)
        AND revision > COALESCE((SELECT MAX(revision) FROM openai_key_operations
          WHERE accountId=? AND phase='complete'), 0)
        ORDER BY revision DESC LIMIT 1`,
      )
      .get(accountId, binding, accountId) as KeyOperation | undefined;
  }
  pending(): KeyOperation[] {
    return this.db
      .prepare("SELECT * FROM openai_key_operations WHERE phase NOT IN ('complete','aborted')")
      .all() as KeyOperation[];
  }
  begin(
    input: Pick<
      KeyOperation,
      'accountId' | 'binding' | 'gatewayVersion' | 'keychainBeforeVersion'
    > &
      Partial<OpenAIKeyResourceBindings>,
    supersedeId?: string,
  ): KeyOperation {
    return this.db.transaction(() => {
      const pending = this.pending().find((operation) => operation.accountId === input.accountId);
      if (pending) {
        if (pending.id !== supersedeId || pending.binding !== input.binding)
          throw new Error('Connection changed');
        this.update(pending.id, { phase: 'aborted', errorCode: 'SUPERSEDED' });
      } else if (supersedeId) throw new Error('Connection changed');
      const operation: KeyOperation = {
        credentialBinding: null,
        providerIdBinding: null,
        providerNameBinding: null,
        ...input,
        id: randomUUID(),
        phase: 'prepared',
        errorCode: null,
        verifiedAt: null,
        revision: (this.latest(input.accountId)?.revision ?? 0) + 1,
      };
      this.db
        .prepare(
          `INSERT INTO openai_key_operations
          (id,accountId,binding,phase,gatewayVersion,keychainBeforeVersion,errorCode,verifiedAt,revision,createdAt,credentialBinding,providerIdBinding,providerNameBinding)
          VALUES (@id,@accountId,@binding,@phase,@gatewayVersion,@keychainBeforeVersion,@errorCode,@verifiedAt,@revision,@createdAt,@credentialBinding,@providerIdBinding,@providerNameBinding)`,
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
