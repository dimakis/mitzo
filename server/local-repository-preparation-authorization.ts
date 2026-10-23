import { buildPermissionHandler, type SessionRegistry } from '@mitzo/harness';
import { AccountBindingSchema, SessionRuntimeBindingV2Schema } from '@mitzo/protocol';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { EventStore } from './event-store.js';
import type { NativeHostToolContext } from './native-host-tool-context.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';
import {
  PendingHostTaskError,
  PendingHostTaskRequestSchema,
  PendingHostTaskDecisionScopeSchema,
  PendingHostTaskDecisionSchema,
  PendingHostTaskDecisionEvidenceSchema,
  pendingHostTaskDecisionHash,
  pendingHostTaskDecisionPayload,
  freezePendingHostTaskData,
  type PendingHostTaskDecision,
  type PendingHostTaskDecisionOwner,
} from './pending-host-task.js';

const inputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine((path) => isAbsolute(path) && resolve(path) === path),
});
interface Identity {
  readonly dev: number;
  readonly ino: number;
}
/** Required actual read owner. No ambient/default implementation is installed.
 * Anchors are captured by that owner's bounded, authorized physical read path.
 * A hash/copy here is correlation, never an OS or product filesystem grant. */
export interface QualifiedLocalRepositoryPreparationSource {
  readonly source: Readonly<{
    path: string;
    gitDirectory: string;
    commonDirectory: string;
    root: Identity;
    commonRoot: Identity;
  }>;
  readonly anchorsSha256: string;
  readonly referenceCoverage?: 'preparation-head-and-namespace-v1';
  assertCurrentSync(): void;
  assertCurrent(): Promise<void>;
}
interface Owners {
  readonly context: NativeHostToolContext;
  readonly events: Pick<EventStore, 'getSessionRuntimeBinding'>;
  readonly registry: SessionRegistry;
  readonly workspaces: RepositoryWorkspaces;
  readonly qualifySource: (
    path: string,
    context: NativeHostToolContext,
  ) => Promise<QualifiedLocalRepositoryPreparationSource>;
}
const accountScope = (account: {
  accountId: string;
  provider: string;
  model: string;
  profileRevision: string;
}) => ({
  accountId: account.accountId,
  provider: account.provider,
  model: account.model,
  profileRevision: account.profileRevision,
});
function synchronous(assertion: () => unknown) {
  const result = assertion();
  if (result === undefined) return;
  void Promise.resolve(result).catch(() => {});
  throw new PendingHostTaskError('pending_host_task_authority_required');
}
/** Existing allocation-row correlation only; no new permission identifier/ledger. */
function selectionId(value: unknown) {
  const hash = pendingHostTaskDecisionHash(['local-repository-selection-v1', value]);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Private composition only. Called with the ORIGINAL raw context captured by
 * the verified native callback before parsing model intent. No production tool,
 * allocation runner, native grant or fallback source/destination is registered. */
export async function captureLocalRepositoryPreparationAuthorization(
  owners: Owners,
  rawInput: unknown,
) {
  const context = owners.context;
  synchronous(() => context.assertCurrentSync());
  context.signal.throwIfAborted();
  if (context.toolName !== 'PrepareLocalRepository' || typeof owners.qualifySource !== 'function')
    throw new PendingHostTaskError('pending_host_task_access_required');
  let input: z.infer<typeof inputSchema>;
  try {
    input = freezePendingHostTaskData(inputSchema.parse(structuredClone(rawInput)));
    if (pendingHostTaskDecisionHash(rawInput) !== context.requestHash)
      throw new Error('Original native input changed');
  } catch {
    throw new PendingHostTaskError('pending_host_task_invalid_input');
  }
  const binding = freezePendingHostTaskData(
    AccountBindingSchema.parse(structuredClone(context.session.accountBinding)),
  );
  const runtimeBinding = freezePendingHostTaskData(
    SessionRuntimeBindingV2Schema.parse(
      structuredClone(owners.events.getSessionRuntimeBinding(context.conversationId)),
    ),
  );
  if (
    !isDeepStrictEqual(accountScope(binding), context.accountBinding) ||
    !isDeepStrictEqual(runtimeBinding.account, {
      accountId: binding.accountId,
      provider: binding.provider,
      profileRevision: binding.profileRevision,
    }) ||
    runtimeBinding.harness.implementation !== 'codex' ||
    runtimeBinding.execution.location !== 'local'
  )
    throw new PendingHostTaskError('pending_host_task_ownership_changed');
  const destination = () =>
    context.workspace.kind === 'ordinary'
      ? owners.workspaces.getOrdinaryWorkspaceForConversation(context.conversationId)
      : owners.workspaces.getForConversation(context.conversationId);
  const initialDestination = destination();
  if (!initialDestination?.hostReservation)
    throw new PendingHostTaskError('pending_host_task_access_required');
  if (
    initialDestination.id !== context.workspace.id ||
    initialDestination.directory !== context.workspace.directory ||
    !isDeepStrictEqual(initialDestination.binding, binding)
  )
    throw new PendingHostTaskError('pending_host_task_ownership_changed');
  const hostReservation = freezePendingHostTaskData(
    structuredClone(initialDestination.hostReservation),
  );
  const assertOriginal = () => {
    context.signal.throwIfAborted();
    synchronous(() => context.assertCurrentSync());
    const current = destination();
    if (
      !current ||
      current.id !== initialDestination.id ||
      current.directory !== context.workspace.directory ||
      !isDeepStrictEqual(current.hostReservation, hostReservation) ||
      !isDeepStrictEqual(current.binding, binding) ||
      !isDeepStrictEqual(context.session.accountBinding, binding) ||
      !isDeepStrictEqual(
        owners.events.getSessionRuntimeBinding(context.conversationId),
        runtimeBinding,
      )
    )
      throw new PendingHostTaskError('pending_host_task_ownership_changed');
  };
  assertOriginal();
  await context.assertCurrent();
  assertOriginal();
  const qualified = await owners.qualifySource(input.path, context);
  assertOriginal();
  if (
    !qualified ||
    typeof qualified.assertCurrentSync !== 'function' ||
    typeof qualified.assertCurrent !== 'function'
  )
    throw new PendingHostTaskError('pending_host_task_access_required');
  const source = freezePendingHostTaskData(structuredClone(qualified.source));
  const anchorsSha256 = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(qualified.anchorsSha256);
  const referenceCoverage = z
    .literal('preparation-head-and-namespace-v1')
    .optional()
    .parse(qualified.referenceCoverage);
  if (source.path !== input.path)
    throw new PendingHostTaskError('pending_host_task_ownership_changed');
  const assertSourceLabels = () => {
    assertOriginal();
    synchronous(() => qualified.assertCurrentSync());
    assertOriginal();
    if (
      qualified.anchorsSha256 !== anchorsSha256 ||
      qualified.referenceCoverage !== referenceCoverage ||
      !isDeepStrictEqual(qualified.source, source)
    )
      throw new PendingHostTaskError('pending_host_task_ownership_changed');
  };
  synchronous(() => qualified.assertCurrentSync());
  assertSourceLabels();
  await qualified.assertCurrent();
  assertSourceLabels();
  const id = selectionId({
    conversationId: context.conversationId,
    runtimeId: context.runtimeId,
    nativeTarget: context.nativeTarget,
    callId: context.callId,
    requestHash: context.requestHash,
  });
  const selected = await owners.workspaces.selectExistingLocalRepository(
    binding,
    input.path,
    {
      runOn: 'local',
      runtime: {
        account: runtimeBinding.account,
        harness: 'codex',
        targetId: runtimeBinding.execution.targetId,
      },
    },
    context.signal,
    id,
  );
  assertSourceLabels();
  const originalRecord = owners.workspaces.get(selected.id);
  if (
    !originalRecord.localSource ||
    originalRecord.localSource.selection !== 'existing' ||
    originalRecord.localSource.path !== source.path ||
    originalRecord.localSource.commonDirectory !== source.commonDirectory ||
    !isDeepStrictEqual(originalRecord.localSource.root, source.root) ||
    !isDeepStrictEqual(originalRecord.localSource.commonRoot, source.commonRoot) ||
    !isDeepStrictEqual(originalRecord.ordinaryPreparation?.runtimeBinding, runtimeBinding) ||
    !originalRecord.sourceDigest
  )
    throw new PendingHostTaskError('pending_host_task_ownership_changed');
  const request = freezePendingHostTaskData(
    PendingHostTaskRequestSchema.parse({
      id,
      binding,
      runtimeBinding,
      conversationId: context.conversationId,
      runtimeId: context.runtimeId,
      nativeTarget: context.nativeTarget,
      prepareCallId: context.callId,
      requestHash: context.requestHash,
      taskRoot: hostReservation.taskRoot,
    }),
  );
  const baseScope = {
    kind: 'local-repository-worktree' as const,
    workspaceId: id,
    featureBranch: originalRecord.featureBranch,
    baseOid: originalRecord.baseOid,
    source: {
      path: source.path,
      gitDirectory: source.gitDirectory,
      commonDirectory: source.commonDirectory,
    },
    task: {
      taskRoot: request.taskRoot,
      directory: join(request.taskRoot, `repo-${id}`),
      adminBasename: `repo-${id}`,
    },
  };
  const branchRef = join(source.commonDirectory, 'refs', 'heads', originalRecord.featureBranch);
  const scope = freezePendingHostTaskData(
    PendingHostTaskDecisionScopeSchema.parse({
      version: 1,
      oldWorkspace: context.workspace,
      create: { ...baseScope, intent: 'create' },
      use: { ...baseScope, intent: 'use' },
      sourceIdentity: originalRecord.localSource,
      taskRootIdentity: hostReservation.rootIdentity,
      sourceDigest: originalRecord.sourceDigest,
      anchorsSha256,
      ...(referenceCoverage === undefined ? {} : { referenceCoverage }),
      sourceGitEffects: {
        administrationDirectory: join(source.commonDirectory, 'worktrees', `repo-${id}`),
        branchReference: branchRef,
        branchReferenceLock: branchRef + '.lock',
        branchLog: join(
          source.commonDirectory,
          'logs',
          'refs',
          'heads',
          originalRecord.featureBranch,
        ),
      },
    }),
  );
  const payload = pendingHostTaskDecisionPayload(request, scope);
  const payloadHash = pendingHostTaskDecisionHash(payload);
  const assertCurrentSync = () => {
    assertSourceLabels();
    const record = owners.workspaces.get(id);
    if (
      record.state !== 'ready' ||
      record.hostReservation ||
      record.sourceReleased ||
      record.featureBranch !== originalRecord.featureBranch ||
      record.baseOid !== originalRecord.baseOid ||
      record.sourceDigest !== originalRecord.sourceDigest ||
      !isDeepStrictEqual(record.localSource, originalRecord.localSource) ||
      !isDeepStrictEqual(record.binding, binding) ||
      !isDeepStrictEqual(record.ordinaryPreparation, originalRecord.ordinaryPreparation)
    )
      throw new PendingHostTaskError('pending_host_task_ownership_changed');
  };
  const owner: PendingHostTaskDecisionOwner = Object.freeze({
    context,
    assertCurrentSync,
    async assertCurrent() {
      assertCurrentSync();
      await context.assertCurrent();
      assertCurrentSync();
      await qualified.assertCurrent();
      assertCurrentSync();
      synchronous(() => qualified.assertCurrentSync());
      if (context.workspace.kind === 'ordinary')
        await owners.workspaces.validateOrdinaryWorkspace(
          context.conversationId,
          context.workspace.directory,
        );
      else
        await owners.workspaces.validateHostTask(
          context.conversationId,
          context.workspace.directory,
        );
      assertCurrentSync();
      await owners.workspaces.qualifiedStatus(id, binding);
      assertCurrentSync();
    },
  });
  await owner.assertCurrent();
  let approvalStarted = false;
  return Object.freeze({
    request,
    scope,
    payload,
    owner,
    async approve(): Promise<PendingHostTaskDecision> {
      owner.assertCurrentSync();
      if (approvalStarted) throw new PendingHostTaskError('pending_host_task_uncertain');
      approvalStarted = true;
      await owner.assertCurrent();
      let observed: PendingHostTaskDecision | undefined;
      const result = await buildPermissionHandler(context.clientId, owners.registry)(
        context.toolName,
        payload,
        {
          signal: context.signal,
          toolUseID: context.callId,
          forcePrompt: true,
          allowSessionGrant: false,
          rememberSessionGrant: false,
          approvalScope: 'request',
          onDecision(evidence) {
            owner.assertCurrentSync();
            const retained: unknown = owners.workspaces.retainPendingHostTaskDecisionObservation(
              request,
              scope,
              PendingHostTaskDecisionEvidenceSchema.parse(evidence),
              owner,
            );
            if (retained && typeof retained === 'object' && 'then' in retained) {
              void Promise.resolve(retained).catch(() => {});
              throw new PendingHostTaskError('pending_host_task_authority_required');
            }
            observed = PendingHostTaskDecisionSchema.parse(retained);
          },
        },
      );
      owner.assertCurrentSync();
      if (
        result.behavior !== 'allow' ||
        result.decisionClassification !== 'user_temporary' ||
        !observed ||
        !isDeepStrictEqual(result.updatedInput, payload) ||
        pendingHostTaskDecisionHash(result.updatedInput) !== payloadHash
      )
        throw new PendingHostTaskError('pending_host_task_authority_required');
      await owner.assertCurrent();
      owner.assertCurrentSync();
      return owners.workspaces.finalizePendingHostTaskDecision(
        request,
        scope,
        observed.evidence,
        owner,
      );
    },
  });
}
