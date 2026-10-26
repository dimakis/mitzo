import { ordinaryOperatorOwnsConversation } from './ordinary-operator-identity.js';
import { assembleSourceSnapshots } from './source-snapshot-context.js';
import {
  assertOrdinaryCodexContextIdentity,
  assertOrdinaryCodexSnapshotCustody,
} from './ordinary-codex-agent-context.js';
import { openShellPhysicalCustodyFingerprint } from './openshell-codex-custody.js';
import { canonicalJson } from './connections/capabilities/input-validation.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AccountBinding } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { AccountProfiles } from './account-profiles.js';
import type { OrdinaryWorkspaceRecord } from './ordinary-workspace-custody.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';
import type { CodexAccountProfile } from './codex-account.js';
import type { OpenShellRuntimeConfig } from './openshell-runtime.js';
import type { ArtifactRuntime, CodexConversationStore } from './codex-conversation-store.js';
import {
  assertOrdinaryOpenShellCodexRoute,
  ordinaryOpenShellCodexTarget,
  projectOrdinaryOpenShellCodexCapabilities,
} from './ordinary-openshell-codex-route.js';
import {
  OwnedOpenShellCodexChatAdmission,
  OwnedOpenShellCodexPayloadSchema,
  type OrdinaryOpenShellCodexExpectation,
} from './owned-openshell-codex-chat-admission.js';
import { OrdinaryLocalCodexCommandRequestSchema } from './ordinary-local-codex-admission.js';
import { assertNativeCodexContextAdmission } from './native-codex-context-admission.js';
import type { CredentialSetupNotification } from './credential-setup-continuation.js';
import { resolveTelosWorkSystemPrompt } from './telos-work-role-context.js';
import { buildAgentProfilePrompt } from './agent-library-prompt.js';

type SessionUpsert = Parameters<EventStore['upsertSession']>[0];

const unavailable = () => new Error('Ordinary OpenShell Codex admission unavailable');
type Projection = ReturnType<typeof projectOrdinaryOpenShellCodexCapabilities>;
export interface OrdinaryOpenShellCodexOwnedDispatch {
  sessionId: string;
  resume?: true;
  commandId: string;
  preparationSignal?: AbortSignal;
  assertCredentialSetupCurrent?: () => void;
  expected: OrdinaryOpenShellCodexExpectation;
  workspace: Awaited<ReturnType<RepositoryWorkspaces['claim']>> | OrdinaryWorkspaceRecord;
  payload: ReturnType<typeof OwnedOpenShellCodexPayloadSchema.parse>;
  profile: CodexAccountProfile;
  account: AccountBinding;
  admission: OwnedOpenShellCodexChatAdmission;
}
/** Composition of existing EventStore, AccountProfiles, workspace, native queue
 * and lifecycle owners. The caller supplies independently qualified host/provider
 * authority; configuration snapshots alone cannot install this driver.
 */
