import Database from 'better-sqlite3';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  assertPrivateOperationDirectory,
  publishPrivateOperationFile,
  assertPrivateOperationFile,
} from './private-operation-file.js';

export const ClaudeIdentity = z.strictObject({
  email: z.email(),
  planType: z.enum(['pro', 'max']),
});
export type ClaudeIdentity = z.infer<typeof ClaudeIdentity>;
export const ClaudeLoginInput = z.strictObject({
  requestId: z.uuid(),
  label: z.string().trim().min(1).max(120).default('Personal Claude'),
  accountId: z
    .string()
    .regex(/^claude-[0-9a-f-]{36}$/)
    .optional(),
});
const Attempt = z.strictObject({
  requestId: z.uuid(),
  owner: z.string().min(1),
  label: z.string().min(1).max(120),
  accountId: z.string().regex(/^claude-[0-9a-f-]{36}$/),
  reconnect: z.boolean(),
  state: z.enum([
    'preparing',
    'pending',
    'verifying',
    'connected',
    'cancelled',
    'failed',
    'interrupted',
  ]),
  expiresAt: z.number(),
  errorCode: z.string().nullable(),
  diagnosticId: z.string().nullable(),
  configDev: z.string(),
  configIno: z.string(),
});
export type ClaudeLoginAttempt = z.infer<typeof Attempt>;
const Account = ClaudeIdentity.extend({
  id: z.string().regex(/^claude-[0-9a-f-]{36}$/),
  label: z.string().min(1).max(120),
  verifiedAt: z.number(),
});
export type ManagedClaudeAccount = z.infer<typeof Account>;
export function claudeAccountsDirectory() {
  const root = process.env.MITZO_CLAUDE_ACCOUNTS_DIR || join(homedir(), '.claude-mitzo-accounts');
  if (!isAbsolute(root)) throw Error('Claude account storage must be absolute');
  return root;
}

