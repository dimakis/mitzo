import { isGitBranchName } from './git-branch.js';
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
import { join, resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import { AccountBindingSchema } from '@mitzo/protocol';
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
  state:
    | 'preview'
    | 'preparing'
    | 'ready'
    | 'reserved'
    | 'claiming'
    | 'claimed'
    | 'failed'
    | 'discarded';
  hostReservation?: HostTaskReservationMarker;
  createdAt: number;
  sourceDigest?: string;
  sourceReleased?: boolean;
  conversationId?: string;
  directory?: string;
  sandbox?: boolean;
  taskIdentity?: RepositoryTaskCheckout;
  handoff?: { sourceConversationId: string; prompt: string };
}
export interface RepositoryChatPreparation extends PublicRepositoryWorkspace {
  sourceConversationId: string;
  accountId: string;
  model: string;
  prompt: string;
  setupUrl: string;
}
export type PublicRepositoryWorkspace = Omit<
  Pick<
    RepositoryWorkspace,
    'id' | 'repository' | 'baseBranch' | 'baseOid' | 'featureBranch' | 'state' | 'conversationId'
  >,
  'state'
> & { state: Exclude<RepositoryWorkspace['state'], 'reserved'> };
export function publicRepositoryWorkspace(
  value: Pick<
    RepositoryWorkspace,
    'id' | 'repository' | 'baseBranch' | 'baseOid' | 'featureBranch' | 'state' | 'conversationId'
  >,
): PublicRepositoryWorkspace {
  const { id, repository, baseBranch, baseOid, featureBranch, state } = value;
  return {
    id,
    repository,
    baseBranch,
    baseOid,
    featureBranch,
    state: state === 'reserved' ? 'claiming' : state,
    ...(value.state === 'claimed' && value.conversationId
      ? { conversationId: value.conversationId }
      : {}),
  };
}

class HostWorkspaceOwnershipChangedError extends Error {}

