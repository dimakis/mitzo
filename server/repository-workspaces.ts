import {
  restoredRepositoryTaskIdentity,
  type RepositoryWorkspaceRestoration,
} from './repository-workspace-restoration.js';
import {
  retireOwnedWorkspace,
  restoreWorkspaceArchive,
  verifyWorkspaceArchiveRestoration,
  removePreservedWorkspace,
  WorkspaceRetirementReceiptSchema,
  type WorkspaceRetirementReceipt,
} from './workspace-preservation.js';
import type { WorkspaceLifecycleClaim } from './workspace-lifecycle.js';
import type { LocalRepositoryPreparationObjectData } from './local-repository-preparation-object-data.js';
import { retainPreparationPackedRefs } from './local-repository-preparation-packed-refs.js';
import { capturePreparedRepositoryTransition } from './prepared-repository-transition-capture.js';
import { materializeQualifiedLocalRepositoryTask } from './qualified-local-repository-actor.js';
import type { QualifiedLocalRepositoryPublication } from './qualified-local-repository-task.js';
import type { NativeHostToolContext } from './native-host-tool-context.js';
import type {
  PreparedRepositoryTransitionFacts,
  PreparedRepositoryTransitionCaptureInput,
  PreparedRepositoryTransitionCaptureOwners,
} from './prepared-repository-transition.js';
import { CodexNativeTurnTargetSchema } from './codex-conversation-store.js';
import {
  localRepositoryPreparationSourceFacts,
  type NativeQualifiedLocalRepositoryPreparationSource,
} from './local-repository-preparation-source.js';
import type { LocalRepositoryAllocationFacts } from './local-repository-allocation-facts.js';
import { repositorySourceIdentity } from './local-repository-base.js';
import {
  PendingHostTaskError,
  PendingHostTaskRequestSchema,
  PendingHostTaskReceiptSchema,
  PendingHostTaskDecisionScopeSchema,
  PendingHostTaskDecisionEvidenceSchema,
  PendingHostTaskDecisionSchema,
  pendingHostTaskDecisionPayload,
  pendingHostTaskDecisionHash,
  freezePendingHostTaskData,
  type PendingHostTaskRequest,
  type PendingHostTaskReceipt,
  type PendingHostTaskDecisionScope,
  type PendingHostTaskDecisionEvidence,
  type PendingHostTaskDecision,
  type PendingHostTaskDecisionOwner,
} from './pending-host-task.js';
import { contextDigest } from './agent-context-compiler.js';
import { OrdinaryWorkspaceCustody } from './ordinary-workspace-custody.js';
import type { EventStore } from './event-store.js';
import { nativeStartupSessionId } from './ordinary-repository-startup.js';
import {
  AgentLibraryVersionSchema,
  OrdinaryOpenShellCommandAdmissionSchema,
  type AgentLibraryVersion,
  type CollaborationSettings,
  type OrdinarySessionPreparationReceipt,
} from '@mitzo/protocol';
import {
  OrdinaryRepositoryPreparationSchema,
  OrdinaryRepositoryRuntimeSelectionSchema,
  OrdinarySilentPreparationSelectionSchema,
  ordinaryPreparationFingerprint,
  type OrdinaryRepositoryPreparation,
  type OrdinaryRepositoryRuntimeSelection,
} from './ordinary-repository-preparation.js';
import { isGitBranchName } from './git-branch.js';
import { copyRepositoryTaskCheckout } from './repository-task-copy.js';
import { createWorktreeAsync, symlinkRuntimeDirs } from './worktree.js';
import { loadRepoConfig } from './repo-config.js';
import {
  captureLocalRepository,
  assertLocalRepository,
  type LocalRepositorySource,
} from './local-repository-worktree.js';
import { inspectLocalRepositoryGitMetadata } from './local-repository-git-inspection.js';
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
  existsSync,
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
  GithubRepositoryPreviewSchema,
  inspectGithubRepositorySource,
  prepareGithubRepositorySource,
  MAX_REPOSITORY_CHECKOUT_BYTES,
  RepositorySourceLimitError,
  RepositorySpaceError,
  type GithubRepositoryPreview,
} from './github-repository-source.js';

/** Fresh operator authority for explicit retirement. Native unused preparations
 * also need the original command owner's synchronous no-dispatch/reference gate;
 * a consumed Prepare approval is never a retirement grant. */
export interface RepositoryRetirementAuthorization {
  assertCurrent(record: Readonly<RepositoryWorkspace>): Promise<void>;
  assertUnusedNativePreparation?(record: Readonly<RepositoryWorkspace>): void;
  assertTaskStopped?(record: Readonly<RepositoryWorkspace>): void;
}
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
  /** Private preparation custody only; never the conversation primary or an access grant. */
  pendingHostTask?: PendingHostTaskReceipt;
  /** One bounded private phase record on this same allocation row; never a grant. */
  pendingHostTaskDecision?: PendingHostTaskDecision;
  /** Historical conversationId remains immutable; only this disposition owns
   * the UNIQUE live conversation pointer after an explicit custody transfer. */
  primaryDisposition?: z.infer<typeof primaryDispositionSchema>;
  preparedRepositoryTransitionAdoption?: z.infer<typeof transitionAdoptionSchema>;
  createdAt: number;
  /** Server-derived original preview intent; private correlation, never a grant. */
  previewIntentFingerprint?: string;
  sourceDigest?: string;
  sourceReleased?: boolean;
  /** Same allocation journal, retained after physical removal. A durable lease
   * fences every await and blocks preparation/adoption across restarts. */
  retirement?: {
    version: 1;
    leaseId: string;
    expiresAt: number;
    receipt: WorkspaceRetirementReceipt;
    kind: 'unused' | 'task';
    disposition: 'retiring' | 'retired' | 'restoring' | 'restored';
  };
  workspaceRevision?: number;
  restorations?: RepositoryWorkspaceRestoration[];
  preparationFailure?: 'repository_source_limit' | 'repository_space';
  conversationId?: string;
  directory?: string;
  sandbox?: boolean;
  taskIdentity?: RepositoryTaskCheckout;
  localSource?: LocalRepositorySource;
  /** Original pre-approval facts. Historical custody only, never a grant or
   * permission to use the legacy ambient source/materialization path. */
  qualifiedLocalPreparation?: {
    version: 1;
    request: Readonly<PendingHostTaskRequest>;
    oldWorkspace: PreparedRepositoryTransitionFacts['oldWorkspace'];
    allocationFacts: LocalRepositoryAllocationFacts;
    allocationFactsSha256: string;
    publication?: QualifiedLocalRepositoryPublication;
  };
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
  failure?: { code: 'repository_source_limit' | 'repository_space'; message: string };
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

const primaryDispositionSchema = z.strictObject({
  version: z.literal(1),
  revision: z.number().int().positive().safe(),
  currentConversationId: reservationReference.nullable(),
});
const transitionFactsSchema = z
  .strictObject({
    version: z.literal('prepared-repository-transition-v1'),
    request: PendingHostTaskRequestSchema,
    oldWorkspace: z.strictObject({
      kind: z.enum(['ordinary', 'repository']),
      id: reservationReference,
      directory: canonicalPath,
    }),
    newWorkspace: z.strictObject({
      kind: z.literal('repository'),
      id: reservationReference,
      directory: canonicalPath,
      featureBranch: reservationReference,
      baseOid: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
      taskIdentity: PendingHostTaskReceiptSchema.shape.taskIdentity.unwrap(),
    }),
    consumedScopeSha256: z.string().regex(/^[a-f0-9]{64}$/),
    materializedRecordSha256: z.string().regex(/^[a-f0-9]{64}$/),
    resultSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 65536,
    'Transition facts exceed custody bound',
  );
const transitionMaterializedRecordSchema = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 262144);
/** Same custody bound used before native child reservation and by the durable
 * adoption witness. This validates bytes only; it supplies no adoption grant. */