/** Native credentials/history remain in per-account directories. This journal contains metadata only. */
export class ClaudeAccountStore {
  private db: Database.Database;
  constructor(
    readonly root: string,
    readonlyMode = false,
  ) {
    if (!isAbsolute(root)) throw Error('Claude account storage must be absolute');
    if (!readonlyMode) mkdirSync(root, { mode: 0o700, recursive: true });
    assertPrivateOperationDirectory(root);
    if (realpathSync(root) !== root)
      throw Error('Claude account storage must be a physical directory');
    const path = join(root, 'accounts.db');
    if (!readonlyMode && !existsSync(path)) publishPrivateOperationFile(path, '');
    assertPrivateOperationFile(path);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sidecar = path + suffix;
      if (existsSync(sidecar)) {
        const file = lstatSync(sidecar);
        if (
          !file.isFile() ||
          file.isSymbolicLink() ||
          file.nlink !== 1 ||
          file.uid !== process.getuid?.()
        )
          throw Error('Claude account journal custody changed');
      }
    }
    this.db = new Database(path, { readonly: readonlyMode, fileMustExist: true });
    if (!readonlyMode) {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, metadata TEXT NOT NULL); CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, metadata TEXT NOT NULL)',
      );
    }
  }
  close() {
    this.db.close();
  }
  attempts(): ClaudeLoginAttempt[] {
    return (
      this.db.prepare('SELECT metadata FROM attempts ORDER BY rowid').all() as {
        metadata: string;
      }[]
    ).map((row) => Attempt.parse(JSON.parse(row.metadata)));
  }
  attempt(id: string) {
    const row = this.db.prepare('SELECT metadata FROM attempts WHERE id = ?').get(id) as
      { metadata: string } | undefined;
    return row ? Attempt.parse(JSON.parse(row.metadata)) : undefined;
  }
  pendingAttempts(): ClaudeLoginAttempt[] {
    return (
      this.db
        .prepare(
          "SELECT metadata FROM attempts WHERE json_extract(metadata,'$.state') IN ('preparing','pending','verifying')",
        )
        .all() as { metadata: string }[]
    ).map((row) => Attempt.parse(JSON.parse(row.metadata)));
  }
  recentAttempts(owner: string): ClaudeLoginAttempt[] {
    return (
      this.db
        .prepare(
          "SELECT metadata FROM attempts WHERE json_extract(metadata,'$.owner') = ? ORDER BY rowid DESC LIMIT 20",
        )
        .all(owner) as { metadata: string }[]
    )
      .map((row) => Attempt.parse(JSON.parse(row.metadata)))
      .reverse();
  }
  hasUnconfirmedCleanup() {
    return !!this.db
      .prepare(
        "SELECT 1 FROM attempts WHERE json_extract(metadata,'$.errorCode') IN ('CLAUDE_LOGIN_CHILD_UNCONFIRMED','CLAUDE_LOGIN_CANCELLATION_UNCONFIRMED') LIMIT 1",
      )
      .get();
  }
  accounts(): ManagedClaudeAccount[] {
    return (
      this.db.prepare('SELECT metadata FROM accounts ORDER BY rowid').all() as {
        metadata: string;
      }[]
    ).map((row) => Account.parse(JSON.parse(row.metadata)));
  }
  config(accountId: string) {
    if (!/^claude-[0-9a-f-]{36}$/.test(accountId)) throw Error('Unknown Claude account');
    return join(this.root, accountId);
  }
  assertConfig(attempt: ClaudeLoginAttempt) {
    const config = this.config(attempt.accountId);
    assertPrivateOperationDirectory(config);
    const stat = lstatSync(config);
    if (
      realpathSync(config) !== config ||
      String(stat.dev) !== attempt.configDev ||
      String(stat.ino) !== attempt.configIno
    )
      throw Error('Claude login directory changed');
  }
  reserve(owner: string, expiresAt: number, value: z.input<typeof ClaudeLoginInput>) {
    const input = ClaudeLoginInput.parse(value);
    return this.db.transaction(() => {
      const existing = this.attempt(input.requestId);
      if (existing) {
        if (
          existing.owner !== owner ||
          existing.label !== input.label ||
          (existing.reconnect ? existing.accountId !== input.accountId : !!input.accountId)
        )
          throw Error('Login request changed');
        return existing;
      }
      if (this.pendingAttempts().length)
        throw Error('Finish or cancel the pending Claude sign-in first');
      const account = input.accountId
        ? this.accounts().find((row) => row.id === input.accountId)
        : undefined;
      if (input.accountId && !account) throw Error('Unknown Claude account');
      const accountId = account?.id || 'claude-' + input.requestId;
      const config = this.config(accountId);
      if (!account) mkdirSync(config, { mode: 0o700 });
      assertPrivateOperationDirectory(config);
      const stat = lstatSync(config);
      const attempt = Attempt.parse({
        ...input,
        owner,
        expiresAt,
        accountId,
        reconnect: !!account,
        state: 'preparing',
        configDev: String(stat.dev),
        configIno: String(stat.ino),
        errorCode: null,
        diagnosticId: null,
      });
      this.assertConfig(attempt);
      this.db
        .prepare('INSERT INTO attempts VALUES (?, ?)')
        .run(input.requestId, JSON.stringify(attempt));
      return attempt;
    })();
  }
  update(attempt: ClaudeLoginAttempt) {
    const row = Attempt.parse(attempt);
    this.db
      .prepare('UPDATE attempts SET metadata = ? WHERE id = ?')
      .run(JSON.stringify(row), row.requestId);
  }
  connected(attempt: ClaudeLoginAttempt, identity: ClaudeIdentity) {
    this.assertConfig(attempt);
    const account = Account.parse({
      id: attempt.accountId,
      label: attempt.label,
      ...identity,
      verifiedAt: Date.now(),
    });
    this.db.transaction(() => {
      const previous = this.accounts().find((row) => row.id === account.id);
      if (
        previous &&
        (previous.email.toLowerCase() !== account.email.toLowerCase() ||
          previous.planType !== account.planType)
      )
        throw Error('Sign in with the original Claude account and plan');
      this.db
        .prepare('INSERT OR REPLACE INTO accounts VALUES (?, ?)')
        .run(account.id, JSON.stringify(account));
      this.update({ ...attempt, state: 'connected' });
    })();
  }
}

/** Read-only projection merged with operator profiles, without rewriting their configuration. */
export function readManagedClaudeProfiles(root = claudeAccountsDirectory()) {
  if (!existsSync(root)) return [];
  const store = new ClaudeAccountStore(root, true);
  try {
    return store.accounts().map((account) => ({
      id: account.id,
      label: account.label,
      provider: 'anthropic-claude' as const,
      credentialRef: store.config(account.id),
      email: account.email,
      planType: account.planType,
      // Native aliases follow the subscription's current model mapping. Selection is not proof of entitlement.
      models: [
        { id: 'sonnet', label: 'Claude Sonnet' },
        { id: 'opus', label: 'Claude Opus' },
        { id: 'haiku', label: 'Claude Haiku' },
      ],
    }));
  } finally {
    store.close();
  }
}
