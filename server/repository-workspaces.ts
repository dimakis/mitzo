import { copyRepositoryTaskCheckout } from './repository-task-copy.js';
import {
  snapshotRepositoryTaskCheckout,
  validateRepositoryTaskCheckout,
  type RepositoryTaskCheckout,
} from './repository-task-checkout.js';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  realpathSync,
  lstatSync,
  createReadStream,
  constants,
} from 'node:fs';
import { mkdir, realpath, rm, readdir, lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AccountBinding } from '@mitzo/protocol';
import {
  canonicalRepositorySelection,
  inspectGithubRepositorySource,
  prepareGithubRepositorySource,
  type GithubRepositoryPreview,
} from './github-repository-source.js';

export interface RepositoryWorkspace extends GithubRepositoryPreview {
  id: string;
  connectionId: string;
  connectionRevision: number;
  binding: AccountBinding;
  featureBranch: string;
  state: 'preview' | 'preparing' | 'ready' | 'claiming' | 'claimed' | 'failed' | 'discarded';
  createdAt: number;
  sourceDigest?: string;
  sourceReleased?: boolean;
  conversationId?: string;
  directory?: string;
  sandbox?: boolean;
  taskIdentity?: RepositoryTaskCheckout;
}
export type PublicRepositoryWorkspace = Pick<
  RepositoryWorkspace,
  'id' | 'repository' | 'baseBranch' | 'baseOid' | 'featureBranch' | 'state' | 'conversationId'
>;
export function publicRepositoryWorkspace(value: RepositoryWorkspace): PublicRepositoryWorkspace {
  const { id, repository, baseBranch, baseOid, featureBranch, state } = value;
  return {
    id,
    repository,
    baseBranch,
    baseOid,
    featureBranch,
    state,
    ...(value.state === 'claimed' && value.conversationId
      ? { conversationId: value.conversationId }
      : {}),
  };
}

/** Includes Git config and objects as well as content. Prepared sources are not agent workspaces. */
export async function repositorySourceDigest(directory: string): Promise<string> {
  const hash = createHash('sha256');
  let entries = 0,
    bytes = 0;
  if ((await realpath(directory)) !== directory)
    throw new Error('Repository source identity changed');
  async function walk(path: string, prefix: string) {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name),
        relative = prefix + name;
      const before = await lstat(child);
      if (++entries > 100000 || before.isSymbolicLink())
        throw new Error('Repository source storage is unsupported');
      hash.update(JSON.stringify([relative, before.mode, before.isFile() ? before.size : null]));
      if (before.isDirectory()) await walk(child, relative + '/');
      else if (before.isFile()) {
        bytes += before.size;
        if (bytes > 128 * 1024 * 1024)
          throw new Error('Repository source exceeds supported bounds');
        const file = await open(child, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await file.stat();
          if (
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            opened.size !== before.size ||
            opened.mtimeMs !== before.mtimeMs
          )
            throw new Error('Repository source changed while reading');
          let readBytes = 0;
          for await (const chunk of createReadStream(child, {
            highWaterMark: 64 * 1024,
            fd: file.fd,
            autoClose: false,
          })) {
            readBytes += chunk.length;
            if (readBytes > before.size) throw new Error('Repository source changed while reading');
            hash.update(chunk);
          }
          if (readBytes !== before.size) throw new Error('Repository source changed while reading');
        } finally {
          await file.close();
        }
        const after = await lstat(child);
        if (
          before.ino !== after.ino ||
          before.dev !== after.dev ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs
        )
          throw new Error('Repository source changed while reading');
      } else throw new Error('Repository source storage is unsupported');
    }
  }
  await walk(directory, '');
  return hash.digest('hex');
}

