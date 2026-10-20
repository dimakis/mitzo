import { contextDigest } from './agent-context-compiler.js';
import { OrdinaryWorkspaceCustody } from './ordinary-workspace-custody.js';
import type { EventStore } from './event-store.js';
import { nativeStartupSessionId } from './ordinary-repository-startup.js';
import {
  AgentLibraryVersionSchema,
  OrdinaryOpenShellCommandAdmissionSchema,
  type AgentLibraryVersion,
  type CollaborationSettings,
} from '@mitzo/protocol';
import {
  OrdinaryRepositoryPreparationSchema,
  OrdinarySilentPreparationSelectionSchema,
  ordinaryPreparationFingerprint,
  type OrdinaryRepositoryPreparation,
  type OrdinaryRepositoryRuntimeSelection,
} from './ordinary-repository-preparation.js';
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
import type { SessionRuntimeBindingV2, AccountBinding } from '@mitzo/protocol';
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
  ordinaryPreparation?: OrdinaryRepositoryPreparation;
  ordinaryFirstReservation?: {
    conversationId: string;
    binding: AccountBinding;
    commandFingerprint: string;
  };
  handoff?: { sourceConversationId: string; prompt: string };
  delegation?: {
    sourceConversationId: string;
    sourceWorkspaceId: string;
    settingsFingerprint: string;
  };
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
> & {
  state: Exclude<RepositoryWorkspace['state'], 'reserved'>;
  ordinaryRuntime?: SessionRuntimeBindingV2;
};
export function publicRepositoryWorkspace(
  value: Pick<
    RepositoryWorkspace,
    | 'id'
    | 'repository'
    | 'baseBranch'
    | 'baseOid'
    | 'featureBranch'
    | 'state'
    | 'conversationId'
    | 'ordinaryPreparation'
    | 'ordinaryFirstReservation'
  >,
): PublicRepositoryWorkspace {
  const { id, repository, baseBranch, baseOid, featureBranch, state } = value;
  return {
    id,
    repository,
    baseBranch,
    baseOid,
    featureBranch,
    state:
      state === 'reserved' || (state === 'ready' && value.ordinaryFirstReservation)
        ? 'claiming'
        : state,
    ...(state === 'ready' &&
    value.ordinaryPreparation?.sourceIdentity &&
    !value.ordinaryFirstReservation
      ? { ordinaryRuntime: structuredClone(value.ordinaryPreparation.runtimeBinding) }
      : {}),
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
  runtimeBinding?: SessionRuntimeBindingV2;
  commandFingerprint?: string;
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
  ordinaryPreparation?: {
    capture(
      binding: AccountBinding,
      selection: OrdinaryRepositoryRuntimeSelection,
      signal: AbortSignal,
    ): Promise<OrdinaryRepositoryPreparation>;
    assertSilent?(
      proof: OrdinaryRepositoryPreparation,
      binding: AccountBinding,
      settings: CollaborationSettings,
      signal: AbortSignal,
    ): Promise<void>;
    assert(
      proof: OrdinaryRepositoryPreparation,
      binding: AccountBinding,
      signal: AbortSignal,
      requireModelReadiness?: boolean,
    ): Promise<void>;
  };
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
  private ordinaryWorkspaceCustody?: OrdinaryWorkspaceCustody;
  private activeOperations = 0;
  private released = false;
  private assertAvailable() {
    if (this.released) throw Error('Repository workspace owner released');
  }
  private async runOperation<T>(run: () => Promise<T>): Promise<T> {
    this.assertAvailable();
    this.activeOperations++;
    try {
      return await run();
    } finally {
      this.activeOperations--;
    }
  }
  /** Release only idle persistence. Never cancel work or delete retained sources/tasks. */
  closeIdle(): void {
    if (this.released) return;
    if (this.activeOperations || this.pendingChats.size || this.pendingDelegated.size)
      throw Error('Repository workspace owner active');
    this.close();
    this.released = true;
  }
  private pendingChats = new Map<
    string,
    { key: string; result: Promise<RepositoryChatPreparation> }
  >();
  private pendingDelegated = new Map<
    string,
    { key: string; result: Promise<RepositoryWorkspace> }
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
    this.db.exec(`CREATE TABLE IF NOT EXISTS ordinary_preparation_allocations (
      operation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL);`);
  }
  private ordinaryWorkspaceProvider() {
    this.assertAvailable();
    return (this.ordinaryWorkspaceCustody ??= new OrdinaryWorkspaceCustody(
      this.db,
      this.deps.ordinaryPreparation,
    ));
  }
  prepareOrdinaryWorkspace(input: Parameters<OrdinaryWorkspaceCustody['prepare']>[0]) {
    return this.runOperation(() => this.ordinaryWorkspaceProvider().prepare(input));
  }
  reserveOrdinaryWorkspace(input: Parameters<OrdinaryWorkspaceCustody['reserve']>[0]) {
    return this.runOperation(() => this.ordinaryWorkspaceProvider().reserve(input));
  }
  revalidateOrdinaryWorkspace(input: Parameters<OrdinaryWorkspaceCustody['revalidate']>[0]) {
    return this.runOperation(() => this.ordinaryWorkspaceProvider().revalidate(input));
  }
  claimOrdinaryWorkspace(input: Parameters<OrdinaryWorkspaceCustody['claim']>[0]) {
    return this.runOperation(() => this.ordinaryWorkspaceProvider().claim(input));
  }
  getOrdinaryWorkspace(id: string) {
    return this.ordinaryWorkspaceProvider().get(id);
  }
  getOrdinaryWorkspaceForConversation(conversationId: string) {
    return this.ordinaryWorkspaceProvider().forConversation(conversationId);
  }
  validateOrdinaryWorkspace(conversationId: string, directory: string) {
    return this.ordinaryWorkspaceProvider().validate(conversationId, directory);
  }
  /** Durable application session + real workspace reservation only. Native startup,
   * queues and first-command admission remain entirely with the ordinary owners. */
  async prepareOrdinarySession(
    input: {
      allocationOperationId: string;
      /** Trusted delegation owner marker, never a client selection. */
      delegationAttemptId?: string;
      id: string;
      binding: AccountBinding;
      taskRoot: string;
      settings: CollaborationSettings;
      agentProfile: AgentLibraryVersion;
      /** Required existing OpenShell workdir, resolved by the host route owner. */
      sandboxWorkdir?: string;
      signal: AbortSignal;
    },
    events: EventStore,
  ) {
    return this.runOperation(async () => {
      const selected = structuredClone({ ...input, signal: undefined });
      reservationReference.parse(selected.allocationOperationId);
      const settings = OrdinarySilentPreparationSelectionSchema.parse(selected.settings);
      // Use the ordinary dispatch owner's exact workdir contract before claiming.
      if (settings.binding.execution.location === 'openshell')
        OrdinaryOpenShellCommandAdmissionSchema.shape.workspace.shape.cwd.parse(
          selected.sandboxWorkdir,
        );
      const profile = AgentLibraryVersionSchema.parse(selected.agentProfile);
      if (
        !isDeepStrictEqual(
          {
            profileId: profile.profileId,
            revision: profile.revision,
            ...(profile.kind ? { kind: profile.kind } : {}),
          },
          settings.selection.agent,
        ) ||
        profile.contentHash !== contextDigest(profile.definition)
      )
        throw Error('Original ordinary agent profile required');
      if (
        settings.repositoryWorkspaceId !== selected.id ||
        !selected.allocationOperationId ||
        selected.agentProfile?.definition.contextRecipe !== undefined
      )
        throw Error('Silent ordinary preparation settings unavailable');
      const record = this.get(selected.id);
      if (
        !record.ordinaryPreparation ||
        !isDeepStrictEqual(record.ordinaryPreparation.runtimeBinding, settings.binding) ||
        selected.binding.model !== settings.selection.model
      )
        throw Error('Original ordinary preparation required');
      const conversationId = nativeStartupSessionId(`repository:${selected.id}`);
      const preparationFingerprint = ordinaryPreparationFingerprint({
        allocationOperationId: selected.allocationOperationId,
        ...(selected.delegationAttemptId
          ? { delegationAttemptId: selected.delegationAttemptId }
          : {}),
        id: selected.id,
        binding: selected.binding,
        taskRoot: selected.taskRoot,
        settings,
        agentProfile: selected.agentProfile,
        sandboxWorkdir: selected.sandboxWorkdir,
      });
      const reservation = {
        id: selected.id,
        binding: selected.binding,
        conversationId,
        taskRoot: selected.taskRoot,
        runtimeBinding: settings.binding,
        commandFingerprint: preparationFingerprint,
      };
      // Reuse the reservation owner's pure ID/account/path checks before claiming.
      this.snapshotHostInput(reservation);
      const signal = input.signal;
      signal.throwIfAborted();
      const assertSilent = async (current: RepositoryWorkspace) => {
        await this.assertOrdinaryPreparation(current, selected.binding, signal, true);
        await this.deps.ordinaryPreparation?.assertSilent?.(
          current.ordinaryPreparation!,
          selected.binding,
          settings,
          signal,
        );
        this.assertUnchangedHostRecord(current);
      };
      await assertSilent(record);
      this.db
        .transaction(() => {
          const previous = this.db
            .prepare(
              'SELECT workspace_id, fingerprint FROM ordinary_preparation_allocations WHERE operation_id=?',
            )
            .get(selected.allocationOperationId) as
            { workspace_id: string; fingerprint: string } | undefined;
          if (previous) {
            if (
              previous.workspace_id !== selected.id ||
              previous.fingerprint !== preparationFingerprint
            )
              throw Error('Ordinary allocation operation cannot be replaced');
          } else
            this.db
              .prepare('INSERT INTO ordinary_preparation_allocations VALUES (?,?,?)')
              .run(selected.allocationOperationId, selected.id, preparationFingerprint);
        })
        .immediate();
      let cwd: string;
      if (settings.binding.execution.location === 'local') {
        const descriptor = await this.reserveHostTask({ ...reservation, signal });
        cwd = descriptor.directory;
      } else {
        await this.reserveOrdinarySandboxTask({ ...reservation, signal });
        cwd = selected.sandboxWorkdir!;
      }
      const current = this.getHostRecord(selected.id);
      await this.authorizeHostRecord(current, selected.binding, signal);
      await this.verifyHostSource(current, signal);
      await assertSilent(current);
      signal.throwIfAborted();
      const receipt = events.prepareOrdinarySession(
        {
          sessionId: conversationId,
          repositoryWorkspaceId: selected.id,
          cwd,
          accountBinding: selected.binding,
          agentProfile: selected.agentProfile,
          selectedModel: settings.selection.model,
          reasoningEffort: settings.selection.thinking,
          mode: settings.selection.permission.mode,
        },
        {
          allocationOperationId: selected.allocationOperationId,
          preparationFingerprint,
          settings,
          ...(selected.delegationAttemptId
            ? { delegationAttemptId: selected.delegationAttemptId }
            : {}),
        },
      );
      return { receipt, reservation };
    });
  }
  /** Prepare a new isolated worker from its lead's pinned repository selection.
   * The allocation identity is retained before acquisition; no command is submitted.
   */
  async prepareDelegatedWorkspace(input: {
    allocationOperationId: string;
    sourceConversationId: string;
    settings: CollaborationSettings;
    binding: AccountBinding;
    signal: AbortSignal;
  }): Promise<RepositoryWorkspace> {
    input.signal.throwIfAborted();
    const operationId = input.allocationOperationId;
    const key = ordinaryPreparationFingerprint({ ...input, signal: undefined });
    const pending = this.pendingDelegated.get(operationId);
    if (pending) {
      if (pending.key !== key) throw new Error('Delegated workspace allocation identity conflict');
      return pending.result;
    }
    const result = this.prepareDelegatedWorkspaceOnce(input).finally(() => {
      if (this.pendingDelegated.get(operationId)?.result === result)
        this.pendingDelegated.delete(operationId);
    });
    this.pendingDelegated.set(operationId, { key, result });
    return result;
  }
  private async prepareDelegatedWorkspaceOnce(
    input: Parameters<RepositoryWorkspaces['prepareDelegatedWorkspace']>[0],
  ): Promise<RepositoryWorkspace> {
    const selected = structuredClone({ ...input, signal: undefined });
    const id = z.string().uuid().parse(selected.allocationOperationId);
    const settings = OrdinarySilentPreparationSelectionSchema.parse(selected.settings);
    const binding = AccountBindingSchema.parse(selected.binding);
    const signal = input.signal;
    signal.throwIfAborted();
    const source = this.get(settings.repositoryWorkspaceId);
    if (
      !source ||
      source.id !== settings.repositoryWorkspaceId ||
      source.id === id ||
      !(
        (['reserved', 'claimed'].includes(source.state) &&
          source.conversationId === selected.sourceConversationId) ||
        (source.state === 'ready' &&
          source.conversationId === undefined &&
          source.ordinaryPreparation?.runtimeBinding.execution.location === 'openshell')
      ) ||
      source.ordinaryFirstReservation?.conversationId !== selected.sourceConversationId ||
      !isDeepStrictEqual(source.ordinaryFirstReservation?.binding, source.binding) ||
      !source.ordinaryPreparation ||
      !isDeepStrictEqual(source.ordinaryPreparation.runtimeBinding, settings.binding) ||
      !isDeepStrictEqual({ ...source.binding, model: binding.model }, binding) ||
      binding.model !== settings.selection.model ||
      !isDeepStrictEqual(settings.binding.account, {
        accountId: binding.accountId,
        provider: binding.provider,
        profileRevision: binding.profileRevision,
      })
    )
      throw new Error('Delegated workspace source or selected settings changed');
    const assertSource = () => {
      signal.throwIfAborted();
      if (!isDeepStrictEqual(this.get(source.id), source))
        throw new Error('Delegated workspace source identity changed');
    };
    const authorizeSource = async () => {
      assertSource();
      await this.authorize(source, source.binding, signal);
      assertSource();
    };
    await authorizeSource();
    const delegation = {
      sourceConversationId: selected.sourceConversationId,
      sourceWorkspaceId: source.id,
      settingsFingerprint: ordinaryPreparationFingerprint(settings),
    };
    const assertIdentity = (record: RepositoryWorkspace) => {
      if (
        record.id !== id ||
        record.connectionId !== source.connectionId ||
        record.connectionRevision !== source.connectionRevision ||
        record.repository !== source.repository ||
        record.baseBranch !== source.baseBranch ||
        record.baseOid !== source.baseOid ||
        record.featureBranch !== `mitzo/repo-${id}` ||
        !isDeepStrictEqual(record.binding, binding) ||
        !isDeepStrictEqual(record.delegation, delegation) ||
        !isDeepStrictEqual(record.ordinaryPreparation?.runtimeBinding, settings.binding) ||
        !isDeepStrictEqual(record.ordinaryPreparation?.originalBinding, binding)
      )
        throw new Error('Delegated workspace allocation identity conflict');
    };
    const retained = this.db
      .prepare('SELECT record FROM repository_workspaces WHERE id=?')
      .get(id) as { record: string } | undefined;
    if (!retained) {
      const proof = OrdinaryRepositoryPreparationSchema.parse(
        await this.deps.ordinaryPreparation?.capture(
          binding,
          {
            runOn: settings.binding.execution.location as 'local' | 'openshell',
            runtime: {
              account: settings.binding.account,
              harness: settings.binding.harness.implementation,
              targetId: settings.binding.execution.targetId,
            },
          },
          signal,
        ),
      );
      assertSource();
      await authorizeSource();
      const record: RepositoryWorkspace = {
        id,
        connectionId: source.connectionId,
        connectionRevision: source.connectionRevision,
        binding,
        repository: source.repository,
        baseBranch: source.baseBranch,
        baseOid: source.baseOid,
        featureBranch: `mitzo/repo-${id}`,
        state: 'preview',
        createdAt: Date.now(),
        ordinaryPreparation: proof,
        delegation,
      };
      assertIdentity(record);
      assertSource();
      // Another process may have retained this operation during capture. Never
      // overwrite its record: the exact identity check below owns reconciliation.
      this.db
        .prepare(
          'INSERT INTO repository_workspaces(id,record,conversation_id) VALUES(?,?,NULL) ON CONFLICT(id) DO NOTHING',
        )
        .run(id, JSON.stringify(record));
    }
    let record = this.get(id);
    assertIdentity(record);
    if (!['preview', 'ready', 'reserved', 'claimed'].includes(record.state))
      throw new Error(`Delegated workspace ${record.state}; preserve its original allocation`);
    if (record.state === 'preview') {
      await this.prepare(id, binding, signal);
      assertSource();
      await authorizeSource();
      record = this.get(id);
      assertIdentity(record);
      if (!['ready', 'reserved', 'claimed'].includes(record.state))
        throw new Error('Delegated workspace preparation outcome is uncertain');
    } else {
      await this.authorize(record, binding, signal);
      assertSource();
      this.assertUnchangedHostRecord(record);
      if (record.state === 'ready') {
        await this.verifyHostSource(record, signal);
        assertSource();
        this.assertUnchangedHostRecord(record);
      }
    }
    signal.throwIfAborted();
    return record;
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
    this.assertAvailable();
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
    return this.runOperation(async () => {
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
    });
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
    this.assertAvailable();
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
    this.assertAvailable();
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
    this.activeOperations++;
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
      this.activeOperations--;
    });
    this.pendingChats.set(sourceConversationId, { key, result });
    return result;
  }
  async discard(id: string, binding: AccountBinding) {
    return this.runOperation(async () => {
      const record = this.get(id);
      if (
        record.state === 'ready' &&
        record.ordinaryPreparation &&
        !record.ordinaryFirstReservation
      ) {
        await this.assertOrdinaryPreparation(record, binding, AbortSignal.timeout(30000), true);
        binding = structuredClone(record.binding);
      }
      if (
        record.ordinaryFirstReservation ||
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
    });
  }
  get(id: string): RepositoryWorkspace {
    this.assertAvailable();
    const row = this.db.prepare('SELECT record FROM repository_workspaces WHERE id=?').get(id) as
      { record: string } | undefined;
    if (!row) throw new Error('Repository preparation unavailable');
    return JSON.parse(row.record) as RepositoryWorkspace;
  }
  private source(record: RepositoryWorkspace) {
    return join(this.directory, record.id, 'mgmt');
  }
  async releaseSource(id: string, binding: AccountBinding, conversationId: string) {
    return this.runOperation(async () => {
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
    });
  }
  async startupSeed(
    id: string,
    binding: AccountBinding,
    conversationId: string,
    signal: AbortSignal,
  ) {
    return this.runOperation(async () => {
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
    });
  }
  private async authorize(
    record: RepositoryWorkspace,
    binding: AccountBinding,
    signal: AbortSignal,
  ) {
    if (!isDeepStrictEqual(record.binding, binding))
      throw new Error('Repository preparation belongs to another account selection');
    if (record.ordinaryPreparation) await this.assertOrdinaryPreparation(record, binding, signal);
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
  private async assertOrdinaryPreparation(
    record: RepositoryWorkspace,
    binding: AccountBinding,
    signal: AbortSignal,
    requireModelReadiness = false,
  ) {
    const proof = OrdinaryRepositoryPreparationSchema.parse(record.ordinaryPreparation);
    if (
      ['ready', 'reserved', 'claiming', 'claimed'].includes(record.state) &&
      !proof.sourceIdentity
    )
      throw new Error('Prepared source custody unavailable');
    if (
      !this.deps.ordinaryPreparation ||
      !isDeepStrictEqual(
        { ...proof.originalBinding, accountLabel: binding.accountLabel, model: binding.model },
        binding,
      )
    )
      throw new Error('Ordinary preparation account changed');
    await this.deps.ordinaryPreparation.assert(proof, binding, signal, requireModelReadiness);
    if (proof.sourceIdentity && !record.sourceReleased && record.state !== 'claimed') {
      const info = await lstat(this.source(record));
      if (info.dev !== proof.sourceIdentity.dev || info.ino !== proof.sourceIdentity.ino)
        throw new Error('Prepared source physical identity changed');
    }
    signal.throwIfAborted();
  }
  async qualifiedStatus(id: string, binding: AccountBinding) {
    return this.runOperation(async () => {
      const record = this.get(id);
      if (!isDeepStrictEqual(record.binding, binding)) {
        if (
          record.state !== 'ready' ||
          record.ordinaryFirstReservation ||
          !record.ordinaryPreparation?.sourceIdentity
        )
          throw new Error('Prepared first command is frozen');
        await this.assertOrdinaryPreparation(record, binding, AbortSignal.timeout(30000), true);
      } else if (record.ordinaryPreparation)
        await this.assertOrdinaryPreparation(record, binding, AbortSignal.timeout(30000));
      if (record.state === 'ready' && record.ordinaryPreparation)
        await this.verifyHostSource(record, AbortSignal.timeout(30000));
      this.assertUnchangedHostRecord(record);
      return publicRepositoryWorkspace(record);
    });
  }
  private async firstBinding(
    record: RepositoryWorkspace,
    expected: ReturnType<RepositoryWorkspaces['snapshotHostInput']>,
    signal: AbortSignal,
  ) {
    if (!record.ordinaryPreparation) {
      if (!isDeepStrictEqual(record.binding, expected.binding))
        throw new Error('Repository preparation belongs to another account selection');
      return;
    }
    const proof = OrdinaryRepositoryPreparationSchema.parse(record.ordinaryPreparation);
    if (
      !proof.sourceIdentity ||
      !expected.commandFingerprint ||
      !/^[a-f0-9]{64}$/.test(expected.commandFingerprint) ||
      !expected.runtimeBinding ||
      !isDeepStrictEqual(expected.runtimeBinding, proof.runtimeBinding)
    )
      throw new Error('Prepared runtime target changed');
    await this.assertOrdinaryPreparation(record, expected.binding, signal, true);
    this.assertUnchangedHostRecord(record);
  }
  async preview(
    binding: AccountBinding,
    connectionId: string,
    selected: string,
    signal: AbortSignal,
    ordinaryRuntime?: OrdinaryRepositoryRuntimeSelection,
  ) {
    return this.runOperation(async () => {
      const repository = canonicalRepositorySelection(selected);
      const authorized = await this.deps.authorize(binding, connectionId, repository, signal);
      const preview = await (this.deps.inspect ?? inspectGithubRepositorySource)(
        repository,
        signal,
      );
      const record: RepositoryWorkspace = {
        ...preview,
        id: randomUUID(),
        connectionId,
        connectionRevision: authorized.revision,
        binding: structuredClone(binding),
        featureBranch: '',
        state: 'preview',
        createdAt: Date.now(),
        ...(ordinaryRuntime
          ? {
              ordinaryPreparation: OrdinaryRepositoryPreparationSchema.parse(
                await this.deps.ordinaryPreparation?.capture(binding, ordinaryRuntime, signal),
              ),
            }
          : {}),
      };
      record.featureBranch = `mitzo/repo-${record.id}`;
      await this.authorize(record, binding, signal);
      this.save(record);
      return publicRepositoryWorkspace(record);
    });
  }
  async prepare(id: string, binding: AccountBinding, signal: AbortSignal) {
    return this.runOperation(async () => {
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
        if (record.ordinaryPreparation) {
          const source = await lstat(this.source(record));
          record.ordinaryPreparation.sourceIdentity = { dev: source.dev, ino: source.ino };
        }
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
    });
  }
  private snapshotHostInput(input: Omit<HostRepositoryReservationInput, 'signal'>) {
    const snapshot = structuredClone({
      id: input.id,
      binding: input.binding,
      conversationId: input.conversationId,
      taskRoot: input.taskRoot,
      ...(input.runtimeBinding ? { runtimeBinding: structuredClone(input.runtimeBinding) } : {}),
      ...(input.commandFingerprint ? { commandFingerprint: input.commandFingerprint } : {}),
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
    this.assertAvailable();
    const expected = this.snapshotHostInput(input);
    const record = this.getHostRecord(expected.id);
    const descriptor = this.reservationDescriptor(record);
    if (
      record.ordinaryFirstReservation &&
      expected.commandFingerprint &&
      record.ordinaryFirstReservation.commandFingerprint !== expected.commandFingerprint
    )
      throw new Error('Prepared first command is frozen');
    if (
      record.ordinaryPreparation &&
      expected.runtimeBinding &&
      !isDeepStrictEqual(expected.runtimeBinding, record.ordinaryPreparation.runtimeBinding)
    )
      throw new Error('Prepared runtime target changed');
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
    return this.runOperation(async () => {
      const expected = this.snapshotHostInput(input),
        signal = input.signal;
      signal.throwIfAborted();
      const record = this.getHostRecord(expected.id);
      if (record.state !== 'ready') {
        const descriptor = this.getHostReservation(expected);
        await this.authorizeHostRecord(record, record.binding, signal);
        if (descriptor.state !== 'claimed') await this.verifyHostSource(record, signal);
        await this.assertHostRoot(descriptor.hostReservation);
        signal.throwIfAborted();
        this.assertUnchangedHostRecord(record);
        return this.getHostReservation(expected);
      }
      if (
        record.ordinaryFirstReservation !== undefined ||
        record.hostReservation !== undefined ||
        record.conversationId !== undefined ||
        record.directory !== undefined ||
        record.sandbox !== undefined ||
        record.taskIdentity !== undefined ||
        record.sourceReleased
      )
        throw new Error('Prepared repository already reserved');
      await this.firstBinding(record, expected, signal);
      const marker: HostTaskReservationMarker = {
        version: 1,
        taskRoot: expected.taskRoot,
        rootIdentity: await this.hostRootIdentity(expected.taskRoot),
      };
      signal.throwIfAborted();
      const reserved: RepositoryWorkspace = {
        ...record,
        binding: structuredClone(expected.binding),
        state: 'reserved',
        ...(record.ordinaryPreparation
          ? {
              ordinaryFirstReservation: {
                conversationId: expected.conversationId,
                binding: structuredClone(expected.binding),
                commandFingerprint: expected.commandFingerprint!,
              },
            }
          : {}),
        conversationId: expected.conversationId,
        directory: join(expected.taskRoot, `repo-${record.id}`, 'mgmt'),
        sandbox: false,
        hostReservation: marker,
      };
      this.reservationDescriptor(reserved);
      try {
        await this.authorizeHostRecord(record, record.binding, signal);
        await this.verifyHostSource(record, signal);
        await this.authorizeHostRecord(record, record.binding, signal);
        await this.assertHostSource(record, signal);
        await this.assertHostRoot(marker);
        await this.firstBinding(record, expected, signal);
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
    });
  }
  async reserveOrdinarySandboxTask(input: HostRepositoryReservationInput) {
    return this.runOperation(async () => {
      const expected = this.snapshotHostInput(input),
        signal = input.signal;
      const record = this.getHostRecord(expected.id);
      if (!record.ordinaryPreparation) return; // Legacy full-binding claim remains its original owner.
      if (record.ordinaryFirstReservation) {
        if (
          !isDeepStrictEqual(record.ordinaryFirstReservation, {
            conversationId: expected.conversationId,
            binding: expected.binding,
            commandFingerprint: expected.commandFingerprint,
          }) ||
          !isDeepStrictEqual(record.ordinaryPreparation.runtimeBinding, expected.runtimeBinding)
        )
          throw new Error('Prepared first command is frozen');
        await this.authorize(record, expected.binding, signal);
        return;
      }
      if (
        record.state !== 'ready' ||
        record.hostReservation ||
        record.conversationId ||
        record.taskIdentity ||
        record.sourceReleased ||
        record.ordinaryPreparation.runtimeBinding.execution.location !== 'openshell'
      )
        throw new Error('Prepared repository already reserved');
      await this.firstBinding(record, expected, signal);
      await this.authorize(record, record.binding, signal);
      await this.verifyHostSource(record, signal);
      await this.firstBinding(record, expected, signal);
      const reserved: RepositoryWorkspace = {
        ...record,
        binding: structuredClone(expected.binding),
        ordinaryFirstReservation: {
          conversationId: expected.conversationId,
          binding: structuredClone(expected.binding),
          commandFingerprint: expected.commandFingerprint!,
        },
      };
      this.db
        .transaction(() => {
          this.assertUnchangedHostRecord(record);
          const result = this.db
            .prepare(
              'UPDATE repository_workspaces SET record=? WHERE id=? AND record=? AND conversation_id IS NULL',
            )
            .run(JSON.stringify(reserved), record.id, JSON.stringify(record));
          if (result.changes !== 1) throw new Error('Prepared repository reservation changed');
        })
        .immediate();
    });
  }
  /** Claim uncertainty before every destination effect; interrupted claims never replay. */
  async claimReservedHostTask(
    input: HostRepositoryReservationInput,
  ): Promise<RepositoryWorkspace & { seed?: string }> {
    return this.runOperation(async () => {
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
    });
  }
  async claim(
    id: string,
    binding: AccountBinding,
    conversationId: string,
    taskRoot: string,
    sandbox: boolean,
  ) {
    return this.runOperation(async () => {
      const record = this.get(id);
      if (record.hostReservation !== undefined)
        throw new Error('Host repository reservation requires its owning materialization path');
      if (
        record.ordinaryPreparation &&
        (!sandbox ||
          !record.ordinaryFirstReservation ||
          record.ordinaryFirstReservation.conversationId !== conversationId ||
          !isDeepStrictEqual(record.ordinaryFirstReservation.binding, binding))
      )
        throw new Error('Original ordinary sandbox reservation unavailable');
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
      if (this.get(id).state !== 'ready')
        throw new Error('Repository preparation already reserved');
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
    });
  }
}