export class OrdinaryOpenShellCodexOwnedRuntime {
  #admission?: OwnedOpenShellCodexChatAdmission;
  #origin?: OrdinaryOpenShellCodexExpectation;
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;
  constructor(
    private readonly owners: {
      enabled: boolean;
      resume?: boolean;
      nativeStore: CodexConversationStore;
      authSessionId: string;
      events: EventStore;
      profiles: AccountProfiles;
      workspace: RepositoryWorkspaces;
      workspaceKind?: 'repository' | 'ordinary';
      sessionId: string;
      workspaceId: string;
      taskRoot: string;
      target: ReturnType<typeof ordinaryOpenShellCodexTarget>;
      config: OpenShellRuntimeConfig;
      projection: Projection;
      capabilitiesCurrent(): { profiles: AccountProfiles; projection: Projection };
      /** Existing account model at creation, independent of future selections. */
      account: AccountBinding;
      assertCurrentSync(expected: OrdinaryOpenShellCodexExpectation): void;
      assertCurrentIdentitySync(expected: OrdinaryOpenShellCodexExpectation): void;
      assertCurrent(expected: OrdinaryOpenShellCodexExpectation): Promise<void>;
      readRetained(): ArtifactRuntime | undefined;
      assertRetainedAuthority(artifact: ArtifactRuntime): void;
      dispatch(input: OrdinaryOpenShellCodexOwnedDispatch): Promise<void>;
      dispatchContinuation(input: OrdinaryOpenShellCodexOwnedDispatch): Promise<void>;
      signal: AbortSignal;
      close(): void;
    },
  ) {}
  async admit(
    meta: SessionUpsert,
    request: unknown,
    preparationSignal?: AbortSignal,
  ): Promise<{ dispatched: boolean; sessionId: string }> {
    const operation = this.#tail.then(() => this.admitExclusive(meta, request, preparationSignal));
    this.#tail = operation.catch(() => {});
    return operation;
  }
  async admitPreparedFirst(operationId: string, meta: SessionUpsert, request: unknown) {
    if (!operationId || this.owners.resume) throw unavailable();
    const operation = this.#tail.then(() =>
      this.admitExclusive(meta, request, undefined, operationId),
    );
    this.#tail = operation.catch(() => {});
    return operation;
  }
  /** Only the live host setup outbox can supply this predicate. No public
   * command body can select this path or manufacture a new runtime selection. */
  async notifyCredentialSetup(meta: SessionUpsert, notice: CredentialSetupNotification) {
    const operation = this.#tail.then(async () => {
      notice.assertCurrent();
      const o = this.owners;
      const saved = o.events.getOrdinaryOpenShellCommandAdmission(notice.messageId);
      if (saved && saved.state !== 'consumed') return false;
      const current = saved ?? o.events.getLatestOrdinaryCommandAdmission(o.sessionId);
      if (
        !this.#origin ||
        !meta.agentProfile ||
        current?.state !== 'consumed' ||
        current.binding.execution.location !== 'openshell' ||
        current.binding.harness.implementation !== 'codex' ||
        meta.mode !== current.selection.permission.mode
      )
        throw unavailable();
      const result = await this.admitExclusive(
        meta,
        {
          clientMsgId: notice.messageId,
          capabilityRevision: o.capabilitiesCurrent().projection.inventory.capabilityRevision,
          runtime: {
            account: current.binding.account,
            harness: 'codex',
            targetId: current.binding.execution.targetId,
            mode: current.selection.permission.mode,
          },
          selection: current.selection,
          payload: {
            text: notice.prompt,
            systemPrompt: resolveTelosWorkSystemPrompt(
              o.events,
              o.sessionId,
              o.account,
              buildAgentProfilePrompt(meta.agentProfile.definition),
            ),
          },
        },
        notice.signal,
        undefined,
        notice.assertCurrent,
      );
      notice.assertCurrent();
      return (
        result.dispatched ||
        o.events.getOrdinaryOpenShellCommandAdmission(notice.messageId)?.state === 'consumed'
      );
    });
    this.#tail = operation.catch(() => {});
    return operation;
  }
  private async admitExclusive(
    metaInput: SessionUpsert,
    requestInput: unknown,
    preparationSignal?: AbortSignal,
    preparationOperationId?: string,
    assertCredentialSetupCurrent?: () => void,
  ) {
    assertCredentialSetupCurrent?.();
    preparationSignal?.throwIfAborted();
    const o = this.owners;
    if (!o.enabled || this.#closed) throw unavailable();
    o.signal.throwIfAborted();
    const current = o.capabilitiesCurrent();
    const request = OrdinaryLocalCodexCommandRequestSchema.parse(requestInput);
    const sourcePayload = OwnedOpenShellCodexPayloadSchema.parse(request.payload);
    assembleSourceSnapshots(sourcePayload.text, sourcePayload.sourceSnapshots);
    const meta = structuredClone(metaInput);
    if (
      meta.sessionId !== o.sessionId ||
      (o.workspaceKind === 'ordinary'
        ? meta.ordinaryWorkspaceId !== o.workspaceId || meta.repositoryWorkspaceId != null
        : meta.repositoryWorkspaceId !== o.workspaceId || meta.ordinaryWorkspaceId != null) ||
      meta.cwd !== o.config.workdir ||
      request.runtime.mode !== request.selection.permission.mode ||
      request.capabilityRevision !== current.projection.inventory.capabilityRevision ||
      !isDeepStrictEqual(request.runtime.account, {
        accountId: o.account.accountId,
        provider: o.account.provider,
        profileRevision: o.account.profileRevision,
      }) ||
      request.runtime.targetId !== o.target.targetId ||
      request.runtime.harness !== 'codex'
    )
      throw unavailable();
    const binding = {
      version: 2 as const,
      account: request.runtime.account,
      harness: { implementation: 'codex' as const },
      execution: {
        location: 'openshell' as const,
        targetId: o.target.targetId,
        targetRevision: o.target.targetRevision,
      },
    };
    const expected: OrdinaryOpenShellCodexExpectation = {
      binding,
      workspace: { workspaceId: o.workspaceId, cwd: o.config.workdir },
      selection: request.selection,
      agentProfile: meta.agentProfile,
      agentContext: meta.agentContext,
    };
    const assertCurrentSync = () => {
      assertCredentialSetupCurrent?.();
      o.assertCurrentSync(expected);
    };
    if (
      this.#origin &&
      (!isDeepStrictEqual(expected.binding, this.#origin.binding) ||
        !isDeepStrictEqual(expected.workspace, this.#origin.workspace) ||
        !isDeepStrictEqual(expected.agentProfile, this.#origin.agentProfile) ||
        !isDeepStrictEqual(expected.agentContext, this.#origin.agentContext) ||
        !isDeepStrictEqual(expected.selection.agent, this.#origin.selection.agent) ||
        !isDeepStrictEqual(expected.selection.context, this.#origin.selection.context) ||
        !isDeepStrictEqual(expected.selection.permission, this.#origin.selection.permission))
    )
      throw unavailable();
    if (
      !meta.agentProfile ||
      !isDeepStrictEqual(
        {
          profileId: meta.agentProfile.profileId,
          revision: meta.agentProfile.revision,
          ...(meta.agentProfile.kind ? { kind: meta.agentProfile.kind } : {}),
        },
        expected.selection.agent,
      ) ||
      meta.mode !== expected.selection.permission.mode ||
      meta.selectedModel !== expected.selection.model ||
      (meta.reasoningEffort ?? null) !== expected.selection.thinking
    )
      throw unavailable();
    assertOrdinaryCodexContextIdentity(meta.agentProfile, expected.selection, meta.agentContext);
    if (o.resume && meta.agentProfile.definition.contextRecipe && !meta.agentContext)
      throw unavailable();
    assertNativeCodexContextAdmission(
      meta.agentProfile.definition.contextRecipe,
      meta.agentContext,
    );
    const selected = current.projection.inventory.accounts.find((entry) =>
      isDeepStrictEqual(entry.account, binding.account),
    );
    const model = selected?.models.find((candidate) => candidate.id === expected.selection.model);
    if (
      !selected ||
      selected.modelDiscovery.stale ||
      !model ||
      (expected.selection.thinking === null
        ? !!model.reasoningEfforts?.length
        : !model.reasoningEfforts?.includes(expected.selection.thinking))
    )
      throw unavailable();
    const route = assertOrdinaryOpenShellCodexRoute({
      binding,
      account: o.account,
      profiles: current.profiles,
      catalog: current.projection.catalog,
      target: o.target,
      model: expected.selection.model,
      reasoningEffort: expected.selection.thinking,
      mode: expected.selection.permission.mode,
    });
    const fingerprint = `ordinary-openshell-codex-v1:${createHash('sha256')
      .update(
        canonicalJson(
          JSON.parse(
            JSON.stringify({
              request,
              expected: {
                ...expected,
                agentContext: expected.agentProfile?.definition.contextRecipe
                  ? undefined
                  : expected.agentContext,
              },
            }),
          ),
        ),
      )
      .digest('hex')}`;
    if (preparationOperationId) {
      const receipt =
        o.workspaceKind === 'ordinary'
          ? o.events.assertPreparedOrdinaryWorkspaceSession(
              preparationOperationId,
              meta,
              binding,
              expected.selection,
            )
          : o.events.assertPreparedOrdinarySession(
              preparationOperationId,
              meta,
              binding,
              expected.selection,
            );
      if (receipt.firstCommandId !== null && receipt.firstCommandId !== request.clientMsgId)
        throw unavailable();
    }
    const saved = o.events.getOrdinaryOpenShellCommandAdmission(request.clientMsgId);
    if (saved && saved.state !== 'reserved') {
      const send = o.events.getSendCommand(request.clientMsgId);
      if (
        !send ||
        send.sessionId !== o.sessionId ||
        !isDeepStrictEqual(saved.binding, expected.binding) ||
        !isDeepStrictEqual(saved.selection, expected.selection) ||
        !isDeepStrictEqual(saved.workspace, expected.workspace) ||
        saved.requestFingerprint !== fingerprint ||
        !isDeepStrictEqual(send.payload, request.payload)
      )
        throw unavailable();
      assertCurrentSync();
      return { dispatched: false, sessionId: o.sessionId };
    }
    if (o.resume && !this.#origin) {
      const custody = o.nativeStore.readOpenShellCustody(o.sessionId, o.account);
      const retained = o.nativeStore.readArtifactRuntime(o.sessionId, o.account);
      if (
        !custody ||
        !retained ||
        !ordinaryOperatorOwnsConversation(custody.authSessionId, o.authSessionId) ||
        !isDeepStrictEqual(custody.binding, expected.binding) ||
        !isDeepStrictEqual(custody.workspace, expected.workspace) ||
        custody.physicalIdentitySha256 !== openShellPhysicalCustodyFingerprint(retained) ||
        !o.nativeStore.read(o.sessionId, o.account).threadId ||
        o.nativeStore
          .commands(o.sessionId, o.account)
          .some((command) => command.status === 'running')
      )
        throw unavailable();
      assertOrdinaryCodexSnapshotCustody(custody, expected.agentProfile, expected.agentContext);
      o.assertRetainedAuthority(retained);
    }
    assertCurrentSync();
    await o.assertCurrent(expected);
    preparationSignal?.throwIfAborted();
    o.signal.throwIfAborted();
    assertCurrentSync();
    // claim(true) CAS-reserves exact account/conversation/source before sandbox
    // allocation; it makes no provider launch and uses the existing workspace ledger.
    const workspace =
      o.workspaceKind === 'ordinary'
        ? await o.workspace.claimOrdinaryWorkspace({
            id: o.workspaceId,
            binding: o.account,
            conversationId: o.sessionId,
            taskRoot: o.taskRoot,
            signal: preparationSignal ? AbortSignal.any([o.signal, preparationSignal]) : o.signal,
          })
        : await o.workspace.claim(o.workspaceId, o.account, o.sessionId, o.taskRoot, true);
    preparationSignal?.throwIfAborted();
    if (
      workspace.state !== 'claimed' ||
      !workspace.sandbox ||
      workspace.conversationId !== o.sessionId ||
      workspace.id !== o.workspaceId ||
      !isDeepStrictEqual(workspace.binding, o.account)
    )
      throw unavailable();
    assertCurrentSync();
    const account = { ...o.account, model: expected.selection.model };
    const admittedMeta = { ...meta, accountBinding: account };
    const input = {
      clientMsgId: request.clientMsgId,
      requestFingerprint: fingerprint,
      selection: expected.selection,
      payload: request.payload,
    };
    preparationSignal?.throwIfAborted();
    const receipt = preparationOperationId
      ? o.workspaceKind === 'ordinary'
        ? o.events.admitPreparedOrdinaryWorkspaceCommand(
            preparationOperationId,
            admittedMeta,
            binding,
            input,
          )
        : o.events.admitPreparedOrdinaryCommand(
            preparationOperationId,
            admittedMeta,
            binding,
            input,
          )
      : this.#origin || o.resume
        ? o.events.admitOrdinaryOpenShellContinuation(admittedMeta, binding, input)
        : o.events.admitOrdinaryOpenShellCommand(admittedMeta, binding, input);
    if (receipt.admission.state !== 'reserved')
      return { dispatched: false, sessionId: o.sessionId };
    await o.assertCurrent(expected);
    preparationSignal?.throwIfAborted();
    o.signal.throwIfAborted();
    assertCurrentSync();
    preparationSignal?.throwIfAborted();
    if (!o.events.claimOrdinaryOpenShellCommandDispatch(request.clientMsgId))
      return { dispatched: false, sessionId: o.sessionId };
    if (!this.#admission) {
      const capture = o.resume
        ? OwnedOpenShellCodexChatAdmission.captureResume
        : OwnedOpenShellCodexChatAdmission.capture;
      this.#admission = capture(
        {
          events: o.events,
          workspaceKind: o.workspaceKind,
          nativeStore: o.nativeStore,
          authSessionId: o.authSessionId,
          expectedRetained: o.resume ? o.readRetained() : undefined,
          sessionId: o.sessionId,
          expected,
          account: o.account,
          profiles: current.profiles,
          profilesCurrent: () => o.capabilitiesCurrent().profiles,
          catalog: o.projection.catalog,
          target: o.target,
          config: o.config,
          assertCurrentSync: () => {
            o.signal.throwIfAborted();
            if (this.#closed) throw unavailable();
            o.assertCurrentIdentitySync(expected);
          },
          assertSelectionCurrentSync: (current) => o.assertCurrentSync(current),
          assertCurrent: (current) => o.assertCurrent(current),
          readRetained: o.readRetained,
          assertRetainedAuthority: o.assertRetainedAuthority,
          close: () => this.close(),
        },
        request.clientMsgId,
      );
    } else this.#admission.admitContinuation(request.clientMsgId, expected);
    const profile: CodexAccountProfile =
      route.kind === 'api'
        ? {
            accountId: account.accountId,
            accountLabel: account.accountLabel,
            email: 'openshell-api@invalid',
            planType: 'api',
            sandboxProvider: route.provider,
            model: expected.selection.model,
          }
        : {
            ...current.profiles.codexRoutingProfile(o.account),
            model: expected.selection.model,
          };
    const dispatch = {
      sessionId: o.sessionId,
      ...(!this.#origin && o.resume ? { resume: true as const } : {}),
      commandId: request.clientMsgId,
      preparationSignal,
      assertCredentialSetupCurrent,
      expected,
      workspace,
      payload: OwnedOpenShellCodexPayloadSchema.parse(request.payload),
      profile,
      account: structuredClone(o.account),
      admission: this.#admission,
    };
    // Failure preserves the existing uncertain receipt; never automatically replay.
    preparationSignal?.throwIfAborted();
    assertCurrentSync();
    await (this.#origin ? o.dispatchContinuation(dispatch) : o.dispatch(dispatch));
    assertCurrentSync();
    preparationSignal?.throwIfAborted();
    o.events.completeOrdinaryOpenShellCommand(request.clientMsgId);
    this.#origin ??= structuredClone(expected);
    return { dispatched: true, sessionId: o.sessionId };
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.owners.close();
  }
}