const reservationReference = z.string().min(1).max(200).regex(/^\S+$/);
const canonicalPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => isAbsolute(path) && resolve(path) === path, 'Canonical absolute path required');
const rootIdentitySchema = z.strictObject({
  dev: z.number().int().nonnegative().safe(),
  ino: z.number().int().nonnegative().safe(),
});
const hostTaskReservationMarkerSchema = z.strictObject({
  version: z.literal(1),
  taskRoot: canonicalPath,
  rootIdentity: rootIdentitySchema,
});
export type HostTaskReservationMarker = z.infer<typeof hostTaskReservationMarkerSchema>;
const hostRepositoryReservationSchema = z.strictObject({
  id: z.string().uuid(),
  connectionId: reservationReference,
  connectionRevision: z.number().int().nonnegative(),
  binding: AccountBindingSchema,
  repository: reservationReference,
  baseBranch: z.string().min(1).max(1024).refine(isGitBranchName),
  baseOid: z.string().regex(/^[a-f0-9]{40}$/),
  featureBranch: reservationReference,
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  conversationId: reservationReference,
  directory: canonicalPath,
  sandbox: z.literal(false),
  state: z.enum(['reserved', 'claiming', 'claimed']),
  hostReservation: hostTaskReservationMarkerSchema,
});
/** Routing/ownership reservation metadata only; this is not a ready checkout receipt. */
export type HostRepositoryReservation = z.infer<typeof hostRepositoryReservationSchema>;
export interface HostRepositoryReservationInput {
  id: string;
  binding: AccountBinding;
  conversationId: string;
  taskRoot: string;
  signal: AbortSignal;
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
  private pendingChats = new Map<
    string,
    { key: string; result: Promise<RepositoryChatPreparation> }
  >();
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
  private chatRecords(sourceConversationId: string): RepositoryWorkspace[] {
    return (
      this.db
        .prepare(
          "SELECT record FROM repository_workspaces WHERE json_extract(record,'$.handoff.sourceConversationId')=? ORDER BY json_extract(record,'$.createdAt') DESC, rowid DESC",
        )
        .all(sourceConversationId) as Array<{ record: string }>
    ).map((row) => JSON.parse(row.record) as RepositoryWorkspace);
  }
  chatPreparation(
    id: string | undefined,
    binding: AccountBinding,
    sourceConversationId?: string,
  ): RepositoryChatPreparation {
    // An owned status read may recover a draft prepared under an earlier model.
    // Account/provider/profile identity stays fixed; launching still requires the stored full binding.
    const sameOwner = (value: RepositoryWorkspace) =>
      isDeepStrictEqual(value.binding, binding) ||
      (sourceConversationId !== undefined &&
        isDeepStrictEqual({ ...value.binding, model: binding.model }, binding));
    const record = id
      ? this.get(id)
      : sourceConversationId
        ? this.chatRecords(sourceConversationId).find(sameOwner)
        : undefined;
    if (
      !record?.handoff ||
      !sameOwner(record) ||
      (sourceConversationId !== undefined &&
        record.handoff.sourceConversationId !== sourceConversationId)
    )
      throw new Error('Repository chat preparation unavailable for this chat and account');
    return {
      ...publicRepositoryWorkspace(record),
      sourceConversationId: record.handoff.sourceConversationId,
      accountId: record.binding.accountId,
      model: record.binding.model,
      prompt: record.handoff.prompt,
      setupUrl: `/chat?repositoryPreparation=${record.id}`,
    };
  }
  prepareChat(
    binding: AccountBinding,
    sourceConversationId: string,
    connectionId: string,
    selected: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<RepositoryChatPreparation> {
    const repository = canonicalRepositorySelection(selected);
    const key = JSON.stringify([binding, connectionId, repository, prompt]);
    const pending = this.pendingChats.get(sourceConversationId);
    if (pending) {
      if (pending.key !== key)
        return Promise.reject(
          new Error(
            'A repository preparation is already running; inspect the original preparation before starting another task',
          ),
        );
      return pending.result;
    }
    const result = (async () => {
      signal.throwIfAborted();
      const records = this.chatRecords(sourceConversationId).filter(
        (value) => value.state !== 'discarded',
      );
      const matches = (value: RepositoryWorkspace) =>
        isDeepStrictEqual(value.binding, binding) &&
        value.connectionId === connectionId &&
        value.repository === repository &&
        value.handoff?.prompt === prompt;
      const current = records.find((value) => value.state !== 'claimed');
      if (current && !matches(current)) {
        if (['preparing', 'reserved', 'claiming'].includes(current.state))
          throw new Error(
            'A repository preparation is running or interrupted; inspect the original preparation before starting another task',
          );
        throw new Error('Discard the previous preparation before choosing a different task');
      }
      // A current unused draft owns the handoff slot before claimed history is considered.
      const previous = current ?? records.find(matches);
      if (previous) {
        await this.authorize(previous, binding, signal);
        return this.chatPreparation(previous.id, binding, sourceConversationId);
      }
      const preview = await this.preview(binding, connectionId, repository, signal);
      const record = this.get(preview.id);
      if (record.state !== 'preview') throw new Error('Repository chat preview ownership changed');
      const originalRecord = JSON.stringify(record);
      record.handoff = { sourceConversationId, prompt };
      this.db
        .transaction(() => {
          const changed = this.db
            .prepare(
              'UPDATE repository_workspaces SET record=? WHERE id=? AND record=? AND conversation_id IS NULL',
            )
            .run(JSON.stringify(record), record.id, originalRecord);
          if (changed.changes !== 1) throw new Error('Repository chat preview ownership changed');
        })
        .immediate();
      try {
        await this.prepare(record.id, binding, signal);
      } catch {
        // Acquisition failures retain an addressable failed draft. Never acquire a replacement implicitly.
        // Binding and live-session checks remain the caller's fence before returning this public receipt.
      }
      return this.chatPreparation(record.id, binding, sourceConversationId);
    })().finally(() => {
      if (this.pendingChats.get(sourceConversationId)?.result === result)
        this.pendingChats.delete(sourceConversationId);
    });
    this.pendingChats.set(sourceConversationId, { key, result });
    return result;
  }
  async discard(id: string, binding: AccountBinding) {
    const record = this.get(id);
    if (
      !isDeepStrictEqual(record.binding, binding) ||
      !['preview', 'ready', 'failed', 'discarded'].includes(record.state)
    )
      throw new Error('Only an unused preparation can be discarded');
    const originalRecord = JSON.stringify(record);
    record.state = 'discarded';
    this.db
      .transaction(() => {
        const changed = this.db
          .prepare('UPDATE repository_workspaces SET record=? WHERE id=? AND record=?')
          .run(JSON.stringify(record), id, originalRecord);
        if (changed.changes !== 1)
          throw new Error('Repository preparation ownership changed before discard');
      })
      .immediate();
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
    const originalRecord = JSON.stringify(record);
    await this.authorize(record, binding, signal);
    // Reserve the exact preview before effects. A losing preparer must never
    // enter acquisition cleanup for a source another owner has already reserved.
    if (record.state !== 'preview' || Date.now() - record.createdAt > 5 * 60000)
      throw new Error('Preview expired or already used; preview the repository again');
    record.state = 'preparing';
    const preparingRecord = JSON.stringify(record);
    this.db
      .transaction(() => {
        const retained = this.db
          .prepare('SELECT record FROM repository_workspaces')
          .all() as Array<{ record: string }>;
        if (
          retained.filter((row) => {
            const value = JSON.parse(row.record) as RepositoryWorkspace;
            return (
              value.binding.accountId === binding.accountId &&
              ['preparing', 'ready', 'reserved', 'claiming', 'claimed'].includes(value.state) &&
              !value.sourceReleased
            );
          }).length >= 8
        )
          throw new Error('This account already has eight prepared or preparing repositories');
        const changed = this.db
          .prepare(
            'UPDATE repository_workspaces SET record=? WHERE id=? AND record=? AND conversation_id IS NULL',
          )
          .run(preparingRecord, id, originalRecord);
        if (changed.changes !== 1)
          throw new Error('Preview expired or already used; preview the repository again');
      })
      .immediate();
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
      this.db
        .transaction(() => {
          const changed = this.db
            .prepare(
              'UPDATE repository_workspaces SET record=? WHERE id=? AND record=? AND conversation_id IS NULL',
            )
            .run(JSON.stringify(record), id, preparingRecord);
          if (changed.changes !== 1)
            throw new Error('Repository preparation ownership changed before completion');
        })
        .immediate();
      return publicRepositoryWorkspace(record);
    } catch (error) {
      record.state = 'failed';
      const ownsFailure = this.db
        .transaction(() => {
          return (
            this.db
              .prepare(
                'UPDATE repository_workspaces SET record=? WHERE id=? AND record=? AND conversation_id IS NULL',
              )
              .run(JSON.stringify(record), id, preparingRecord).changes === 1
          );
        })
        .immediate();
      if (ownsFailure) await rm(join(this.directory, id), { recursive: true, force: true });
      throw error;
    }
  }
  private snapshotHostInput(input: Omit<HostRepositoryReservationInput, 'signal'>) {
    const snapshot = structuredClone({
      id: input.id,
      binding: input.binding,
      conversationId: input.conversationId,
      taskRoot: input.taskRoot,
    });
    z.string().uuid().parse(snapshot.id);
    reservationReference.parse(snapshot.conversationId);
    canonicalPath.parse(snapshot.taskRoot);
    AccountBindingSchema.parse(snapshot.binding);
    return snapshot;
  }
  private reservationDescriptor(record: RepositoryWorkspace): HostRepositoryReservation {
    const {
      id,
      connectionId,
      connectionRevision,
      binding,
      repository,
      baseBranch,
      baseOid,
      featureBranch,
      sourceDigest,
      conversationId,
      directory,
      sandbox,
      state,
      hostReservation,
    } = record;
    const descriptor = hostRepositoryReservationSchema.parse({
      id,
      connectionId,
      connectionRevision,
      binding,
      repository,
      baseBranch,
      baseOid,
      featureBranch,
      sourceDigest,
      conversationId,
      directory,
      sandbox,
      state,
      hostReservation,
    });
    if (
      descriptor.directory !==
        join(descriptor.hostReservation.taskRoot, `repo-${descriptor.id}`, 'mgmt') ||
      descriptor.featureBranch !== `mitzo/repo-${descriptor.id}` ||
      canonicalRepositorySelection(descriptor.repository) !== descriptor.repository ||
      (descriptor.state !== 'claimed' &&
        (record.taskIdentity !== undefined || record.sourceReleased))
    )
      throw new Error('Host repository reservation identity changed');
    return descriptor;
  }
  private getHostRecord(id: string): RepositoryWorkspace {
    const row = this.db
      .prepare('SELECT record, conversation_id FROM repository_workspaces WHERE id=?')
      .get(id) as { record: string; conversation_id: string | null } | undefined;
    if (!row) throw new Error('Host repository reservation unavailable');
    const parsed: unknown = JSON.parse(row.record);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Host repository ledger record is invalid');
    const record = parsed as RepositoryWorkspace;
    if (record.id !== id || row.conversation_id !== (record.conversationId ?? null))
      throw new Error('Host repository ledger identity changed');
    return record;
  }
  getHostReservation(
    input: Omit<HostRepositoryReservationInput, 'signal'>,
  ): HostRepositoryReservation {
    const expected = this.snapshotHostInput(input);
    const descriptor = this.reservationDescriptor(this.getHostRecord(expected.id));
    if (
      descriptor.id !== expected.id ||
      descriptor.conversationId !== expected.conversationId ||
      descriptor.hostReservation.taskRoot !== expected.taskRoot ||
      !isDeepStrictEqual(descriptor.binding, expected.binding)
    )
      throw new Error('Host repository reservation belongs to another selection');
    return descriptor;
  }
  private assertUnchangedHostRecord(expected: RepositoryWorkspace): void {
    if (!isDeepStrictEqual(this.getHostRecord(expected.id), expected))
      throw new HostWorkspaceOwnershipChangedError(
        'Host repository ownership changed during authorization',
      );
  }
  private async hostRootIdentity(taskRoot: string) {
    const info = await lstat(taskRoot);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(taskRoot)) !== taskRoot)
      throw new Error('Task workspace root changed');
    return rootIdentitySchema.parse({ dev: info.dev, ino: info.ino });
  }
  private async assertHostRoot(marker: HostTaskReservationMarker) {
    if (!isDeepStrictEqual(await this.hostRootIdentity(marker.taskRoot), marker.rootIdentity))
      throw new Error('Task workspace root identity changed');
  }
  private async authorizeHostRecord(
    record: RepositoryWorkspace,
    binding: AccountBinding,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    await this.authorize(record, structuredClone(binding), signal);
    this.assertUnchangedHostRecord(record);
  }
  private async assertHostSource(record: RepositoryWorkspace, signal: AbortSignal) {
    signal.throwIfAborted();
    if ((await repositorySourceDigest(this.source(record))) !== record.sourceDigest)
      throw new Error('Prepared repository source changed');
    signal.throwIfAborted();
    this.assertUnchangedHostRecord(record);
  }
  private async verifyHostSource(record: RepositoryWorkspace, signal: AbortSignal) {
    await this.assertHostSource(record, signal);
    await this.deps.verify?.(structuredClone(record), this.source(record));
    signal.throwIfAborted();
    this.assertUnchangedHostRecord(record);
    await this.assertHostSource(record, signal);
  }
  /** Pins host identity in the existing SQLite row, without creating destination files. */
  async reserveHostTask(input: HostRepositoryReservationInput): Promise<HostRepositoryReservation> {
    const expected = this.snapshotHostInput(input),
      signal = input.signal;
    signal.throwIfAborted();
    const record = this.getHostRecord(expected.id);
    if (record.state !== 'ready') {
      const descriptor = this.getHostReservation(expected);
      await this.authorizeHostRecord(record, expected.binding, signal);
      if (descriptor.state !== 'claimed') await this.verifyHostSource(record, signal);
      await this.assertHostRoot(descriptor.hostReservation);
      signal.throwIfAborted();
      this.assertUnchangedHostRecord(record);
      return this.getHostReservation(expected);
    }
    if (
      record.hostReservation !== undefined ||
      record.conversationId !== undefined ||
      record.directory !== undefined ||
      record.sandbox !== undefined ||
      record.taskIdentity !== undefined ||
      record.sourceReleased
    )
      throw new Error('Prepared repository already reserved');
    const marker: HostTaskReservationMarker = {
      version: 1,
      taskRoot: expected.taskRoot,
      rootIdentity: await this.hostRootIdentity(expected.taskRoot),
    };
    signal.throwIfAborted();
    const reserved: RepositoryWorkspace = {
      ...record,
      state: 'reserved',
      conversationId: expected.conversationId,
      directory: join(expected.taskRoot, `repo-${record.id}`, 'mgmt'),
      sandbox: false,
      hostReservation: marker,
    };
    this.reservationDescriptor(reserved);
    try {
      await this.authorizeHostRecord(record, expected.binding, signal);
      await this.verifyHostSource(record, signal);
      await this.authorizeHostRecord(record, expected.binding, signal);
      await this.assertHostSource(record, signal);
      await this.assertHostRoot(marker);
      signal.throwIfAborted();
      return this.db
        .transaction(() => {
          this.assertUnchangedHostRecord(record);
          const result = this.db
            .prepare(
              'UPDATE repository_workspaces SET record=?,conversation_id=? WHERE id=? AND record=? AND conversation_id IS NULL',
            )
            .run(
              JSON.stringify(reserved),
              expected.conversationId,
              expected.id,
              JSON.stringify(record),
            );
          if (result.changes !== 1) throw new Error('Prepared repository reservation changed');
          return this.getHostReservation(expected);
        })
        .immediate();
    } catch (error) {
      // One bounded reconciliation: an exact concurrent reservation can win
      // while source/auth reads await. All other errors and states refuse.
      if (!(error instanceof HostWorkspaceOwnershipChangedError)) throw error;
      const current = this.getHostRecord(expected.id);
      if (current.state !== 'reserved' || !isDeepStrictEqual(current, reserved)) throw error;
      this.getHostReservation(expected);
      await this.authorizeHostRecord(current, expected.binding, signal);
      await this.verifyHostSource(current, signal);
      await this.assertHostRoot(marker);
      signal.throwIfAborted();
      this.assertUnchangedHostRecord(current);
      return this.getHostReservation(expected);
    }
  }
  /** Claim uncertainty before every destination effect; interrupted claims never replay. */
  async claimReservedHostTask(
    input: HostRepositoryReservationInput,
  ): Promise<RepositoryWorkspace & { seed?: string }> {
    const expected = this.snapshotHostInput(input),
      signal = input.signal;
    signal.throwIfAborted();
    const descriptor = this.getHostReservation(expected),
      record = this.getHostRecord(expected.id);
    if (descriptor.state === 'claiming')
      throw new Error('Host task claim is uncertain; preserve its original claim');
    await this.authorizeHostRecord(record, expected.binding, signal);
    await this.assertHostRoot(descriptor.hostReservation);
    this.assertUnchangedHostRecord(record);
    if (descriptor.state === 'claimed') {
      await this.validateHostTask(expected.conversationId, descriptor.directory);
      this.assertUnchangedHostRecord(record);
      await this.authorizeHostRecord(record, expected.binding, signal);
      await this.assertHostRoot(descriptor.hostReservation);
      // Authorization may await arbitrary host callbacks. Revalidate the pinned
      // retained checkout afterward, while allowing task edits and commits.
      await this.validateHostTask(expected.conversationId, descriptor.directory);
      signal.throwIfAborted();
      this.assertUnchangedHostRecord(record);
      return { ...record, ...(!record.sourceReleased ? { seed: this.source(record) } : {}) };
    }
    await this.verifyHostSource(record, signal);
    await this.authorizeHostRecord(record, expected.binding, signal);
    await this.assertHostSource(record, signal);
    await this.assertHostRoot(descriptor.hostReservation);
    signal.throwIfAborted();
    const claiming: RepositoryWorkspace = { ...record, state: 'claiming' };
    this.db
      .transaction(() => {
        this.getHostReservation(expected);
        this.assertUnchangedHostRecord(record);
        const result = this.db
          .prepare(
            'UPDATE repository_workspaces SET record=? WHERE id=? AND record=? AND conversation_id=?',
          )
          .run(
            JSON.stringify(claiming),
            expected.id,
            JSON.stringify(record),
            expected.conversationId,
          );
        if (result.changes !== 1) throw new Error('Host task claim already reserved');
      })
      .immediate();
    await this.assertHostRoot(descriptor.hostReservation);
    this.assertUnchangedHostRecord(claiming);
    signal.throwIfAborted();
    await mkdir(join(expected.taskRoot, `repo-${record.id}`), { mode: 0o700 });
    await this.assertHostRoot(descriptor.hostReservation);
    this.assertUnchangedHostRecord(claiming);
    signal.throwIfAborted();
    await copyRepositoryTaskCheckout(this.source(record), descriptor.directory, signal);
    if ((await repositorySourceDigest(descriptor.directory)) !== record.sourceDigest)
      throw new Error('Task repository copy changed');
    this.assertUnchangedHostRecord(claiming);
    const taskIdentity = await snapshotRepositoryTaskCheckout(
      descriptor.directory,
      record.featureBranch,
    );
    this.assertUnchangedHostRecord(claiming);
    await this.authorizeHostRecord(claiming, expected.binding, signal);
    await this.assertHostRoot(descriptor.hostReservation);
    // Initial readiness requires the exact copied source, unlike later retained
    // retries where legitimate edits are preserved. No callback may replace it.
    if ((await repositorySourceDigest(descriptor.directory)) !== record.sourceDigest)
      throw new Error('Task repository copy changed before claim completion');
    await validateRepositoryTaskCheckout(descriptor.directory, taskIdentity);
    signal.throwIfAborted();
    this.assertUnchangedHostRecord(claiming);
    const claimed: RepositoryWorkspace = { ...claiming, state: 'claimed', taskIdentity };
    this.db
      .transaction(() => {
        this.getHostReservation(expected);
        this.assertUnchangedHostRecord(claiming);
        const result = this.db
          .prepare(
            'UPDATE repository_workspaces SET record=? WHERE id=? AND record=? AND conversation_id=?',
          )
          .run(
            JSON.stringify(claimed),
            expected.id,
            JSON.stringify(claiming),
            expected.conversationId,
          );
        if (result.changes !== 1) throw new Error('Host task claim completion changed');
      })
      .immediate();
    return { ...claimed, seed: this.source(claimed) };
  }
  async claim(
    id: string,
    binding: AccountBinding,
    conversationId: string,
    taskRoot: string,
    sandbox: boolean,
  ) {
    const record = this.get(id);
    if (record.hostReservation !== undefined)
      throw new Error('Host repository reservation requires its owning materialization path');
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
    const originalRecord = JSON.stringify(record);
    record.state = 'claiming';
    record.conversationId = conversationId;
    record.sandbox = sandbox;
    record.directory = sandbox ? undefined : join(taskRoot, `repo-${record.id}`, 'mgmt');
    this.db
      .transaction(() => {
        const changed = this.db
          .prepare(
            'UPDATE repository_workspaces SET record=?,conversation_id=? WHERE id=? AND record=? AND conversation_id IS NULL',
          )
          .run(JSON.stringify(record), conversationId, id, originalRecord);
        if (changed.changes !== 1)
          throw new Error('Repository preparation ownership changed before claim');
      })
      .immediate();
    if (record.directory) {
      if ((await realpath(taskRoot)) !== taskRoot) throw new Error('Task workspace root changed');
      await mkdir(join(taskRoot, `repo-${record.id}`), { mode: 0o700 });
      await copyRepositoryTaskCheckout(this.source(record), record.directory, signal);
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