export function assertPreparedRepositoryMaterializedRecordBound(
  value: unknown,
): asserts value is string {
  transitionMaterializedRecordSchema.parse(value);
}
const transitionAdoptionSchema = z.strictObject({
  version: z.literal(1),
  childCommandId: reservationReference,
  factsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  materializedRecord: transitionMaterializedRecordSchema,
  facts: transitionFactsSchema,
});
const equalFactsAdoptionSchema = transitionAdoptionSchema.extend({ facts: z.unknown() });
interface ImmutableTransitionProjection {
  facts: z.infer<typeof transitionFactsSchema>;
  childId: string;
  sha256: string;
  materialized?: { bytes: string; retainedFields: object };
}
// Pure projections only: the original must first prove deep immutable data.
// Current custody rows, decisions, callbacks and physical checks never enter
// this cache. One bounded materialized string is retained per live facts owner.
const immutableTransitionProjections = new WeakMap<object, ImmutableTransitionProjection>();
function transitionFacts(input: PreparedRepositoryTransitionFacts) {
  const previous = immutableTransitionProjections.get(input);
  if (previous) return previous.facts;
  let count = 0;
  const inspect = (value: unknown, depth = 0): void => {
    if (!value || typeof value !== 'object') return;
    if (++count > 4096 || depth > 32 || !Object.isFrozen(value))
      throw Error('Frozen original transition facts required');
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!('value' in descriptor)) throw Error('Transition facts require immutable data');
      inspect(descriptor.value, depth + 1);
    }
  };
  inspect(input);
  const facts = freezePendingHostTaskData(transitionFactsSchema.parse(structuredClone(input)));
  const projection = {
    facts,
    childId: transitionChildId(facts),
    sha256: pendingHostTaskDecisionHash(facts),
  };
  immutableTransitionProjections.set(input, projection);
  immutableTransitionProjections.set(facts, projection);
  return facts;
}
function retainedOriginalFields(value: object): object {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) =>
        ![
          'state',
          'conversationId',
          'directory',
          'sandbox',
          'taskIdentity',
          'hostReservation',
          'primaryDisposition',
          'preparedRepositoryTransitionAdoption',
          'sourceReleased',
          'retirement',
          'restorations',
          'workspaceRevision',
        ].includes(key),
    ),
  );
}
function materializedOriginalFields(
  facts: z.infer<typeof transitionFactsSchema>,
  bytes: string,
): object {
  const projection = immutableTransitionProjections.get(facts)!;
  if (projection.materialized?.bytes === bytes) return projection.materialized.retainedFields;
  const original: unknown = JSON.parse(bytes);
  if (
    !original ||
    typeof original !== 'object' ||
    Array.isArray(original) ||
    pendingHostTaskDecisionHash(original) !== facts.materializedRecordSha256
  )
    throw Error('Original materialized custody record changed');
  const retainedFields = freezePendingHostTaskData(retainedOriginalFields(original));
  projection.materialized = { bytes, retainedFields };
  return retainedFields;
}
function primaryConversation(record: RepositoryWorkspace): string | null {
  if (!record.primaryDisposition) return record.conversationId ?? null;
  const disposition = primaryDispositionSchema.parse(record.primaryDisposition);
  if (
    disposition.currentConversationId !== null &&
    disposition.currentConversationId !== record.conversationId
  )
    throw Error('Repository primary disposition changed');
  return disposition.currentConversationId;
}
function transitionChildId(facts: PreparedRepositoryTransitionFacts) {
  const previous = immutableTransitionProjections.get(facts);
  if (previous) return previous.childId;
  const request = facts.request;
  const source = {
    ...request.nativeTarget,
    callId: request.prepareCallId,
    requestHash: request.requestHash,
    resultSha256: facts.resultSha256,
  };
  return `prepared-repository-${pendingHostTaskDecisionHash([request.conversationId, request.id, source])}`;
}
const hostRepositoryReservationSchema = z.strictObject({
  id: z.string().uuid(),
  connectionId: reservationReference,
  connectionRevision: z.number().int().nonnegative(),
  binding: AccountBindingSchema,
  repository: reservationReference,
  baseBranch: z.string().min(1).max(1024).refine(isGitBranchName),
  baseOid: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
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
        if (bytes > MAX_REPOSITORY_CHECKOUT_BYTES)
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

class PendingHostTaskDecisionOperation {
  #claimed = false;
  #closed = false;
  constructor(
    private readonly service: object,
    readonly request: Readonly<PendingHostTaskRequest>,
    readonly scope: Readonly<PendingHostTaskDecisionScope>,
    private readonly currentSync: () => void,
    private readonly currentAsync: () => Promise<void>,
    private readonly originalContext: NativeHostToolContext,
    readonly expiresAt: number,
    private readonly originalPackedRefs?: unknown,
  ) {
    Object.freeze(this);
  }
  assertFor(service: object, request: PendingHostTaskRequest) {
    if (this.service !== service || !isDeepStrictEqual(this.request, request))
      throw new PendingHostTaskError('pending_host_task_ownership_changed');
    this.assertCurrentSync();
  }
  assertCurrentSync() {
    if (this.#closed) throw new PendingHostTaskError('pending_host_task_uncertain');
    this.currentSync();
  }
  contextFor(service: object, request: PendingHostTaskRequest) {
    this.assertFor(service, request);
    return this.originalContext;
  }
  packedRefsFor(service: object, request: PendingHostTaskRequest) {
    this.assertFor(service, request);
    return retainPreparationPackedRefs(this.originalPackedRefs);
  }
  completePublication() {
    this.#closed = true;
  }
  async assertCurrent() {
    this.assertCurrentSync();
    await this.currentAsync();
    this.assertCurrentSync();
  }
  claim() {
    this.assertCurrentSync();
    if (this.#claimed) throw new PendingHostTaskError('pending_host_task_uncertain');
    this.#claimed = true;
  }
}

interface Dependencies {
  /** Host configuration only. Request JSON selects an ID, never a filesystem path. */
  localRepositories?(): Readonly<Record<string, string>>;
  /** Trusted host composition rechecks current access. A captured path/inode is
   * custody evidence only; neither request JSON nor repository files grant access. */
  assertLocalRepositoryAccess?(
    path: string,
    context: { binding: AccountBinding; signal: AbortSignal },
  ): Promise<void>;
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
      selection?: Pick<
        import('@mitzo/protocol').OrdinaryWorkspaceSettings['selection'],
        'model' | 'thinking'
      >,
      continuation?: { conversationId: string; workspaceId: string },
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
  private readonlyLedgerProjection?: { bytes: string; record: RepositoryWorkspace };
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
    try {
      this.ordinaryWorkspaceProvider();
    } catch (error) {
      this.db.close();
      throw error;
    }
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
  qualifyOrdinaryWorkspace(input: Parameters<OrdinaryWorkspaceCustody['qualify']>[0]) {
    return this.runOperation(() => this.ordinaryWorkspaceProvider().qualify(input));
  }
  reserveOrdinaryWorkspace(input: Parameters<OrdinaryWorkspaceCustody['reserve']>[0]) {
    return this.runOperation(() => this.ordinaryWorkspaceProvider().reserve(input));
  }
  getOrdinaryWorkspaceForOperation(operationId: string) {
    return this.ordinaryWorkspaceProvider().forOperation(operationId);
  }
  validateRetainedOrdinaryWorkspace(conversationId: string) {
    return this.ordinaryWorkspaceProvider().validateRetained(conversationId);
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
      if (record.qualifiedLocalPreparation)
        throw new PendingHostTaskError('pending_host_task_access_required');
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
    this.readonlyLedgerProjection = undefined;
  }
  private save(record: RepositoryWorkspace, expectedRecord?: string) {
    if (expectedRecord === undefined) {
      this.db
        .prepare('INSERT INTO repository_workspaces(id,record,conversation_id) VALUES(?,?,?)')
        .run(record.id, JSON.stringify(record), primaryConversation(record));
      return;
    }
    const expected = JSON.parse(expectedRecord) as RepositoryWorkspace;
    if (
      record.id !== expected.id ||
      record.conversationId !== expected.conversationId ||
      !isDeepStrictEqual(record.primaryDisposition, expected.primaryDisposition) ||
      !isDeepStrictEqual(
        record.preparedRepositoryTransitionAdoption,
        expected.preparedRepositoryTransitionAdoption,
      )
    )
      throw Error('Repository custody metadata requires its exact transition owner');
    const changed = this.db
      .prepare(
        'UPDATE repository_workspaces SET record=? WHERE id=? AND record=? AND conversation_id IS ?',
      )
      .run(JSON.stringify(record), record.id, expectedRecord, primaryConversation(expected));
    if (changed.changes !== 1) throw Error('Repository persistence owner changed');
  }
  private assertNoOrdinaryPrimary(conversationId: string) {
    if (
      this.db
        .prepare('SELECT id FROM ordinary_workspaces WHERE conversation_id=?')
        .get(conversationId)
    )
      throw Error('Ambiguous local workspace primary custody');
  }
  getForConversation(conversationId: string) {
    this.assertAvailable();
    const row = this.db
      .prepare('SELECT id FROM repository_workspaces WHERE conversation_id=?')
      .get(conversationId) as { id: string } | undefined;
    if (!row) return undefined;
    this.assertNoOrdinaryPrimary(conversationId);
    const record = this.getHostRecord(row.id);
    if (primaryConversation(record) !== conversationId)
      throw Error('Current repository primary changed');
    if (record.state !== 'claimed')
      throw new Error(
        'Repository workspace preparation did not complete; preserve its original claim',
      );
    return {
      ...record,
      ...(!record.localSource && !record.sourceReleased ? { seed: this.source(record) } : {}),
    };
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
      if (record.localSource?.selection === 'existing') {
        await this.assertLocalSource(record, record.binding, new AbortController().signal);
        this.assertUnchangedHostRecord(record);
      }
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
      ...(record.state === 'failed' && record.preparationFailure
        ? {
            failure: {
              code: record.preparationFailure,
              message:
                record.preparationFailure === 'repository_space'
                  ? new RepositorySpaceError().message
                  : new RepositorySourceLimitError().message,
            },
          }
        : {}),
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
  /** Inventory projection over every persisted allocation, including unused,
   * failed and uncertain rows. Missing live processes never imply settled leases. */
  lifecycleClaims(): WorkspaceLifecycleClaim[] {
    this.assertAvailable();
    const rows = this.db
      .prepare('SELECT record FROM repository_workspaces LIMIT 10001')
      .all() as Array<{ record: string }>;
    if (rows.length > 10000) throw Error('Workspace claim inventory exceeds its bounded limit');
    const claims = rows
      .map((row): WorkspaceLifecycleClaim | undefined => {
        const record = JSON.parse(row.record) as RepositoryWorkspace;
        const receipt = record.retirement?.receipt;
        const directory =
          receipt?.directory ??
          record.pendingHostTask?.directory ??
          record.directory ??
          (record.localSource ? undefined : join(this.directory, record.id));
        if (!directory) return undefined;
        const archived =
          receipt?.state === 'retired' && record.retirement?.disposition !== 'restored';
        const uncertain =
          ['preparing', 'claiming'].includes(record.state) ||
          ['materializing', 'uncertain'].includes(record.pendingHostTask?.state ?? '') ||
          (!!record.retirement && !['retired', 'restored'].includes(record.retirement.disposition));
        return {
          id: record.id,
          directory,
          state: archived
            ? 'retired'
            : uncertain
              ? 'uncertain'
              : record.conversationId
                ? 'resumable'
                : record.state === 'failed'
                  ? 'failed'
                  : 'unused',
          ownership: 'owned',
          activeCommands: 0,
          queuedCommands: 0,
          resumeReferences: archived
            ? []
            : record.conversationId
              ? [record.conversationId]
              : record.ordinaryFirstReservation
                ? [record.ordinaryFirstReservation.conversationId]
                : [],
          leaseState: uncertain || record.state === 'reserved' ? 'unknown' : 'settled',
        } satisfies WorkspaceLifecycleClaim;
      })
      .filter((claim): claim is WorkspaceLifecycleClaim => !!claim);
    const ordinary = this.db
      .prepare('SELECT record FROM ordinary_workspaces LIMIT 10001')
      .all() as Array<{ record: string }>;
    if (ordinary.length > 10000) throw Error('Ordinary claim inventory exceeds its bounded limit');
    for (const row of ordinary) {
      const record = JSON.parse(
        row.record,
      ) as import('./ordinary-workspace-custody.js').OrdinaryWorkspaceRecord;
      if (record.sandbox) continue;
      claims.push({
        id: record.id,
        directory: record.directory,
        ownership: 'owned',
        state: record.state === 'claiming' ? 'uncertain' : 'resumable',
        activeCommands: 0,
        queuedCommands: 0,
        resumeReferences: [record.conversationId],
        leaseState: record.state === 'claimed' ? 'settled' : 'unknown',
      });
    }
    for (const row of rows) {
      const record = JSON.parse(row.record) as RepositoryWorkspace;
      const archives = [
        record.retirement?.receipt.archive,
        ...(record.restorations ?? []).map((restoration) => restoration.retirement.archive),
      ];
      for (const archive of archives)
        if (archive && !claims.some((claim) => claim.directory === archive.directory))
          claims.push({
            id: record.id + ':archive:' + archive.sha256,
            directory: archive.directory,
            ownership: 'owned',
            state: 'resumable',
            activeCommands: 0,
            queuedCommands: 0,
            resumeReferences: [record.conversationId ?? record.id],
            leaseState: 'settled',
            protectedReason: 'preservation-archive',
          });
    }
    return claims;
  }
  async discard(
    id: string,
    binding: AccountBinding,
    authority?: RepositoryRetirementAuthorization,
  ) {
    return this.retireWorkspace(id, binding, authority, 'unused');
  }
  async retireTask(
    id: string,
    binding: AccountBinding,
    authority: RepositoryRetirementAuthorization,
  ) {
    return this.retireWorkspace(id, binding, authority, 'task');
  }
  private async retireWorkspace(
    id: string,
    binding: AccountBinding,
    authority: RepositoryRetirementAuthorization | undefined,
    kind: 'unused' | 'task',
  ) {
    return this.runOperation(async () => {
      let record = this.get(id);
      const assertAuthority = authority?.assertCurrent;
      const assertNative =
        kind === 'unused' ? authority?.assertUnusedNativePreparation : authority?.assertTaskStopped;
      const unused = () => {
        if (kind === 'task') {
          if (
            !assertAuthority ||
            !assertNative ||
            !isDeepStrictEqual(record.binding, binding) ||
            record.state !== 'claimed' ||
            record.sandbox ||
            !record.taskIdentity ||
            record.taskIdentity.linkedGit ||
            !record.conversationId ||
            primaryConversation(record) !== record.conversationId ||
            this.getForConversation(record.conversationId)?.id !== record.id
          )
            throw Error('Used task retirement requires its current stopped owner authority');
          if ((record.restorations?.length ?? 0) >= 32)
            throw Error('Workspace restoration history reached its retention limit');
          return;
        }
        if (
          !isDeepStrictEqual(record.binding, binding) ||
          record.conversationId ||
          primaryConversation(record) ||
          record.ordinaryFirstReservation ||
          !['preview', 'ready', 'failed', 'discarded'].includes(record.state)
        )
          throw Error('Only an unused preparation can be retired');
        if (
          record.pendingHostTask &&
          (!assertAuthority ||
            !assertNative ||
            !['reserved', 'materialized'].includes(record.pendingHostTask.state))
        )
          throw Error('Unused native preparation requires fresh settled command authority');
        if (record.qualifiedLocalPreparation && !record.pendingHostTask)
          throw Error('Qualified preparation ownership is incomplete');
      };
      const externalCurrent = async () => {
        unused();
        if (assertAuthority) {
          if (
            authority?.assertCurrent !== assertAuthority ||
            (kind === 'unused'
              ? authority.assertUnusedNativePreparation
              : authority.assertTaskStopped) !== assertNative
          )
            throw Error('Original retirement authorization changed');
          await assertAuthority.call(authority, structuredClone(record));
        }
        if (record.pendingHostTask || kind === 'task') {
          const checked: unknown = assertNative!.call(authority, structuredClone(record));
          if (checked !== undefined)
            throw Error('Synchronous settled native command authority required');
        }
        unused();
      };
      await externalCurrent();
      if (
        kind === 'unused' &&
        record.state === 'ready' &&
        record.ordinaryPreparation &&
        !record.retirement
      )
        await this.assertOrdinaryPreparation(record, binding, AbortSignal.timeout(30000), true);
      await externalCurrent();
      if (!isDeepStrictEqual(this.get(id), record))
        throw Error('Preparation changed before retirement');
      // Local selection before task materialization owns metadata, never the
      // canonical source. A preview may likewise have allocated no filesystem.
      const task = kind === 'task' ? record.taskIdentity : record.pendingHostTask?.taskIdentity;
      const path =
        kind === 'task'
          ? record.directory
          : (record.retirement?.receipt.directory ??
            record.pendingHostTask?.directory ??
            (!record.localSource ? join(this.directory, id) : undefined));
      if (!path || (!record.pendingHostTask && !record.retirement && !existsSync(path))) {
        const original = JSON.stringify(record);
        await externalCurrent();
        this.save({ ...record, state: 'discarded' }, original);
        return;
      }
      if (record.pendingHostTask && (!task || task.linkedGit))
        throw Error('Only an exactly owned independent task can be retired');
      if (task && task.directory !== path) throw Error('Retirement task identity changed');
      if (
        record.retirement &&
        record.retirement.receipt.state !== 'retired' &&
        record.retirement.expiresAt > Date.now()
      )
        throw Error('Workspace retirement lease is still active');
      const previous =
        record.retirement?.disposition === 'restored' ? undefined : record.retirement?.receipt;
      const info = previous
        ? previous.rootIdentity
        : (task?.root ?? (await lstat(path).then((value) => ({ dev: value.dev, ino: value.ino }))));
      if (
        kind === 'unused' &&
        !record.localSource &&
        !record.retirement &&
        record.sourceDigest &&
        (await repositorySourceDigest(join(this.directory, id, 'mgmt'))) !== record.sourceDigest
      )
        throw Error('Unused source custody changed before retirement');
      await externalCurrent();
      const leaseId = randomUUID();
      const initial: WorkspaceRetirementReceipt =
        previous ??
        WorkspaceRetirementReceiptSchema.parse({
          version: 1,
          operationId: randomUUID(),
          workspaceId: id,
          directory: path,
          rootIdentity: info,
          state: 'archiving',
        });
      const original = JSON.stringify(record);
      record = {
        ...record,
        retirement: {
          version: 1,
          leaseId,
          expiresAt: Date.now() + 300000,
          receipt: initial,
          kind,
          disposition: 'retiring',
        },
      };
      this.save(record, original);
      const assertCurrent = async () => {
        await externalCurrent();
        if (
          !isDeepStrictEqual(this.get(id), record) ||
          record.retirement?.leaseId !== leaseId ||
          record.retirement.expiresAt <= Date.now()
        )
          throw Error('Workspace retirement lease changed');
      };
      const archiveRoot = join(this.directory, 'archives');
      await assertCurrent();
      await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
      await assertCurrent();
      await retireOwnedWorkspace(
        Object.freeze({
          operationId: initial.operationId,
          workspaceId: id,
          directory: path,
          rootIdentity: initial.rootIdentity,
          archiveRoot,
          previousReceipt: previous,
          assertCurrent,
          record: async (receipt: WorkspaceRetirementReceipt) => {
            await assertCurrent();
            const original = JSON.stringify(record);
            const checked = WorkspaceRetirementReceiptSchema.parse(receipt);
            record = {
              ...record,
              ...(checked.state === 'retired' && kind === 'unused'
                ? { state: 'discarded' as const }
                : {}),
              retirement: {
                version: 1,
                leaseId,
                expiresAt: Date.now() + 300000,
                receipt: checked,
                kind,
                disposition: checked.state === 'retired' ? 'retired' : 'retiring',
              },
            };
            this.save(record, original);
          },
          remove: async (expected, archive) => {
            await assertCurrent();
            await removePreservedWorkspace(path, expected, archive);
            await assertCurrent();
          },
        }),
      );
    });
  }
  /** Explicit restoration reuses the same conversation/cwd and appends current
   * physical identity. Historical creation/adoption receipts are never rewritten. */
  async restoreTask(
    id: string,
    binding: AccountBinding,
    authority: RepositoryRetirementAuthorization,
  ) {
    return this.runOperation(async () => {
      let record = this.get(id);
      const stopped = authority.assertTaskStopped,
        authorize = authority.assertCurrent;
      if (
        !stopped ||
        typeof authorize !== 'function' ||
        !isDeepStrictEqual(record.binding, binding) ||
        record.state !== 'claimed' ||
        record.sandbox ||
        !record.taskIdentity ||
        record.taskIdentity.linkedGit ||
        !record.conversationId ||
        primaryConversation(record) !== record.conversationId ||
        record.retirement?.kind !== 'task' ||
        record.retirement.receipt.state !== 'retired' ||
        !['retired', 'restoring'].includes(record.retirement.disposition)
      )
        throw Error('Restoration requires the exact archived task and stopped owner authority');
      const previousTaskIdentity = structuredClone(record.taskIdentity);
      const receipt = WorkspaceRetirementReceiptSchema.parse(record.retirement.receipt);
      if (
        !receipt.archive ||
        receipt.directory !== record.directory ||
        !isDeepStrictEqual(receipt.rootIdentity, previousTaskIdentity.root)
      )
        throw Error('Archived task receipt identity changed');
      if ((record.restorations?.length ?? 0) >= 32)
        throw Error('Workspace restoration history reached its retention limit');
      if (record.retirement.disposition === 'restoring' && record.retirement.expiresAt > Date.now())
        throw Error('Workspace restoration lease is still active');
      const externalCurrent = async () => {
        if (authority.assertCurrent !== authorize || authority.assertTaskStopped !== stopped)
          throw Error('Original restoration authority changed');
        await authorize.call(authority, structuredClone(record));
        const checked: unknown = stopped.call(authority, structuredClone(record));
        if (checked !== undefined) throw Error('Synchronous stopped task authority required');
        if (!isDeepStrictEqual(this.get(id), record))
          throw Error('Workspace restoration owner changed');
      };
      await externalCurrent();
      const reconciling = record.retirement.disposition === 'restoring';
      if (!reconciling && existsSync(receipt.directory))
        throw Error('An existing directory requires its original restoration journal');
      const leaseId = randomUUID();
      const original = JSON.stringify(record);
      record = {
        ...record,
        retirement: {
          ...record.retirement,
          leaseId,
          expiresAt: Date.now() + 300000,
          disposition: 'restoring',
        },
      };
      this.save(record, original);
      const current = async () => {
        await externalCurrent();
        if (record.retirement?.leaseId !== leaseId || record.retirement.expiresAt <= Date.now())
          throw Error('Workspace restoration lease changed');
      };
      await current();
      if (record.hostReservation) await this.assertHostRoot(record.hostReservation);
      await current();
      if (existsSync(receipt.directory)) {
        // Reconcile only exact bytes left by this journalled restoration. No
        // overwrite, reset or adoption of a changed/foreign existing directory.
        await verifyWorkspaceArchiveRestoration(receipt.archive, receipt.directory);
      } else await restoreWorkspaceArchive(receipt.archive, receipt.directory);
      await current();
      const restored = await snapshotRepositoryTaskCheckout(
        receipt.directory,
        previousTaskIdentity.featureBranch,
      );
      await current();
      await verifyWorkspaceArchiveRestoration(receipt.archive, receipt.directory);
      await current();
      const taskIdentity = {
        ...restored,
        ...(previousTaskIdentity.localSource
          ? { localSource: structuredClone(previousTaskIdentity.localSource) }
          : {}),
      };
      const revision = (record.workspaceRevision ?? 0) + 1;
      const restoration: RepositoryWorkspaceRestoration = {
        version: 1,
        revision,
        retirement: receipt,
        previousTaskIdentity,
        taskIdentity,
      };
      const prior = JSON.stringify(record);
      const next: RepositoryWorkspace = {
        ...record,
        taskIdentity,
        workspaceRevision: revision,
        restorations: [...(record.restorations ?? []), restoration],
        retirement: { ...record.retirement!, disposition: 'restored', expiresAt: 0 },
      };
      restoredRepositoryTaskIdentity(next, next.restorations![0].previousTaskIdentity);
      await current();
      this.save(next, prior);
      return next;
    });
  }
  get(id: string): RepositoryWorkspace {
    this.assertAvailable();
    return this.getHostRecord(id);
  }
  /** Private live completed-turn composition; no native registration/admission. */
  async capturePreparedRepositoryTransition(
    input: PreparedRepositoryTransitionCaptureInput,
    owners: PreparedRepositoryTransitionCaptureOwners,
  ) {
    return capturePreparedRepositoryTransition(this, input, owners);
  }
  /** Bounded read-only metadata selector. No path/latest/model ID inference. */
  findPreparedRepositoryTransitionCandidate(input: PreparedRepositoryTransitionCaptureInput) {
    this.assertAvailable();
    let selected: PreparedRepositoryTransitionCaptureInput;
    try {
      selected = freezePendingHostTaskData(
        z
          .strictObject({
            binding: AccountBindingSchema,
            conversationId: reservationReference,
            sourceTarget: CodexNativeTurnTargetSchema,
            oldWorkspace: transitionFactsSchema.shape.oldWorkspace,
          })
          .parse(structuredClone(input)),
      );
    } catch {
      throw new PendingHostTaskError('pending_host_task_invalid_input');
    }
    return this.db
      .transaction(() => {
        const rows = this.db
          .prepare(
            `SELECT id,record,conversation_id FROM repository_workspaces
             WHERE json_extract(record,'$.pendingHostTask.request.conversationId')=?
               AND json_extract(record,'$.pendingHostTask.request.nativeTarget.commandId')=?
               AND json_extract(record,'$.pendingHostTask.request.nativeTarget.attempt')=?
               AND json_extract(record,'$.pendingHostTask.request.nativeTarget.threadId')=?
               AND json_extract(record,'$.pendingHostTask.request.nativeTarget.turnId')=?
               AND json_extract(record,'$.pendingHostTask.request.nativeTarget.generation')=?
               AND json_extract(record,'$.binding.accountId')=?
               AND json_extract(record,'$.binding.accountLabel')=?
               AND json_extract(record,'$.binding.provider')=?
               AND json_extract(record,'$.binding.model')=?
               AND json_extract(record,'$.binding.profileRevision')=?
               AND json_extract(record,'$.pendingHostTaskDecision.scope.oldWorkspace.kind')=?
               AND json_extract(record,'$.pendingHostTaskDecision.scope.oldWorkspace.id')=?
               AND json_extract(record,'$.pendingHostTaskDecision.scope.oldWorkspace.directory')=?
             LIMIT 2`,
          )
          .all(
            selected.conversationId,
            selected.sourceTarget.commandId,
            selected.sourceTarget.attempt,
            selected.sourceTarget.threadId,
            selected.sourceTarget.turnId,
            selected.sourceTarget.generation,
            selected.binding.accountId,
            selected.binding.accountLabel,
            selected.binding.provider,
            selected.binding.model,
            selected.binding.profileRevision,
            selected.oldWorkspace.kind,
            selected.oldWorkspace.id,
            selected.oldWorkspace.directory,
          ) as Array<{ id: string; record: string; conversation_id: string | null }>;
        if (rows.length === 0) return undefined;
        if (rows.length !== 1) throw new PendingHostTaskError('pending_host_task_uncertain');
        try {
          const raw = rows[0];
          assertPreparedRepositoryMaterializedRecordBound(raw.record);
          const retained = JSON.parse(raw.record) as RepositoryWorkspace;
          const request = this.snapshotPendingInput(
            retained.pendingHostTask?.request as PendingHostTaskRequest,
          );
          // This read transaction retains the same SQL snapshot while the
          // existing pending-record validator checks all original row facts.
          const record = this.pendingRecord(request);
          const receipt = PendingHostTaskReceiptSchema.parse(record.pendingHostTask);
          const decision = PendingHostTaskDecisionSchema.parse(record.pendingHostTaskDecision);
          const payload = pendingHostTaskDecisionPayload(request, decision.scope);
          if (
            raw.id !== request.id ||
            raw.conversation_id !== null ||
            record.preparedRepositoryTransitionAdoption !== undefined ||
            receipt.state !== 'materialized' ||
            !receipt.taskIdentity ||
            request.conversationId !== selected.conversationId ||
            !isDeepStrictEqual(request.nativeTarget, selected.sourceTarget) ||
            !isDeepStrictEqual(request.binding, selected.binding) ||
            decision.state !== 'consumed' ||
            !isDeepStrictEqual(decision.request, request) ||
            !isDeepStrictEqual(decision.scope.oldWorkspace, selected.oldWorkspace) ||
            decision.scopeSha256 !== pendingHostTaskDecisionHash(decision.scope) ||
            decision.scope.sourceDigest !== record.sourceDigest ||
            !isDeepStrictEqual(decision.scope.sourceIdentity, record.localSource) ||
            decision.evidence.sessionId !== selected.conversationId ||
            decision.evidence.toolUseID !== request.prepareCallId ||
            !isDeepStrictEqual(decision.evidence.input, payload) ||
            decision.evidence.inputSha256 !== pendingHostTaskDecisionHash(payload)
          )
            throw new PendingHostTaskError('pending_host_task_ownership_changed');
          return freezePendingHostTaskData({ request, record, rawRecord: raw.record });
        } catch {
          throw new PendingHostTaskError('pending_host_task_ownership_changed');
        }
      })
      .deferred();
  }
  private source(record: RepositoryWorkspace) {
    if (record.localSource) return record.localSource.path;
    return join(this.directory, record.id, 'mgmt');
  }
  async releaseSource(id: string, binding: AccountBinding, conversationId: string) {
    return this.runOperation(async () => {
      const record = this.get(id);
      if (record.qualifiedLocalPreparation)
        throw new PendingHostTaskError('pending_host_task_access_required');
      if (
        record.state !== 'claimed' ||
        record.conversationId !== conversationId ||
        !isDeepStrictEqual(record.binding, binding)
      )
        throw new Error('Repository source release requires its settled conversation claim');
      if (this.getForConversation(conversationId)?.id !== id)
        throw Error('Source release requires its current primary owner');
      if (record.sourceReleased) return;
      const expectedRecord = JSON.stringify(record);
      await rm(join(this.directory, id), { recursive: true, force: true });
      record.sourceReleased = true;
      this.save(record, expectedRecord);
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
    if (record.retirement && record.retirement.disposition !== 'restored')
      throw Error('Repository preparation is retiring');
    if (record.qualifiedLocalPreparation)
      throw new PendingHostTaskError('pending_host_task_access_required');
    if (!isDeepStrictEqual(record.binding, binding))
      throw new Error('Repository preparation belongs to another account selection');
    if (record.ordinaryPreparation) await this.assertOrdinaryPreparation(record, binding, signal);
    if (record.localSource) {
      await this.assertLocalSource(record, binding, signal);
      return;
    }
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
  private async assertLocalSource(
    record: RepositoryWorkspace,
    binding: AccountBinding,
    signal: AbortSignal,
  ) {
    if (record.qualifiedLocalPreparation)
      throw new PendingHostTaskError('pending_host_task_access_required');
    const source = record.localSource!;
    signal.throwIfAborted();
    if (source.selection === 'existing') {
      const metadata = await this.assertExistingLocalRepositoryAccess(source.path, binding, signal);
      if (metadata.commonDirectory !== source.commonDirectory)
        throw Error('Original local repository storage changed');
    }
    assertLocalRepository(
      source,
      source.selection === 'existing'
        ? source.path
        : this.deps.localRepositories?.()[source.repositoryId],
      record.baseOid,
    );
    signal.throwIfAborted();
  }
  private async assertExistingLocalRepositoryAccess(
    path: string,
    binding: AccountBinding,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (!this.deps.assertLocalRepositoryAccess)
      throw Error('Existing local repository access authority unavailable');
    await this.deps.assertLocalRepositoryAccess(path, {
      binding: structuredClone(binding),
      signal,
    });
    const metadata = await inspectLocalRepositoryGitMetadata({
      path,
      signal,
      assertReadable: (readPath) =>
        this.deps.assertLocalRepositoryAccess!(readPath, {
          binding: structuredClone(binding),
          signal,
        }),
    });
    signal.throwIfAborted();
    if (metadata.path !== path) throw Error('Original local repository root required');
    return metadata;
  }
  private async assertOrdinaryPreparation(
    record: RepositoryWorkspace,
    binding: AccountBinding,
    signal: AbortSignal,
    requireModelReadiness = false,
  ) {
    if (record.qualifiedLocalPreparation)
      throw new PendingHostTaskError('pending_host_task_access_required');
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
    await this.deps.ordinaryPreparation.assert(
      proof,
      binding,
      signal,
      requireModelReadiness,
      undefined,
      record.state === 'claimed' && record.conversationId
        ? { conversationId: record.conversationId, workspaceId: record.id }
        : undefined,
    );
    // Durable terminal records are metadata only. Discard/failure cleanup can
    // remove their source; this does not assert that cleanup completed or grant
    // another preparation. Current account/runtime checks above still apply.
    if (
      proof.sourceIdentity &&
      !record.sourceReleased &&
      !['claimed', 'discarded', 'failed'].includes(record.state)
    ) {
      const info = await lstat(this.source(record));
      if (info.dev !== proof.sourceIdentity.dev || info.ino !== proof.sourceIdentity.ino)
        throw new Error('Prepared source physical identity changed');
    }
    signal.throwIfAborted();
  }
  async qualifiedStatus(id: string, binding: AccountBinding) {
    return this.runOperation(async () => {
      const record = this.get(id);
      if (record.qualifiedLocalPreparation)
        throw new PendingHostTaskError('pending_host_task_access_required');
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
  /** Select an existing Mac checkout. No remote authorization, download or copy. */
  async selectLocalRepository(
    binding: AccountBinding,
    repositoryId: string,
    selection: OrdinaryRepositoryRuntimeSelection,
    signal: AbortSignal,
    requestId: string = randomUUID(),
    startPoint?: string,
  ) {
    return this.selectLocalRepositorySource(
      binding,
      repositoryId,
      selection,
      signal,
      requestId,
      startPoint,
    );
  }
  /** Server-only path intent after bounded discovery. This does not authorize
   * native execution or switch a running conversation's workspace. */
  async selectExistingLocalRepository(
    binding: AccountBinding,
    path: string,
    selection: OrdinaryRepositoryRuntimeSelection,
    signal: AbortSignal,
    requestId: string = randomUUID(),
    startPoint?: string,
  ) {
    path = canonicalPath.parse(path);
    const configured = Object.entries(this.deps.localRepositories?.() ?? {}).find(
      ([id, value]) => value === path && /^[A-Za-z0-9._-]+$/.test(id),
    );
    const repositoryId =
      configured?.[0] ?? `existing-${createHash('sha256').update(path).digest('hex')}`;
    return this.selectLocalRepositorySource(
      binding,
      repositoryId,
      selection,
      signal,
      requestId,
      startPoint ?? 'HEAD',
      path,
    );
  }
  /** Private read projection for a genuine current native callback. This never
   * renews creation approval, changes an original receipt, or grants file access. */
  findLocalRepositoryPreparation(input: {
    id: string;
    conversationId: string;
    workspace: { id: string; directory: string };
    path: string;
    base: import('./local-repository-base.js').RepositoryBaseIntent;
    binding: AccountBinding;
    newCheckout?: true;
  }): RepositoryWorkspace | undefined {
    this.assertAvailable();
    const current = !input.newCheckout ? this.getForConversation(input.conversationId) : undefined;
    const row = this.db.prepare('SELECT id FROM repository_workspaces WHERE id=?').get(input.id) as
      { id: string } | undefined;
    const identity = (record: RepositoryWorkspace) =>
      record.qualifiedLocalPreparation?.allocationFacts.sourceIntent
        ? repositorySourceIdentity(record.qualifiedLocalPreparation.allocationFacts.sourceIntent)
        : record.localSource?.path;
    const record =
      current?.id === input.workspace.id &&
      identity(current) === input.path &&
      current.qualifiedLocalPreparation &&
      isDeepStrictEqual(
        current.qualifiedLocalPreparation.allocationFacts.baseIntent ?? {
          kind: 'ref',
          ref: 'HEAD',
        },
        input.base,
      )
        ? current
        : row
          ? this.getHostRecord(row.id)
          : undefined;
    if (!record) return;
    const selectedBase = record.qualifiedLocalPreparation?.allocationFacts.baseIntent ?? {
      kind: 'ref',
      ref: 'HEAD',
    };
    if (
      identity(record) !== input.path ||
      !record.qualifiedLocalPreparation ||
      !isDeepStrictEqual(selectedBase, input.base)
    ) {
      if (record === current && !row) return;
      throw new PendingHostTaskError('pending_host_task_ownership_changed');
    }
    const request = record.qualifiedLocalPreparation.request;
    const account = (binding: AccountBinding) => ({
      accountId: binding.accountId,
      provider: binding.provider,
      profileRevision: binding.profileRevision,
    });
    if (
      request.conversationId !== input.conversationId ||
      !isDeepStrictEqual(account(record.binding), account(input.binding)) ||
      (record.id === input.workspace.id
        ? record.directory !== input.workspace.directory
        : record.qualifiedLocalPreparation.oldWorkspace.id !== input.workspace.id ||
          record.qualifiedLocalPreparation.oldWorkspace.directory !== input.workspace.directory)
    )
      throw new PendingHostTaskError('pending_host_task_ownership_changed');
    if (record.state === 'claimed' && record.id === input.workspace.id) {
      const adoption = record.preparedRepositoryTransitionAdoption;
      if (!adoption) throw new PendingHostTaskError('pending_host_task_ownership_changed');
      this.assertPreparedRepositoryTransitionAdopted(adoption.facts, adoption.childCommandId);
    }
    return record;
  }
  /** Private original-owner persistence. All source reads belong to the exact
   * retained qualified capability; generic legacy source/status/materializers
   * cannot use this row. No files, branches, current pointers or grants change. */
  async selectQualifiedExistingLocalRepository(
    input: {
      request: Readonly<PendingHostTaskRequest>;
      oldWorkspace: PreparedRepositoryTransitionFacts['oldWorkspace'];
      source: NativeQualifiedLocalRepositoryPreparationSource;
      assertCurrentSync(): void;
    },
    signal: AbortSignal,
  ) {
    return this.runOperation(async () => {
      const request = this.snapshotPendingInput(input.request);
      const oldWorkspace = freezePendingHostTaskData(
        transitionFactsSchema.shape.oldWorkspace.parse(structuredClone(input.oldWorkspace)),
      );
      const source = input.source;
      const descriptors = source && Object.getOwnPropertyDescriptors(source);
      const originalCurrent = Object.getOwnPropertyDescriptor(input, 'assertCurrentSync');
      const methods = ['assertCurrentSync', 'assertCurrent', 'revalidateAllocationFacts'] as const;
      if (
        !descriptors ||
        !originalCurrent ||
        !('value' in originalCurrent) ||
        typeof originalCurrent.value !== 'function' ||
        methods.some(
          (name) =>
            !descriptors[name] ||
            !('value' in descriptors[name]) ||
            typeof descriptors[name].value !== 'function',
        )
      )
        throw new PendingHostTaskError('pending_host_task_access_required');
      const fields = [
        'source',
        'baseBranch',
        'baseOid',
        'anchorsSha256',
        'referenceCoverage',
        'allocationFacts',
        'allocationFactsSha256',
      ] as const;
      if (fields.some((name) => !descriptors[name] || !('value' in descriptors[name])))
        throw new PendingHostTaskError('pending_host_task_access_required');
      const sourceCurrent = descriptors.assertCurrentSync.value!;
      const sourceRevalidate = descriptors.assertCurrent.value!;
      const strict = (callback: (...args: never[]) => unknown, receiver: object) => {
        const result: unknown = Reflect.apply(callback, receiver, []);
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => {});
          throw new PendingHostTaskError('pending_host_task_authority_required');
        }
      };
      const current = () => {
        signal.throwIfAborted();
        strict(originalCurrent.value, input);
        strict(sourceCurrent, source);
        strict(originalCurrent.value, input);
        for (const name of [...fields, ...methods]) {
          const actual = Object.getOwnPropertyDescriptor(source, name);
          if (!actual || !('value' in actual) || actual.value !== descriptors[name].value)
            throw new PendingHostTaskError('pending_host_task_ownership_changed');
        }
      };
      current();
      // Validate immutable plain data before cloning/stringifying. Original
      // producer bounds remain unchanged; no getter is allowed to supply facts.
      let count = 0;
      const inspect = (value: unknown, depth = 0): void => {
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
        if (typeof value === 'number' && Number.isFinite(value)) return;
        if (typeof value !== 'object')
          throw new PendingHostTaskError('pending_host_task_access_required');
        if (
          ++count > 4096 ||
          depth > 32 ||
          !Object.isFrozen(value) ||
          (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
        )
          throw new PendingHostTaskError('pending_host_task_access_required');
        for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
          if (!('value' in descriptor))
            throw new PendingHostTaskError('pending_host_task_access_required');
          inspect(descriptor.value, depth + 1);
        }
      };
      const supplied = descriptors.allocationFacts.value as LocalRepositoryAllocationFacts;
      inspect(supplied);
      const serialized = JSON.stringify(supplied);
      if (!serialized || Buffer.byteLength(serialized) > 32768)
        throw new PendingHostTaskError('pending_host_task_access_required');
      const facts: LocalRepositoryAllocationFacts = freezePendingHostTaskData(
        JSON.parse(serialized),
      );
      const digest = pendingHostTaskDecisionHash(facts);
      const labels = localRepositoryPreparationSourceFacts(facts);
      if (
        facts.version !== 1 ||
        !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(facts.baseOid) ||
        facts.workspaceId !== request.id ||
        facts.taskRoot.rootPath !== request.taskRoot ||
        facts.featureBranch !== `mitzo/repo-${request.id}` ||
        facts.source.qualification !== 'preparation' ||
        facts.source.referenceCoverage !== 'preparation-head-and-namespace-v1' ||
        facts.source.sourceAnchor.rootPath !== labels.source.path ||
        facts.source.commonAnchor.rootPath !== labels.source.commonDirectory ||
        descriptors.referenceCoverage.value !== 'preparation-head-and-namespace-v1' ||
        descriptors.allocationFactsSha256.value !== digest ||
        !isDeepStrictEqual(descriptors.source.value, labels.source) ||
        descriptors.baseBranch.value !== labels.baseBranch ||
        descriptors.baseOid.value !== labels.baseOid ||
        descriptors.anchorsSha256.value !== labels.anchorsSha256 ||
        !isGitBranchName(labels.baseBranch)
      )
        throw new PendingHostTaskError('pending_host_task_ownership_changed');
      const qualifiedLocalPreparation = freezePendingHostTaskData({
        version: 1 as const,
        request,
        oldWorkspace,
        allocationFacts: facts,
        allocationFactsSha256: digest,
      });
      const revalidate = async () => {
        current();
        if ((await Reflect.apply(sourceRevalidate, source, [])) !== undefined)
          throw new PendingHostTaskError('pending_host_task_authority_required');
        current();
      };
      await revalidate();
      const repositoryId = `existing-${createHash('sha256').update(labels.source.path).digest('hex')}`;
      const localSource: LocalRepositorySource = {
        selection: 'existing',
        repositoryId,
        path: labels.source.path,
        root: labels.source.root,
        commonDirectory: labels.source.commonDirectory,
        commonRoot: labels.source.commonRoot,
      };
      const fingerprint = pendingHostTaskDecisionHash([
        'qualified-local-preparation-v1',
        qualifiedLocalPreparation,
      ]);
      const retained = this.db
        .prepare('SELECT id FROM repository_workspaces WHERE id=?')
        .get(request.id);
      if (retained) {
        const record = this.get(request.id);
        if (
          record.state !== 'ready' ||
          record.hostReservation ||
          record.pendingHostTask ||
          record.pendingHostTaskDecision ||
          record.conversationId !== undefined ||
          record.directory !== undefined ||
          record.sandbox !== undefined ||
          record.taskIdentity ||
          record.ordinaryFirstReservation ||
          record.sourceReleased ||
          record.preparedRepositoryTransitionAdoption ||
          record.previewIntentFingerprint !== fingerprint ||
          !isDeepStrictEqual(record.qualifiedLocalPreparation, qualifiedLocalPreparation) ||
          !isDeepStrictEqual(record.localSource, localSource) ||
          !isDeepStrictEqual(record.binding, request.binding) ||
          !isDeepStrictEqual(record.ordinaryPreparation?.originalBinding, request.binding) ||
          !isDeepStrictEqual(record.ordinaryPreparation?.runtimeBinding, request.runtimeBinding) ||
          record.sourceDigest !== digest ||
          record.featureBranch !== facts.featureBranch ||
          record.baseOid !== labels.baseOid ||
          record.baseBranch !== labels.baseBranch
        )
          throw new PendingHostTaskError('pending_host_task_uncertain');
        current();
        return publicRepositoryWorkspace(record);
      }
      if (facts.layout === 'standalone') {
        const live = this.db
          .prepare(
            `SELECT COUNT(*) AS count FROM repository_workspaces
          WHERE json_extract(record,'$.qualifiedLocalPreparation.allocationFacts.layout')='standalone'
            AND json_extract(record,'$.binding.accountId')=?
            AND json_extract(record,'$.state')!='discarded'
            AND NOT (COALESCE(json_extract(record,'$.retirement.receipt.state'),'')='retired'
              AND COALESCE(json_extract(record,'$.retirement.disposition'),'')!='restored')`,
          )
          .get(request.binding.accountId) as { count: number };
        if (live.count >= 8)
          throw Error(
            'Local repository preparation limit reached; resume or retire an existing task',
          );
      }
      const selection: OrdinaryRepositoryRuntimeSelection = {
        runOn: 'local',
        runtime: {
          account: request.runtimeBinding.account,
          harness: 'codex',
          targetId: request.runtimeBinding.execution.targetId,
        },
      };
      const proof = OrdinaryRepositoryPreparationSchema.parse(
        await this.deps.ordinaryPreparation?.capture(request.binding, selection, signal),
      );
      current();
      if (
        !isDeepStrictEqual(proof.originalBinding, request.binding) ||
        !isDeepStrictEqual(proof.runtimeBinding, request.runtimeBinding)
      )
        throw new PendingHostTaskError('pending_host_task_ownership_changed');
      await revalidate();
      const record: RepositoryWorkspace = {
        id: request.id,
        connectionId: 'local',
        connectionRevision: 0,
        repository: `local/${repositoryId}`,
        binding: request.binding,
        baseBranch: labels.baseBranch,
        baseOid: labels.baseOid,
        featureBranch: facts.featureBranch,
        state: 'ready',
        createdAt: Date.now(),
        previewIntentFingerprint: fingerprint,
        localSource,
        sourceDigest: digest,
        ordinaryPreparation: { ...proof, sourceIdentity: localSource.root },
        qualifiedLocalPreparation,
      };
      current();
      this.db
        .prepare(
          'INSERT INTO repository_workspaces(id,record,conversation_id) VALUES(?,?,NULL) ON CONFLICT(id) DO NOTHING',
        )
        .run(request.id, JSON.stringify(record));
      const actual = this.getHostRecord(request.id);
      if (!isDeepStrictEqual(actual, record))
        throw new PendingHostTaskError('pending_host_task_ownership_changed');
      current();
      return publicRepositoryWorkspace(actual);
    });
  }
  private async selectLocalRepositorySource(
    binding: AccountBinding,
    repositoryId: string,
    selection: OrdinaryRepositoryRuntimeSelection,
    signal: AbortSignal,
    requestId: string,
    startPoint?: string,
    existingPath?: string,
  ) {
    return this.runOperation(async () => {
      const id = z.uuid().parse(requestId);
      binding = AccountBindingSchema.parse(structuredClone(binding));
      selection = OrdinaryRepositoryRuntimeSelectionSchema.parse(structuredClone(selection));
      if (selection.runOn !== 'local') throw Error('Local repositories require the Mac host');
      const configured = this.deps.localRepositories?.();
      const path =
        existingPath ??
        (configured && Object.hasOwn(configured, repositoryId)
          ? configured[repositoryId]
          : undefined);
      if (!path || !/^[A-Za-z0-9._-]+$/.test(repositoryId))
        throw Error('Choose a configured local repository');
      const fingerprint = ordinaryPreparationFingerprint({
        binding,
        repositoryId,
        path,
        selection,
        startPoint: startPoint ?? null,
        ...(existingPath ? { sourceSelection: 'existing' } : {}),
      });
      const retained = this.db.prepare('SELECT id FROM repository_workspaces WHERE id=?').get(id);
      if (retained) {
        const record = this.get(id);
        if (record.qualifiedLocalPreparation)
          throw new PendingHostTaskError('pending_host_task_access_required');
        if (!record.localSource || record.previewIntentFingerprint !== fingerprint)
          throw Error('Original local repository selection changed');
        await this.authorize(record, binding, signal);
        this.assertUnchangedHostRecord(record);
        return publicRepositoryWorkspace(record);
      }
      signal.throwIfAborted();
      if (existingPath) await this.assertExistingLocalRepositoryAccess(path, binding, signal);
      // Source refresh and runtime qualification have independent inputs. Join
      // them before constructing the record; the fresh authorization below
      // still rechecks both authorities before anything is published.
      const preparation = new AbortController();
      const captureSignal = AbortSignal.any([signal, preparation.signal]);
      const captures = [
        captureLocalRepository(repositoryId, path, captureSignal, startPoint),
        Promise.resolve().then(async () => {
          captureSignal.throwIfAborted();
          return OrdinaryRepositoryPreparationSchema.parse(
            await this.deps.ordinaryPreparation?.capture(binding, selection, captureSignal),
          );
        }),
      ] as const;
      const [source, proof] = await Promise.all(captures).catch(async (error: unknown) => {
        preparation.abort(error);
        await Promise.allSettled(captures);
        throw error;
      });
      if (
        !isDeepStrictEqual(proof.originalBinding, binding) ||
        proof.runtimeBinding.execution.location !== 'local' ||
        !isDeepStrictEqual(proof.runtimeBinding.account, selection.runtime.account) ||
        proof.runtimeBinding.harness.implementation !== selection.runtime.harness ||
        proof.runtimeBinding.execution.targetId !== selection.runtime.targetId
      )
        throw Error('Original local repository runtime required');
      const record: RepositoryWorkspace = {
        ...source,
        ...(existingPath ? { localSource: { ...source.localSource, selection: 'existing' } } : {}),
        id,
        repository: `local/${repositoryId.toLowerCase()}`,
        connectionId: 'local',
        connectionRevision: 0,
        binding,
        featureBranch: `mitzo/repo-${id}`,
        state: 'ready',
        createdAt: Date.now(),
        previewIntentFingerprint: fingerprint,
        sourceDigest: ordinaryPreparationFingerprint(source),
        ordinaryPreparation: { ...proof, sourceIdentity: source.localSource.root },
      };
      await this.authorize(record, binding, signal);
      signal.throwIfAborted();
      this.db
        .prepare(
          'INSERT INTO repository_workspaces(id,record,conversation_id) VALUES(?,?,NULL) ON CONFLICT(id) DO NOTHING',
        )
        .run(id, JSON.stringify(record));
      const current = this.getHostRecord(id);
      if (!isDeepStrictEqual(record, current)) throw Error('Local repository selection changed');
      return publicRepositoryWorkspace(current);
    });
  }
  async preview(
    binding: AccountBinding,
    connectionId: string,
    selected: string,
    signal: AbortSignal,
    ordinaryRuntime?: OrdinaryRepositoryRuntimeSelection,
    requestId?: string,
  ) {
    return this.runOperation(async () => {
      // Persist the caller-known identity in this existing owner row. Snapshot
      // the parsed intent before any asynchronous metadata/authorization work.
      const id = requestId === undefined ? randomUUID() : z.uuid().parse(requestId);
      binding =
        requestId === undefined ? structuredClone(binding) : AccountBindingSchema.parse(binding);
      ordinaryRuntime =
        ordinaryRuntime === undefined
          ? undefined
          : OrdinaryRepositoryRuntimeSelectionSchema.parse(ordinaryRuntime);
      const repository = canonicalRepositorySelection(selected);
      const fingerprint = ordinaryPreparationFingerprint({
        binding,
        connectionId,
        repository,
        ordinaryRuntime: ordinaryRuntime ?? null,
      });
      const assertIntent = (record: RepositoryWorkspace) => {
        if (
          record.id !== id ||
          record.featureBranch !== `mitzo/repo-${id}` ||
          record.previewIntentFingerprint !== fingerprint ||
          record.connectionId !== connectionId ||
          record.repository !== repository ||
          !isDeepStrictEqual(record.binding, binding) ||
          (ordinaryRuntime === undefined
            ? record.ordinaryPreparation !== undefined
            : !record.ordinaryPreparation ||
              !isDeepStrictEqual(record.ordinaryPreparation.originalBinding, binding) ||
              !isDeepStrictEqual(
                record.ordinaryPreparation.runtimeBinding.account,
                ordinaryRuntime.runtime.account,
              ) ||
              record.ordinaryPreparation.runtimeBinding.harness.implementation !==
                ordinaryRuntime.runtime.harness ||
              record.ordinaryPreparation.runtimeBinding.execution.location !==
                ordinaryRuntime.runOn ||
              record.ordinaryPreparation.runtimeBinding.execution.targetId !==
                ordinaryRuntime.runtime.targetId)
        )
          throw new Error('Repository preview identity conflict; preserve the original selection');
      };
      const recover = async (record: RepositoryWorkspace) => {
        assertIntent(record);
        await this.authorize(record, binding, signal);
        this.assertUnchangedHostRecord(record);
        return publicRepositoryWorkspace(record);
      };
      if (requestId !== undefined) {
        const retained = this.db.prepare('SELECT id FROM repository_workspaces WHERE id=?').get(id);
        if (retained) return recover(this.getHostRecord(id));
      }
      const authorized = await this.deps.authorize(binding, connectionId, repository, signal);
      const preview = GithubRepositoryPreviewSchema.parse(
        await (this.deps.inspect ?? inspectGithubRepositorySource)(repository, signal),
      );
      if (preview.repository !== repository)
        throw new Error('Repository preview selection changed');
      const record: RepositoryWorkspace = {
        ...preview,
        id,
        connectionId,
        connectionRevision: authorized.revision,
        binding: structuredClone(binding),
        featureBranch: '',
        state: 'preview',
        createdAt: Date.now(),
        ...(requestId === undefined ? {} : { previewIntentFingerprint: fingerprint }),
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
      if (requestId !== undefined) {
        assertIntent(record);
        // Metadata capture may overlap across processes. The first committed
        // owner wins; never upsert over its pin, proof or later lifecycle state.
        this.db
          .prepare(
            'INSERT INTO repository_workspaces(id,record,conversation_id) VALUES(?,?,NULL) ON CONFLICT(id) DO NOTHING',
          )
          .run(id, JSON.stringify(record));
        return recover(this.getHostRecord(id));
      }
      this.save(record);
      return publicRepositoryWorkspace(record);
    });
  }
  async prepare(id: string, binding: AccountBinding, signal: AbortSignal) {
    return this.runOperation(async () => {
      const record = this.get(id);
      if (record.retirement && record.retirement.disposition !== 'restored')
        throw Error('Repository preparation is retiring');
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
        if (error instanceof RepositorySpaceError) record.preparationFailure = 'repository_space';
        else if (error instanceof RepositorySourceLimitError)
          record.preparationFailure = 'repository_source_limit';
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
    hostRepositoryReservationSchema.shape.id.parse(snapshot.id);
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
        (record.localSource
          ? join(descriptor.hostReservation.taskRoot, `repo-${descriptor.id}`)
          : join(descriptor.hostReservation.taskRoot, `repo-${descriptor.id}`, 'mgmt')) ||
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
    if (record.id !== id || row.conversation_id !== primaryConversation(record))
      throw new Error('Host repository ledger identity changed');
    return record;
  }
  /** Pure JSON decoding only, private to the two synchronous readonly consumers.
   * Every call still reads SQL and checks its current identity/pointer. Public
   * mutable row reads keep the original fresh JSON.parse path above. */
  private getReadonlyHostRecord(id: string): RepositoryWorkspace {
    const row = this.db
      .prepare('SELECT record, conversation_id FROM repository_workspaces WHERE id=?')
      .get(id) as { record: string; conversation_id: string | null } | undefined;
    if (!row) throw new Error('Host repository reservation unavailable');
    const retained =
      typeof row.record === 'string' && this.readonlyLedgerProjection?.bytes === row.record
        ? this.readonlyLedgerProjection.record
        : undefined;
    const parsed: unknown = retained ?? JSON.parse(row.record);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Host repository ledger record is invalid');
    const record = parsed as RepositoryWorkspace;
    if (record.id !== id || row.conversation_id !== primaryConversation(record))
      throw new Error('Host repository ledger identity changed');
    if (
      !retained &&
      typeof row.record === 'string' &&
      row.record.length <= 262144 &&
      Buffer.byteLength(row.record, 'utf8') <= 262144
    ) {
      // JSON.parse produced plain data with no accessors/proxies. Qualify the
      // entire graph before freezing anything; larger/deeper data uses the
      // original uncached result without introducing a new refusal.
      const objects: object[] = [],
        pending: Array<{ value: unknown; depth: number }> = [{ value: record, depth: 0 }];
      let eligible = true;
      while (pending.length) {
        const { value, depth } = pending.pop()!;
        if (depth > 32) {
          eligible = false;
          break;
        }
        if (value && typeof value === 'object') {
          if (objects.length >= 4096) {
            eligible = false;
            break;
          }
          objects.push(value);
          for (const child of Object.values(value))
            pending.push({ value: child, depth: depth + 1 });
        }
      }
      if (eligible) {
        for (const object of objects.reverse()) Object.freeze(object);
        this.readonlyLedgerProjection = { bytes: row.record, record };
      }
    }
    return record;
  }
  getHostReservation(
    input: Omit<HostRepositoryReservationInput, 'signal'>,
  ): HostRepositoryReservation {
    this.assertAvailable();
    const expected = this.snapshotHostInput(input);
    this.assertNoOrdinaryPrimary(expected.conversationId);
    const record = this.getReadonlyHostRecord(expected.id);
    if (record.retirement && record.retirement.disposition !== 'restored')
      throw Error('Repository task is archived or retiring');
    if (primaryConversation(record) !== expected.conversationId)
      throw Error('Historical repository ownership is not current custody');
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
    if (record.localSource) {
      await this.assertLocalSource(record, record.binding, signal);
      this.assertUnchangedHostRecord(record);
      return;
    }
    if ((await repositorySourceDigest(this.source(record))) !== record.sourceDigest)
      throw new Error('Prepared repository source changed');
    signal.throwIfAborted();
    this.assertUnchangedHostRecord(record);
  }
  private async verifyHostSource(record: RepositoryWorkspace, signal: AbortSignal) {
    await this.assertHostSource(record, signal);
    if (record.localSource) return;
    await this.deps.verify?.(structuredClone(record), this.source(record));
    signal.throwIfAborted();
    this.assertUnchangedHostRecord(record);
    await this.assertHostSource(record, signal);
  }
  /** Read-only qualification of an existing silent preparation. No reserve/claim or repair. */
  async qualifyPreparedHostSession(
    receipt: OrdinarySessionPreparationReceipt,
    binding: AccountBinding,
    signal: AbortSignal,
  ): Promise<void> {
    return this.runOperation(async () => {
      const record = this.getHostRecord(receipt.workspaceId);
      if (
        receipt.firstCommandId !== null ||
        receipt.workspaceId !== receipt.settings.repositoryWorkspaceId ||
        record.state !== 'reserved' ||
        !record.ordinaryPreparation ||
        !record.hostReservation ||
        record.sandbox !== false ||
        !isDeepStrictEqual(record.ordinaryFirstReservation, {
          conversationId: receipt.sessionId,
          binding,
          commandFingerprint: receipt.preparationFingerprint,
        })
      )
        throw Error('Original silent repository reservation unavailable');
      const reservation = {
        id: receipt.workspaceId,
        conversationId: receipt.sessionId,
        binding,
        taskRoot: record.hostReservation.taskRoot,
        runtimeBinding: receipt.settings.binding,
        commandFingerprint: receipt.preparationFingerprint,
      };
      this.getHostReservation(reservation);
      await this.firstBinding(record, reservation, signal);
      await this.authorizeHostRecord(record, binding, signal);
      await this.verifyHostSource(record, signal);
      await this.assertHostRoot(record.hostReservation);
      signal.throwIfAborted();
      this.assertUnchangedHostRecord(record);
      this.getHostReservation(reservation);
    });
  }
  adoptPreparedRepositoryTransition(
    input: PreparedRepositoryTransitionFacts,
    childCommandId: string,
    assertCurrentSync: () => void,
  ): void {
    this.assertAvailable();
    const facts = transitionFacts(input),
      request = facts.request;
    if (
      childCommandId !== transitionChildId(facts) ||
      facts.newWorkspace.id !== request.id ||
      facts.oldWorkspace.id === facts.newWorkspace.id ||
      facts.oldWorkspace.directory === facts.newWorkspace.directory
    )
      throw Error('Prepared repository transition child changed');
    this.db
      .transaction(() => {
        const record = this.pendingRecord(request),
          receipt = record.pendingHostTask;
        const raw = this.db
          .prepare('SELECT record,conversation_id FROM repository_workspaces WHERE id=?')
          .get(record.id) as { record: string; conversation_id: string | null };
        const decision = PendingHostTaskDecisionSchema.parse(record.pendingHostTaskDecision);
        const payload = pendingHostTaskDecisionPayload(request, decision.scope);
        if (
          pendingHostTaskDecisionHash(record) !== facts.materializedRecordSha256 ||
          raw.conversation_id !== null ||
          receipt?.state !== 'materialized' ||
          !receipt.taskIdentity ||
          !isDeepStrictEqual(receipt.request, request) ||
          decision.state !== 'consumed' ||
          !isDeepStrictEqual(decision.request, request) ||
          !isDeepStrictEqual(decision.scope.oldWorkspace, facts.oldWorkspace) ||
          decision.scopeSha256 !== pendingHostTaskDecisionHash(decision.scope) ||
          decision.scopeSha256 !== facts.consumedScopeSha256 ||
          decision.evidence.toolUseID !== request.prepareCallId ||
          decision.evidence.sessionId !== request.conversationId ||
          !isDeepStrictEqual(decision.evidence.input, payload) ||
          decision.evidence.inputSha256 !== pendingHostTaskDecisionHash(payload) ||
          facts.newWorkspace.directory !== receipt.directory ||
          facts.newWorkspace.featureBranch !== record.featureBranch ||
          facts.newWorkspace.baseOid !== record.baseOid ||
          !isDeepStrictEqual(facts.newWorkspace.taskIdentity, receipt.taskIdentity)
        )
          throw Error('Original materialized repository proof changed');
        const current = this.getForConversation(request.conversationId);
        let oldRecord: RepositoryWorkspace | undefined, oldRaw: string | undefined;
        let ordinaryRaw: string | undefined;
        if (facts.oldWorkspace.kind === 'repository') {
          if (
            !current ||
            current.id !== facts.oldWorkspace.id ||
            current.directory !== facts.oldWorkspace.directory ||
            current.state !== 'claimed' ||
            current.sandbox ||
            !isDeepStrictEqual(current.binding, request.binding)
          )
            throw Error('Original repository primary changed');
          oldRecord = this.getHostRecord(current.id);
          oldRaw = (
            this.db
              .prepare('SELECT record FROM repository_workspaces WHERE id=?')
              .get(current.id) as { record: string }
          ).record;
        } else {
          const old = this.getOrdinaryWorkspaceForConversation(request.conversationId);
          if (
            current ||
            !old ||
            old.id !== facts.oldWorkspace.id ||
            old.directory !== facts.oldWorkspace.directory ||
            old.state !== 'claimed' ||
            !isDeepStrictEqual(old.binding, request.binding) ||
            !isDeepStrictEqual(old.settings.binding, request.runtimeBinding)
          )
            throw Error('Original ordinary primary changed');
          ordinaryRaw = (
            this.db.prepare('SELECT record FROM ordinary_workspaces WHERE id=?').get(old.id) as {
              record: string;
            }
          ).record;
        }
        const next: RepositoryWorkspace = {
          ...record,
          state: 'claimed',
          conversationId: request.conversationId,
          directory: receipt.directory,
          sandbox: false,
          taskIdentity: structuredClone(receipt.taskIdentity),
          hostReservation: {
            version: 1,
            taskRoot: request.taskRoot,
            rootIdentity: structuredClone(receipt.rootIdentity),
          },
          primaryDisposition: {
            version: 1,
            revision: (record.primaryDisposition?.revision ?? 0) + 1,
            currentConversationId: request.conversationId,
          },
          preparedRepositoryTransitionAdoption: {
            version: 1,
            childCommandId,
            factsSha256: pendingHostTaskDecisionHash(facts),
            materializedRecord: raw.record,
            facts,
          },
        };
        primaryDispositionSchema.parse(next.primaryDisposition);
        transitionAdoptionSchema.parse(next.preparedRepositoryTransitionAdoption);
        const checked: unknown = assertCurrentSync();
        if (checked !== undefined) {
          void Promise.resolve(checked).catch(() => {});
          throw Error('Synchronous fresh transition authority required');
        }
        // No awaits: guarded predicates remain authoritative even if the callback
        // reenters this same database and changes a selected row or current pointer.
        if (oldRecord) {
          const retired: RepositoryWorkspace = {
            ...oldRecord,
            primaryDisposition: {
              version: 1,
              revision: (oldRecord.primaryDisposition?.revision ?? 0) + 1,
              currentConversationId: null,
            },
          };
          primaryDispositionSchema.parse(retired.primaryDisposition);
          const changed = this.db
            .prepare(
              'UPDATE repository_workspaces SET record=?,conversation_id=NULL WHERE id=? AND record=? AND conversation_id=?',
            )
            .run(JSON.stringify(retired), oldRecord.id, oldRaw, request.conversationId);
          if (changed.changes !== 1)
            throw Error('Original primary custody changed before transfer');
        } else {
          const old = this.db
            .prepare('SELECT record,conversation_id FROM ordinary_workspaces WHERE id=?')
            .get(facts.oldWorkspace.id) as { record: string; conversation_id: string } | undefined;
          if (!old || old.record !== ordinaryRaw || old.conversation_id !== request.conversationId)
            throw Error('Original ordinary custody changed before transfer');
          const historical = JSON.parse(old.record) as ReturnType<OrdinaryWorkspaceCustody['get']>;
          const retired = {
            ...historical,
            primaryDisposition: {
              version: 1,
              revision: (historical.primaryDisposition?.revision ?? 0) + 1,
              currentConversationId: null,
            },
          };
          const changed = this.db
            .prepare(
              'UPDATE ordinary_workspaces SET record=?,conversation_id=NULL WHERE id=? AND record=? AND conversation_id=?',
            )
            .run(
              JSON.stringify(retired),
              facts.oldWorkspace.id,
              ordinaryRaw,
              request.conversationId,
            );
          if (changed.changes !== 1)
            throw Error('Original ordinary custody changed before transfer');
        }
        const changed = this.db
          .prepare(
            `UPDATE repository_workspaces SET record=?,conversation_id=? WHERE id=? AND record=? AND conversation_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM repository_workspaces WHERE conversation_id=?)
        AND NOT EXISTS(SELECT 1 FROM ordinary_workspaces WHERE conversation_id=?)`,
          )
          .run(
            JSON.stringify(next),
            request.conversationId,
            record.id,
            raw.record,
            request.conversationId,
            request.conversationId,
          );
        if (changed.changes !== 1) throw Error('Materialized custody changed before transfer');
      })
      .immediate();
  }
  /** Persisted custody assertion only. It never reads task files, supplies a
   * filesystem grant, consumes native admission, or replays a partial effect. */
  assertPreparedRepositoryTransitionAdopted(
    input: PreparedRepositoryTransitionFacts,
    childCommandId: string,
  ): void {
    this.assertAvailable();
    const facts = transitionFacts(input),
      request = facts.request;
    if (childCommandId !== transitionChildId(facts))
      throw Error('Prepared repository child changed');
    const record = this.getReadonlyHostRecord(facts.newWorkspace.id),
      currentMarker = record.preparedRepositoryTransitionAdoption,
      currentFacts =
        currentMarker && typeof currentMarker === 'object'
          ? Object.getOwnPropertyDescriptor(currentMarker, 'facts')
          : undefined;
    // This marker comes only from the freshly read SQL row bytes above.
    // Exact equality to the fully validated immutable facts proves their pure
    // schema refinements without rebuilding that equal tree. Validate every
    // header/byte bound afresh; mismatches retain complete validation/refusal.
    const marker =
      currentFacts && 'value' in currentFacts && isDeepStrictEqual(currentFacts.value, facts)
        ? equalFactsAdoptionSchema.parse(currentMarker)
        : transitionAdoptionSchema.parse(currentMarker);
    const receipt = PendingHostTaskReceiptSchema.parse(record.pendingHostTask),
      decision = PendingHostTaskDecisionSchema.parse(record.pendingHostTaskDecision);
    if (
      !isDeepStrictEqual(
        retainedOriginalFields(record),
        materializedOriginalFields(facts, marker.materializedRecord),
      ) ||
      (record.sourceReleased !== undefined && typeof record.sourceReleased !== 'boolean')
    )
      throw Error('Original materialized custody record changed');
    const currentTaskIdentity = restoredRepositoryTaskIdentity(
      record,
      facts.newWorkspace.taskIdentity,
    );
    const payload = pendingHostTaskDecisionPayload(request, decision.scope);
    if (
      record.state !== 'claimed' ||
      record.sandbox ||
      primaryConversation(record) !== request.conversationId ||
      this.getForConversation(request.conversationId)?.id !== record.id ||
      record.conversationId !== request.conversationId ||
      !isDeepStrictEqual(record.binding, request.binding) ||
      !isDeepStrictEqual(record.ordinaryPreparation?.runtimeBinding, request.runtimeBinding) ||
      !isDeepStrictEqual(marker, {
        version: 1,
        childCommandId,
        factsSha256: immutableTransitionProjections.get(facts)!.sha256,
        materializedRecord: marker.materializedRecord,
        facts,
      }) ||
      receipt.state !== 'materialized' ||
      !isDeepStrictEqual(receipt.request, request) ||
      !isDeepStrictEqual(receipt.taskIdentity, facts.newWorkspace.taskIdentity) ||
      record.directory !== facts.newWorkspace.directory ||
      record.featureBranch !== facts.newWorkspace.featureBranch ||
      record.baseOid !== facts.newWorkspace.baseOid ||
      !isDeepStrictEqual(record.taskIdentity, currentTaskIdentity) ||
      decision.state !== 'consumed' ||
      !isDeepStrictEqual(decision.request, request) ||
      !isDeepStrictEqual(decision.scope.oldWorkspace, facts.oldWorkspace) ||
      decision.scopeSha256 !== facts.consumedScopeSha256 ||
      decision.scopeSha256 !== pendingHostTaskDecisionHash(decision.scope) ||
      decision.evidence.toolUseID !== request.prepareCallId ||
      decision.evidence.sessionId !== request.conversationId ||
      !isDeepStrictEqual(decision.evidence.input, payload) ||
      decision.evidence.inputSha256 !== pendingHostTaskDecisionHash(payload) ||
      record.hostReservation?.taskRoot !== request.taskRoot ||
      !isDeepStrictEqual(record.hostReservation.rootIdentity, receipt.rootIdentity)
    )
      throw Error('Adopted repository custody witness unavailable');
    this.getHostReservation({
      id: record.id,
      binding: request.binding,
      conversationId: request.conversationId,
      taskRoot: request.taskRoot,
      runtimeBinding: request.runtimeBinding,
    });
  }
  private snapshotPendingInput(input: PendingHostTaskRequest): PendingHostTaskRequest {
    try {
      return freezePendingHostTaskData(PendingHostTaskRequestSchema.parse(structuredClone(input)));
    } catch {
      throw new PendingHostTaskError('pending_host_task_invalid_input');
    }
  }
  private pendingRecord(request: PendingHostTaskRequest) {
    const record = this.getHostRecord(request.id);
    if (record.retirement && record.retirement.disposition !== 'restored')
      throw Error('Repository preparation is retiring');
    const qualified = record.qualifiedLocalPreparation;
    if (
      qualified &&
      (qualified.version !== 1 ||
        !isDeepStrictEqual(qualified.request, request) ||
        qualified.allocationFacts.version !== 1 ||
        qualified.allocationFacts.workspaceId !== request.id ||
        qualified.allocationFacts.taskRoot.rootPath !== request.taskRoot ||
        qualified.allocationFacts.source.qualification !== 'preparation' ||
        qualified.allocationFacts.source.referenceCoverage !==
          'preparation-head-and-namespace-v1' ||
        qualified.allocationFactsSha256 !== record.sourceDigest ||
        qualified.allocationFactsSha256 !== pendingHostTaskDecisionHash(qualified.allocationFacts))
    )
      throw new PendingHostTaskError('pending_host_task_ownership_changed');
    if (
      record.state !== 'ready' ||
      !record.localSource ||
      record.localSource.selection !== 'existing' ||
      !record.sourceDigest ||
      record.featureBranch !== `mitzo/repo-${record.id}` ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(record.baseOid) ||
      record.sourceReleased ||
      record.hostReservation ||
      record.ordinaryFirstReservation ||
      record.conversationId !== undefined ||
      record.directory !== undefined ||
      record.sandbox !== undefined ||
      record.taskIdentity ||
      !isDeepStrictEqual(record.binding, request.binding) ||
      !isDeepStrictEqual(record.ordinaryPreparation?.runtimeBinding, request.runtimeBinding)
    )
      throw new PendingHostTaskError('pending_host_task_ownership_changed');
    if (record.pendingHostTask) {
      const receipt = PendingHostTaskReceiptSchema.parse(structuredClone(record.pendingHostTask));
      if (
        !isDeepStrictEqual(receipt.request, request) ||
        receipt.sourceDigest !== record.sourceDigest ||
        receipt.directory !== join(request.taskRoot, `repo-${record.id}`) ||
        (receipt.taskIdentity !== undefined &&
          (receipt.taskIdentity.directory !== receipt.directory ||
            receipt.taskIdentity.featureBranch !== record.featureBranch ||
            !isDeepStrictEqual(receipt.taskIdentity.localSource, record.localSource)))
      )
        throw new PendingHostTaskError('pending_host_task_ownership_changed');
    }
    return record;
  }
  private assertDecisionOwner(
    request: PendingHostTaskRequest,
    owner: PendingHostTaskDecisionOwner,
  ) {
    const context = owner.context;
    context.signal.throwIfAborted();
    for (const assertion of [() => context.assertCurrentSync(), () => owner.assertCurrentSync()]) {
      const returned: unknown = assertion();
      if (returned !== undefined) {
        void Promise.resolve(returned).catch(() => {});
        throw new PendingHostTaskError('pending_host_task_authority_required');
      }
    }
    const destination =
      context.workspace.kind === 'ordinary'
        ? this.getOrdinaryWorkspaceForConversation(context.conversationId)
        : this.getForConversation(context.conversationId);
    if (!destination?.hostReservation)
      throw new PendingHostTaskError('pending_host_task_access_required');
    if (
      context.toolName !== 'PrepareLocalRepository' ||
      context.conversationId !== request.conversationId ||
      context.runtimeId !== request.runtimeId ||
      context.callId !== request.prepareCallId ||
      context.requestHash !== request.requestHash ||
      !isDeepStrictEqual(context.nativeTarget, request.nativeTarget) ||
      !isDeepStrictEqual(context.session.accountBinding, request.binding) ||
      destination.id !== context.workspace.id ||
      destination.directory !== context.workspace.directory ||
      destination.hostReservation.taskRoot !== request.taskRoot ||
      !isDeepStrictEqual(destination.binding, request.binding)
    )
      throw new PendingHostTaskError('pending_host_task_ownership_changed');
    return destination.hostReservation;
  }
  private decisionScope(
    record: RepositoryWorkspace,
    request: PendingHostTaskRequest,
    input: PendingHostTaskDecisionScope,
    owner: PendingHostTaskDecisionOwner,
  ) {
    const scope = PendingHostTaskDecisionScopeSchema.parse(structuredClone(input));
    const root = this.assertDecisionOwner(request, owner);
    const expected = {
      kind: 'local-repository-worktree',
      workspaceId: record.id,
      featureBranch: record.featureBranch,
      baseOid: record.baseOid,
      source: scope.create.source,
      task: {
        taskRoot: request.taskRoot,
        directory: join(request.taskRoot, `repo-${record.id}`),
        adminBasename: `repo-${record.id}`,
      },
    };
    const common = record.localSource!.commonDirectory;
    const taskGit =
      record.qualifiedLocalPreparation?.allocationFacts.layout === 'standalone'
        ? join(request.taskRoot, `repo-${record.id}`, '.git')
        : undefined;
    const branchRef = join(taskGit ?? common, 'refs', 'heads', record.featureBranch);
    const qualified = record.qualifiedLocalPreparation;
    if (
      ((qualified !== undefined || scope.allocationFactsSha256 !== undefined) &&
        (!qualified ||
          !isDeepStrictEqual(qualified.request, request) ||
          !isDeepStrictEqual(qualified.oldWorkspace, scope.oldWorkspace) ||
          scope.referenceCoverage !== 'preparation-head-and-namespace-v1' ||
          scope.allocationFactsSha256 !== qualified.allocationFactsSha256)) ||
      (scope.oldWorkspace !== undefined &&
        !isDeepStrictEqual(scope.oldWorkspace, owner.context.workspace)) ||
      !isDeepStrictEqual(scope.create, { ...expected, intent: 'create' }) ||
      !isDeepStrictEqual(scope.use, { ...expected, intent: 'use' }) ||
      scope.create.source.path !== record.localSource!.path ||
      scope.create.source.commonDirectory !== common ||
      !isDeepStrictEqual(scope.sourceIdentity, record.localSource) ||
      scope.sourceDigest !== record.sourceDigest ||
      !isDeepStrictEqual(scope.taskRootIdentity, root.rootIdentity) ||
      scope.layout !== (taskGit ? 'standalone' : undefined) ||
      !isDeepStrictEqual(scope.sourceGitEffects, {
        administrationDirectory: taskGit ?? join(common, 'worktrees', `repo-${record.id}`),
        branchReference: branchRef,
        branchReferenceLock: branchRef + '.lock',
        branchLog: join(taskGit ?? common, 'logs', 'refs', 'heads', record.featureBranch),
      })
    )
      throw new PendingHostTaskError('pending_host_task_ownership_changed');
    return freezePendingHostTaskData(scope);
  }
  private decisionEvidence(
    request: PendingHostTaskRequest,
    scope: PendingHostTaskDecisionScope,
    input: PendingHostTaskDecisionEvidence,
  ) {
    const evidence = PendingHostTaskDecisionEvidenceSchema.parse(structuredClone(input));
    const payload = pendingHostTaskDecisionPayload(request, scope);
    if (
      evidence.toolUseID !== request.prepareCallId ||
      evidence.sessionId !== request.conversationId ||
      evidence.expiresAt <= Date.now() ||
      !isDeepStrictEqual(evidence.input, payload) ||
      evidence.inputSha256 !== pendingHostTaskDecisionHash(payload)
    )
      throw new PendingHostTaskError('pending_host_task_authority_required');
    return freezePendingHostTaskData(evidence);
  }
  private updatePendingDecision(
    record: RepositoryWorkspace,
    decision: PendingHostTaskDecision,
    receipt = record.pendingHostTask,
  ) {
    const next: RepositoryWorkspace = {
      ...record,
      pendingHostTaskDecision: PendingHostTaskDecisionSchema.parse(structuredClone(decision)),
      ...(receipt
        ? { pendingHostTask: PendingHostTaskReceiptSchema.parse(structuredClone(receipt)) }
        : {}),
    };
    this.assertUnchangedHostRecord(record);
    const changed = this.db
      .prepare(
        'UPDATE repository_workspaces SET record=? WHERE id=? AND record=? AND conversation_id IS NULL',
      )
      .run(JSON.stringify(next), record.id, JSON.stringify(record));
    if (changed.changes !== 1)
      throw new PendingHostTaskError('pending_host_task_ownership_changed');
    return next;
  }
  /** Private metadata only. Observed evidence is historical and cannot authorize effects. */
  retainPendingHostTaskDecisionObservation(
    input: PendingHostTaskRequest,
    scopeInput: PendingHostTaskDecisionScope,
    evidenceInput: PendingHostTaskDecisionEvidence,
    owner: PendingHostTaskDecisionOwner,
  ): PendingHostTaskDecision {
    this.assertAvailable();
    const request = this.snapshotPendingInput(input);
    this.assertDecisionOwner(request, owner);
    const record = this.pendingRecord(request);
    const scope = this.decisionScope(record, request, scopeInput, owner);
    const evidence = this.decisionEvidence(request, scope, evidenceInput);
    const decision = PendingHostTaskDecisionSchema.parse({
      version: 1,
      request,
      scope,
      scopeSha256: pendingHostTaskDecisionHash(scope),
      evidence,
      state: 'observed',
    });
    if (record.pendingHostTaskDecision) {
      if (!isDeepStrictEqual(record.pendingHostTaskDecision, decision))
        throw new PendingHostTaskError('pending_host_task_uncertain');
      return freezePendingHostTaskData(structuredClone(decision));
    }
    this.assertDecisionOwner(request, owner);
    this.updatePendingDecision(record, decision);
    return freezePendingHostTaskData(structuredClone(decision));
  }
  /** Called only after actual handler allow plus asynchronous producer revalidation. */
  finalizePendingHostTaskDecision(
    input: PendingHostTaskRequest,
    scopeInput: PendingHostTaskDecisionScope,
    evidenceInput: PendingHostTaskDecisionEvidence,
    owner: PendingHostTaskDecisionOwner,
  ): PendingHostTaskDecision {
    const request = this.snapshotPendingInput(input);
    this.assertDecisionOwner(request, owner);
    const record = this.pendingRecord(request);
    const scope = this.decisionScope(record, request, scopeInput, owner);
    const evidence = this.decisionEvidence(request, scope, evidenceInput);
    const observed = PendingHostTaskDecisionSchema.parse({
      version: 1,
      request,
      scope,
      scopeSha256: pendingHostTaskDecisionHash(scope),
      evidence,
      state: 'observed',
    });
    if (!isDeepStrictEqual(record.pendingHostTaskDecision, observed))
      throw new PendingHostTaskError('pending_host_task_uncertain');
    const finalized = { ...observed, state: 'finalized' as const };
    this.assertDecisionOwner(request, owner);
    this.updatePendingDecision(record, finalized);
    return freezePendingHostTaskData(structuredClone(finalized));
  }
  /** One metadata transaction; no intermediate consumed decision without durable intent. */
  beginPendingHostTaskDecisionMaterialization(
    input: PendingHostTaskRequest,
    owner: PendingHostTaskDecisionOwner,
  ) {
    const request = this.snapshotPendingInput(input);
    const consumed = this.db
      .transaction(() => {
        this.assertDecisionOwner(request, owner);
        const record = this.pendingRecord(request);
        const decision = PendingHostTaskDecisionSchema.parse(record.pendingHostTaskDecision);
        this.decisionScope(record, request, decision.scope, owner);
        this.decisionEvidence(request, decision.scope, decision.evidence);
        if (
          decision.state !== 'finalized' ||
          !isDeepStrictEqual(decision.request, request) ||
          (record.pendingHostTask && record.pendingHostTask.state !== 'reserved')
        )
          throw new PendingHostTaskError('pending_host_task_uncertain');
        const receipt = PendingHostTaskReceiptSchema.parse({
          version: 1,
          request,
          rootIdentity: decision.scope.taskRootIdentity,
          directory: decision.scope.create.task.directory,
          sourceDigest: decision.scope.sourceDigest,
          state: 'materializing',
        });
        const next = { ...decision, state: 'consumed' as const };
        this.assertDecisionOwner(request, owner);
        this.updatePendingDecision(record, next, receipt);
        return freezePendingHostTaskData(structuredClone(next));
      })
      .immediate();
    const current = () => {
      this.assertDecisionOwner(request, owner);
      if (consumed.evidence.expiresAt <= Date.now())
        throw new PendingHostTaskError('pending_host_task_authority_required');
      const record = this.pendingRecord(request);
      this.decisionScope(record, request, consumed.scope, owner);
      if (
        !isDeepStrictEqual(record.pendingHostTaskDecision, consumed) ||
        !record.pendingHostTask ||
        !['materializing', 'materialized'].includes(record.pendingHostTask.state)
      )
        throw new PendingHostTaskError('pending_host_task_uncertain');
    };
    return new PendingHostTaskDecisionOperation(
      this,
      freezePendingHostTaskData(request),
      consumed.scope,
      current,
      async () => {
        current();
        await owner.assertCurrent();
        current();
      },
      owner.context,
      consumed.evidence.expiresAt,
      Object.getOwnPropertyDescriptor(owner, 'publicationPackedRefs')?.value,
    );
  }
  /** Qualified original permission only. No legacy ambient selector/worktree
   * engine, fake operation, implicit replay or primary attachment is admitted. */
  async materializeQualifiedPendingHostTask(
    input: PendingHostTaskRequest,
    operation: unknown,
    objects?: LocalRepositoryPreparationObjectData,
  ): Promise<PendingHostTaskReceipt> {
    if (!(operation instanceof PendingHostTaskDecisionOperation))
      throw new PendingHostTaskError('pending_host_task_authority_required');
    const request = this.snapshotPendingInput(input);
    operation.assertFor(this, request);
    const context = operation.contextFor(this, request);
    const publicationPackedRefs = operation.packedRefsFor(this, request);
    const record = this.pendingRecord(request),
      qualified = record.qualifiedLocalPreparation;
    if (
      !qualified ||
      !qualified.allocationFacts.existingDirectories ||
      qualified.publication ||
      !record.pendingHostTask ||
      record.pendingHostTask.state !== 'materializing' ||
      qualified.allocationFactsSha256 !== operation.scope.allocationFactsSha256 ||
      pendingHostTaskDecisionHash(qualified.allocationFacts) !== qualified.allocationFactsSha256
    )
      throw new PendingHostTaskError('pending_host_task_authority_required');
    const raw = this.db
      .prepare('SELECT record FROM repository_workspaces WHERE id=? AND conversation_id IS NULL')
      .get(request.id) as { record: string } | undefined;
    if (!raw || !isDeepStrictEqual(JSON.parse(raw.record), record))
      throw new PendingHostTaskError('pending_host_task_ownership_changed');
    operation.claim();
    try {
      const result = await materializeQualifiedLocalRepositoryTask({
        context,
        objects,
        publicationPackedRefs,
        facts: freezePendingHostTaskData(structuredClone(qualified.allocationFacts)),
        factsSha256: qualified.allocationFactsSha256,
        requestSha256: pendingHostTaskDecisionHash(request),
        scopeSha256: pendingHostTaskDecisionHash(operation.scope),
        expiresAt: operation.expiresAt,
        assertCurrentSync: () => operation.assertCurrentSync(),
        assertCurrent: () => operation.assertCurrent(),
      });
      const taskIdentity = freezePendingHostTaskData({
        ...result.taskIdentity,
        localSource: record.localSource!,
      });
      const receipt = PendingHostTaskReceiptSchema.parse({
        ...record.pendingHostTask,
        state: 'materialized',
        taskIdentity,
      });
      const next = {
        ...record,
        qualifiedLocalPreparation: { ...qualified, publication: result.publication },
        pendingHostTask: receipt,
      };
      const serialized = JSON.stringify(next);
      assertPreparedRepositoryMaterializedRecordBound(serialized);
      // Original consumed/current operation immediately precedes one exact RAW
      // row CAS. Creation publication and final receipt appear atomically.
      operation.assertCurrentSync();
      const changed = this.db
        .prepare(
          'UPDATE repository_workspaces SET record=? WHERE id=? AND record=? AND conversation_id IS NULL',
        )
        .run(serialized, request.id, raw.record);
      if (changed.changes !== 1)
        throw new PendingHostTaskError('pending_host_task_ownership_changed');
      operation.completePublication();
      return freezePendingHostTaskData(receipt);
    } catch (cause) {
      // Retain materializing/partial effects. Never replay, clean foreign data,
      // write after expiry, or infer current ownership from historical evidence.
      // Error.cause is private/nonenumerable; public code/message and durable
      // records remain unchanged. Offline fixtures can classify the real fault.
      throw new PendingHostTaskError('pending_host_task_uncertain', { cause });
    }
  }
  /** Pins host identity in the existing SQLite row, without creating destination files. */
  async reserveHostTask(input: HostRepositoryReservationInput): Promise<HostRepositoryReservation> {
    return this.runOperation(async () => {
      const expected = this.snapshotHostInput(input),
        signal = input.signal;
      signal.throwIfAborted();
      const record = this.getHostRecord(expected.id);
      if (record.qualifiedLocalPreparation)
        throw new PendingHostTaskError('pending_host_task_access_required');
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
        record.pendingHostTask !== undefined ||
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
      if (record.localSource) {
        await this.authorizeHostRecord(record, record.binding, signal);
        await mkdir(expected.taskRoot, { recursive: true, mode: 0o700 });
      }
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
        directory: record.localSource
          ? join(expected.taskRoot, `repo-${record.id}`)
          : join(expected.taskRoot, `repo-${record.id}`, 'mgmt'),
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
        record.pendingHostTask ||
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
        return {
          ...record,
          ...(!record.localSource && !record.sourceReleased ? { seed: this.source(record) } : {}),
        };
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
      if (!record.localSource)
        await mkdir(join(expected.taskRoot, `repo-${record.id}`), { mode: 0o700 });
      await this.assertHostRoot(descriptor.hostReservation);
      this.assertUnchangedHostRecord(claiming);
      signal.throwIfAborted();
      if (record.localSource) {
        await createWorktreeAsync(`repo-${record.id}`, record.localSource.path, {
          dir: expected.taskRoot,
          branch: record.featureBranch,
          startPoint: record.baseOid,
          ...(record.localSource.selection === 'existing' ? { safeLocalPreparation: true } : {}),
        });
        // An arbitrary repository's config cannot expand access through shared
        // runtime links. Dependency preparation remains an explicit task action.
        if (record.localSource.selection !== 'existing')
          symlinkRuntimeDirs(
            record.localSource.path,
            descriptor.directory,
            loadRepoConfig(record.localSource.path).runtimeSymlinks,
          );
      } else await copyRepositoryTaskCheckout(this.source(record), descriptor.directory, signal);
      if (
        !record.localSource &&
        (await repositorySourceDigest(descriptor.directory)) !== record.sourceDigest
      )
        throw new Error('Task repository copy changed');
      this.assertUnchangedHostRecord(claiming);
      const taskIdentity = await snapshotRepositoryTaskCheckout(
        descriptor.directory,
        record.featureBranch,
        record.localSource,
      );
      this.assertUnchangedHostRecord(claiming);
      await this.authorizeHostRecord(claiming, expected.binding, signal);
      await this.assertHostRoot(descriptor.hostReservation);
      // Initial readiness requires the exact copied source, unlike later retained
      // retries where legitimate edits are preserved. No callback may replace it.
      if (
        !record.localSource &&
        (await repositorySourceDigest(descriptor.directory)) !== record.sourceDigest
      )
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
      return { ...claimed, ...(!claimed.localSource ? { seed: this.source(claimed) } : {}) };
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
      if (record.qualifiedLocalPreparation)
        throw new PendingHostTaskError('pending_host_task_access_required');
      if (record.hostReservation !== undefined || record.pendingHostTask !== undefined)
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
        if (primaryConversation(record) !== conversationId)
          throw Error('Historical repository claim is not current custody');
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
      const claimingRecord = JSON.stringify(record);
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
      this.save(record, claimingRecord);
      return { ...record, seed: this.source(record) };
    });
  }
}