interface Dependencies {
  authorize(
    binding: AccountBinding,
    connectionId: string,
    repository: string,
    signal: AbortSignal,
  ): Promise<{ revision: number; allowedBaseBranches: readonly string[] }>;
  inspect?: typeof inspectGithubRepositorySource;
  prepare?: typeof prepareGithubRepositorySource;
  verify?: (record: RepositoryWorkspace, directory: string) => Promise<void>;
}
/** Durable preparations are bound to the exact selected AI account and GitHub connection revision. */
export class RepositoryWorkspaces {
  private db: Database.Database;
  constructor(
    private directory: string,
    private deps: Dependencies,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (realpathSync(directory) !== directory || !info.isDirectory() || (info.mode & 0o077) !== 0)
      throw new Error('Repository preparation state requires a private canonical directory');
    const database = join(directory, 'workspaces.db');
    this.db = new Database(database);
    chmodSync(database, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS repository_workspaces (id TEXT PRIMARY KEY, record TEXT NOT NULL, conversation_id TEXT UNIQUE)',
    );
  }
  close() {
    this.db.close();
  }
  private save(record: RepositoryWorkspace) {
    this.db
      .prepare(
        'INSERT INTO repository_workspaces (id,record,conversation_id) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record,conversation_id=excluded.conversation_id',
      )
      .run(record.id, JSON.stringify(record), record.conversationId ?? null);
  }
  getForConversation(conversationId: string) {
    const row = this.db
      .prepare('SELECT record FROM repository_workspaces WHERE conversation_id=?')
      .get(conversationId) as { record: string } | undefined;
    if (!row) return undefined;
    const record = JSON.parse(row.record) as RepositoryWorkspace;
    if (record.state !== 'claimed')
      throw new Error(
        'Repository workspace preparation did not complete; preserve its original claim',
      );
    return { ...record, ...(!record.sourceReleased ? { seed: this.source(record) } : {}) };
  }
  async validateHostTask(conversationId: string, directory: string) {
    const record = this.getForConversation(conversationId);
    if (
      !record ||
      record.sandbox ||
      record.directory !== directory ||
      !record.taskIdentity ||
      record.taskIdentity.featureBranch !== record.featureBranch
    )
      throw new Error('Retained repository task claim is unavailable');
    return validateRepositoryTaskCheckout(directory, record.taskIdentity);
  }
  status(id: string, binding: AccountBinding) {
    const record = this.get(id);
    if (!isDeepStrictEqual(record.binding, binding))
      throw new Error('Repository preparation belongs to another account');
    return publicRepositoryWorkspace(record);
  }
  async discard(id: string, binding: AccountBinding) {
    const record = this.get(id);
    if (
      !isDeepStrictEqual(record.binding, binding) ||
      !['preview', 'ready', 'failed', 'discarded'].includes(record.state)
    )
      throw new Error('Only an unused preparation can be discarded');
    record.state = 'discarded';
    this.save(record);
    await rm(join(this.directory, id), { recursive: true, force: true });
  }
  get(id: string): RepositoryWorkspace {
    const row = this.db.prepare('SELECT record FROM repository_workspaces WHERE id=?').get(id) as
      { record: string } | undefined;
    if (!row) throw new Error('Repository preparation unavailable');
    return JSON.parse(row.record) as RepositoryWorkspace;
  }
  private source(record: RepositoryWorkspace) {
    return join(this.directory, record.id, 'mgmt');
  }
  async releaseSource(id: string, binding: AccountBinding, conversationId: string) {
    const record = this.get(id);
    if (
      record.state !== 'claimed' ||
      record.conversationId !== conversationId ||
      !isDeepStrictEqual(record.binding, binding)
    )
      throw new Error('Repository source release requires its settled conversation claim');
    if (record.sourceReleased) return;
    await rm(join(this.directory, id), { recursive: true, force: true });
    record.sourceReleased = true;
    this.save(record);
  }
  async startupSeed(
    id: string,
    binding: AccountBinding,
    conversationId: string,
    signal: AbortSignal,
  ) {
    const record = this.get(id);
    if (
      record.state !== 'claimed' ||
      record.sourceReleased ||
      !record.sandbox ||
      record.conversationId !== conversationId
    )
      throw new Error('Repository sandbox seed claim is unavailable');
    await this.authorize(record, binding, signal);
    if ((await repositorySourceDigest(this.source(record))) !== record.sourceDigest)
      throw new Error('Prepared repository source changed before sandbox upload');
    await this.authorize(record, binding, signal);
    return this.source(record);
  }
  private async authorize(
    record: RepositoryWorkspace,
    binding: AccountBinding,
    signal: AbortSignal,
  ) {
    if (!isDeepStrictEqual(record.binding, binding))
      throw new Error('Repository preparation belongs to another account selection');
    const current = await this.deps.authorize(
      binding,
      record.connectionId,
      record.repository,
      signal,
    );
    if (current.revision !== record.connectionRevision)
      throw new Error('GitHub connection changed; preview the repository again');
    if (!current.allowedBaseBranches.includes(record.baseBranch))
      throw new Error('Base branch is not allowed by the selected GitHub connection');
    signal.throwIfAborted();
  }
  async preview(
    binding: AccountBinding,
    connectionId: string,
    selected: string,
    signal: AbortSignal,
  ) {
    const repository = canonicalRepositorySelection(selected);
    const authorized = await this.deps.authorize(binding, connectionId, repository, signal);
    const preview = await (this.deps.inspect ?? inspectGithubRepositorySource)(repository, signal);
    const record: RepositoryWorkspace = {
      ...preview,
      id: randomUUID(),
      connectionId,
      connectionRevision: authorized.revision,
      binding: structuredClone(binding),
      featureBranch: '',
      state: 'preview',
      createdAt: Date.now(),
    };
    record.featureBranch = `mitzo/repo-${record.id}`;
    await this.authorize(record, binding, signal);
    this.save(record);
    return publicRepositoryWorkspace(record);
  }
  async prepare(id: string, binding: AccountBinding, signal: AbortSignal) {
    const record = this.get(id);
    await this.authorize(record, binding, signal);
    // Check again after asynchronous authorization: another request may have reserved this preview.
    if (this.get(id).state !== 'preview' || Date.now() - record.createdAt > 5 * 60000)
      throw new Error('Preview expired or already used; preview the repository again');
    const retained = this.db.prepare('SELECT record FROM repository_workspaces').all() as Array<{
      record: string;
    }>;
    if (
      retained.filter((row) => {
        const value = JSON.parse(row.record) as RepositoryWorkspace;
        return (
          value.binding.accountId === binding.accountId &&
          ['preparing', 'ready', 'claiming', 'claimed'].includes(value.state) &&
          !value.sourceReleased
        );
      }).length >= 8
    )
      throw new Error('This account already has eight prepared or preparing repositories');
    record.state = 'preparing';
    this.save(record);
    try {
      await mkdir(join(this.directory, id), { mode: 0o700 });
      await (this.deps.prepare ?? prepareGithubRepositorySource)(
        { repository: record.repository, baseBranch: record.baseBranch, baseOid: record.baseOid },
        this.source(record),
        record.featureBranch,
        signal,
      );
      record.sourceDigest = await repositorySourceDigest(this.source(record));
      await this.authorize(record, binding, signal);
      record.state = 'ready';
      this.save(record);
      return publicRepositoryWorkspace(record);
    } catch (error) {
      record.state = 'failed';
      this.save(record);
      await rm(join(this.directory, id), { recursive: true, force: true });
      throw error;
    }
  }
  async claim(
    id: string,
    binding: AccountBinding,
    conversationId: string,
    taskRoot: string,
    sandbox: boolean,
  ) {
    const record = this.get(id);
    const signal = AbortSignal.timeout(30000);
    await this.authorize(record, binding, signal);
    if (record.state === 'claimed') {
      if (record.conversationId !== conversationId || record.sandbox !== sandbox)
        throw new Error('Repository preparation already belongs to another conversation');
      if (record.directory) await this.validateHostTask(conversationId, record.directory);
      await this.authorize(record, binding, signal);
      // Do not verify against the original tree after launch: task edits and commits are expected.
      return { ...record, seed: this.source(record) };
    }
    if (this.get(id).state !== 'ready') throw new Error('Repository preparation is not ready');
    if ((await repositorySourceDigest(this.source(record))) !== record.sourceDigest)
      throw new Error('Prepared repository source changed');
    await this.deps.verify?.(record, this.source(record));
    await this.authorize(record, binding, signal);
    // Reserve ownership before any task copy. A failed copy retains this conversation's identity.
    if (this.get(id).state !== 'ready') throw new Error('Repository preparation already reserved');
    record.state = 'claiming';
    record.conversationId = conversationId;
    record.sandbox = sandbox;
    record.directory = sandbox ? undefined : join(taskRoot, `repo-${record.id}`, 'mgmt');
    this.save(record);
    if (record.directory) {
      if ((await realpath(taskRoot)) !== taskRoot) throw new Error('Task workspace root changed');
      await mkdir(join(taskRoot, `repo-${record.id}`), { mode: 0o700 });
      await copyRepositoryTaskCheckout(this.source(record), record.directory);
      if ((await repositorySourceDigest(record.directory)) !== record.sourceDigest)
        throw new Error('Task repository copy changed');
      record.taskIdentity = await snapshotRepositoryTaskCheckout(
        record.directory,
        record.featureBranch,
      );
    }
    await this.authorize(record, binding, signal);
    record.state = 'claimed';
    this.save(record);
    return { ...record, seed: this.source(record) };
  }
}
