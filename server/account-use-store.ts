import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AccountBinding } from '@mitzo/protocol';

export interface SuccessfulAccountUse {
  model: string;
  succeededAt: number;
}
type Route = Pick<AccountBinding, 'accountId' | 'provider' | 'profileRevision'>;

/** Historical evidence only. Contains no prompts, credentials or account emails. */
export class AccountUseStore {
  private db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS account_use (
      account_id TEXT NOT NULL, provider TEXT NOT NULL, profile_revision TEXT NOT NULL,
      model TEXT NOT NULL, succeeded_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, provider, profile_revision, model))`);
  }
  record(binding: AccountBinding, succeededAt = Date.now()): void {
    if (!Number.isSafeInteger(succeededAt) || succeededAt < 0)
      throw new Error('Invalid use timestamp');
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO account_use VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account_id, provider, profile_revision, model)
        DO UPDATE SET succeeded_at=MAX(succeeded_at, excluded.succeeded_at)`,
        )
        .run(
          binding.accountId,
          binding.provider,
          binding.profileRevision,
          binding.model,
          succeededAt,
        );
      this.db.exec(`DELETE FROM account_use WHERE rowid IN (
        SELECT rowid FROM account_use ORDER BY succeeded_at DESC, rowid DESC LIMIT -1 OFFSET 1000)`);
    })();
  }
  latest(route: Route, allowedModels: readonly string[]): SuccessfulAccountUse | undefined {
    const rows = this.db
      .prepare(
        `SELECT model, succeeded_at FROM account_use
      WHERE account_id=? AND provider=? AND profile_revision=? ORDER BY succeeded_at DESC`,
      )
      .all(route.accountId, route.provider, route.profileRevision) as Array<{
      model: string;
      succeeded_at: number;
    }>;
    const row = rows.find((row) => allowedModels.includes(row.model));
    return row && { model: row.model, succeededAt: row.succeeded_at };
  }
  close(): void {
    this.db.close();
  }
}

let current: { path: string; store: AccountUseStore } | undefined;
export function getAccountUseStore(): AccountUseStore {
  const directory = resolve(process.env.REPO_PATH || '.', '.mitzo');
  const path = join(directory, 'account-use.db');
  if (current?.path !== path) {
    current?.store.close();
    mkdirSync(directory, { recursive: true });
    current = { path, store: new AccountUseStore(path) };
  }
  return current.store;
}
