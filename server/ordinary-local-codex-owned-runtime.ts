import {
  CHAT_MAX_IMAGES,
  CHAT_MAX_PREPARED_PROMPT_CHARS,
  ChatMessageTextSchema,
} from '@mitzo/protocol';
import { findNativeMacExecutionUnavailable } from './codex-native-artifact-qualification.js';
import {
  OrdinaryLocalWorkspaceOwner,
  type LocalWorkspaceKind,
  type LocalWorkspaceRecord,
  type LocalWorkspaceCustodyOwner,
} from './ordinary-local-workspace-owner.js';
import { ordinaryOperatorOwnsConversation } from './ordinary-operator-identity.js';
import {
  resolveTelosWorkRoleContext,
  resolveTelosWorkSystemPrompt,
} from './telos-work-role-context.js';
import { SourceSnapshotsSchema, agentMessagePrompt } from '@mitzo/protocol';
import { assembleSourceSnapshots } from './source-snapshot-context.js';
import { assertAgentToolRoute } from './agent-tool-selection.js';
import {
  assertOrdinaryCodexContextIdentity,
  assertOrdinaryCodexSnapshotCustody,
} from './ordinary-codex-agent-context.js';
import type { AgentContextSnapshot } from '@mitzo/protocol';
import {
  readOrdinaryCodexAgentProfile,
  resolveOrdinaryCodexAgentProfile,
} from './ordinary-codex-agent-profile.js';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { AgentLibraryStore } from './agent-library-store.js';
import type { EventStore } from './event-store.js';
import type {
  HostRepositoryReservationInput,
  RepositoryWorkspaces,
} from './repository-workspaces.js';
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
import { retainAgentContextAuthority } from './agent-context-authority.js';
import { buildAgentProfilePrompt } from './agent-library-prompt.js';
import { loadAccountProfiles } from './account-profiles.js';
import { custodianControllerMode, custodianOwnerMode } from './symposium-custodian-mode.js';
import { OrdinaryLocalCodexCapabilityCatalog } from './ordinary-local-codex-capabilities.js';
import { OrdinaryLocalCodexHostRuntime } from './ordinary-local-codex-host-runtime.js';
import { OrdinaryLocalCodexSelectionOwner } from './ordinary-local-codex-selection-owner.js';
import {
  OrdinaryLocalCodexAdmissionCoordinator,
  OrdinaryLocalCodexCommandRequestSchema,
  type OrdinaryLocalCodexAdmissionExpectation,
} from './ordinary-local-codex-admission.js';
import {
  FrozenHostCodexBootstrapAuthority,
  type FrozenHostCodexBootstrapLease,
} from './frozen-host-codex-bootstrap.js';
import { OwnedCodexLifecycleBridge } from './owned-codex-lifecycle-bridge.js';
import { OwnedLocalCodexChatAdmission } from './owned-local-codex-chat-admission.js';
import type { FrozenHostCodexClient } from './frozen-host-codex-login.js';
import type { FrozenHostCodexExecutable } from './frozen-host-codex-executable.js';
import { readCodexModels } from './model-catalog.js';
import type { CodexConversationStore } from './codex-conversation-store.js';
import { hasPersistentRevocationAuthority } from './auth.js';
import { PreparedRepositoryWorkspaceOwner } from './prepared-repository-workspace-owner.js';
import {
  performPreparedRepositoryPrimaryTransition,
  reconcilePreparedRepositoryTransitionProjection,
} from './owned-prepared-repository-transition.js';
import { withPreparedRepositoryBarrierReadScope } from './prepared-repository-barrier-read.js';
import {
  capturePreparedRepositoryReader,
  preparedRepositoryValidationReadMs,
} from './local-repository-native-read.js';
import { LocalRepositoryReadAccess } from './local-repository-read-access.js';
import { composeOwnedLocalNativeExecutionPolicyForWorkspace } from './owned-local-codex-native-policy.js';
import { freezePendingHostTaskData } from './pending-host-task.js';
import type { CredentialSetupNotification } from './credential-setup-continuation.js';
import { RetainedLocalCodexRecovery } from './retained-local-codex-recovery.js';

const unavailable = () => new Error('Owned local Codex runtime unavailable');
function strictSync(result: unknown): void {
  if (result === undefined) return;
  void Promise.resolve(result).catch(() => {});
  throw unavailable();
}
const RawPayload = z.strictObject({
  sourceSnapshots: SourceSnapshotsSchema.optional(),
  text: z.string().min(1).max(CHAT_MAX_PREPARED_PROMPT_CHARS),
  intent: ChatMessageTextSchema.optional(),
  images: z
    .array(z.strictObject({ data: z.string().min(1), mediaType: z.string().min(1).max(128) }))
    .max(CHAT_MAX_IMAGES)
    .optional(),
});
type Payload = z.infer<typeof RawPayload> & { systemPrompt: string };
export interface OrdinaryLocalCodexOwnedDispatch<K extends LocalWorkspaceKind = 'repository'> {
  admission: OwnedLocalCodexChatAdmission;
  lease: FrozenHostCodexBootstrapLease;
  profile: FrozenHostCodexBootstrapLease['profile'];
  expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>;
  workspace: LocalWorkspaceRecord<K>;
  payload: Payload;
  sessionId: string;
  commandId: string;
  resume?: boolean;
  recovery?: boolean;
  preparationSignal?: AbortSignal;
  agentMessageId?: string;
  assertCredentialSetupCurrent?: () => void;
}
interface Owners<K extends LocalWorkspaceKind = 'repository'> {
  enabled: boolean;
  eventStore: EventStore;
  library: AgentLibraryStore;
  workspace: RepositoryWorkspaces;
  workspaceKind?: K;
  reservation: Omit<HostRepositoryReservationInput, 'signal'>;
  commandId: string;
  /** Middleware-authenticated connection captured once, never supplied by request JSON. */
  operatorConnectionId: string;
  signal: AbortSignal;
  env?: Readonly<NodeJS.ProcessEnv>;
  privateRoot?: string;
  nativeStore?: CodexConversationStore;
  /** Existing explicitly selected read ceiling, if narrower than the host default. */
  nativeExecutionReadRoots?: readonly string[];
  /** Only native transport creation is replaceable for offline qualification. */
  launch?: (privateHome: string, executable: FrozenHostCodexExecutable) => FrozenHostCodexClient;
  launchApi?: (
    privateHome: string,
    executable: FrozenHostCodexExecutable,
    binding: import('@mitzo/protocol').AccountBinding,
    retained: boolean,
  ) => Promise<FrozenHostCodexClient>;
  /** Existing chat/conversation owner opens/enqueues the exact first command
   * while the receipt is uncertain. Retain its prepared event-loop handle here;
   * pump that handle only after admit returns dispatched:true (consumed), so
   * fast turn completion cannot dispose the lease before coordinator completion.
   */
  dispatch(input: OrdinaryLocalCodexOwnedDispatch<K>): Promise<void>;
  /** Existing live native FIFO owner; absent means first-command-only. */
  dispatchContinuation?(input: OrdinaryLocalCodexOwnedDispatch<LocalWorkspaceKind>): Promise<void>;
}

/** Server-internal composition for one reserved local first command. No endpoint,
 * automatic enrollment, provider loop or second ledger is introduced. The exact
 * interactive subject survives transport detach and remains revocation-bound.
 */
export class OrdinaryLocalCodexOwnedRuntime<K extends LocalWorkspaceKind = 'repository'> {
  readonly #reservation: Owners<K>['reservation'];
  readonly #runtime: OrdinaryLocalCodexHostRuntime;
  readonly #controller = new AbortController();
  readonly #signal: AbortSignal;
  #operator: ReturnType<typeof retainAgentContextAuthority>;
  #lease?: FrozenHostCodexBootstrapLease;
  #admission?: OwnedLocalCodexChatAdmission;
  #liveThreadOwner?: ReturnType<CodexConversationStore['captureLiveThreadOwner']>;
  #expected?: Readonly<OrdinaryLocalCodexAdmissionExpectation>;
  readonly #workspaceOwner: OrdinaryLocalWorkspaceOwner<K>;
  #workspace?: LocalWorkspaceRecord<K>;
  #preparedPrimaryCommandId?: string;
  #adoptedWorkspace?: import('./repository-workspaces.js').RepositoryWorkspace;
  #adoptedWorkspaceOwner?: LocalWorkspaceCustodyOwner<'repository'>;
  #authSessionId?: string;
  #closed = false;
  #continuationAdmissionTail: Promise<void> = Promise.resolve();
  #pendingContinuations = 0;
  #workspaceTransitionBarrier?: { ready: Promise<void>; release(): void };
  readonly #onAbort = () => this.close();

  constructor(private readonly owners: Owners<K>) {
    try {
      if (!owners.enabled || custodianControllerMode || custodianOwnerMode) throw unavailable();
      this.owners = {
        ...owners,
        reservation: structuredClone(owners.reservation),
        env: owners.env ? { ...owners.env } : undefined,
        nativeExecutionReadRoots:
          owners.nativeExecutionReadRoots && Object.freeze([...owners.nativeExecutionReadRoots]),
        dispatch: owners.dispatch.bind(owners),
        dispatchContinuation: owners.dispatchContinuation?.bind(owners),
      };
      owners = this.owners;
      owners.signal.throwIfAborted();
      const captured = captureAgentLibraryAuthorization(owners.operatorConnectionId);
      captured.assertCurrent();
      this.#authSessionId = captured.auth.id;
      this.#reservation = structuredClone(owners.reservation);
      this.#workspaceOwner = new OrdinaryLocalWorkspaceOwner(
        owners.workspace,
        owners.workspaceKind ?? ('repository' as K),
        this.#reservation,
      );
      this.#runtime = new OrdinaryLocalCodexHostRuntime(owners.env);
      this.#signal = AbortSignal.any([owners.signal, this.#controller.signal]);
      // registerAuthSession belongs to this retained authority rather than the
      // browser connection map. Its abort also closes any owned native lease.
      this.#operator = retainAgentContextAuthority({ ...captured.auth }, this.#controller);
      this.#signal.addEventListener('abort', this.#onAbort, { once: true });
      this.#operator.assertCurrent();
    } catch {
      this.close();
      throw unavailable();
    }
  }

  /** Explicit sends renew run authority; reading never transfers execution. */
  reauthorize(operatorConnectionId: string): void {
    this.assertCurrent();
    const captured = captureAgentLibraryAuthorization(operatorConnectionId);
    captured.assertCurrent();
    if (!ordinaryOperatorOwnsConversation(this.#authSessionId, captured.auth.id))
      throw unavailable();
    const next = retainAgentContextAuthority({ ...captured.auth }, this.#controller);
    try {
      next.assertCurrent();
    } catch (error) {
      next.release();
      throw error;
    }
    const previous = this.#operator;
    this.#operator = next;
    this.#authSessionId = captured.auth.id;
    previous.release();
  }
  async admit(raw: unknown): Promise<{ dispatched: boolean }> {
    return this.admitCommand(raw, false);
  }
  async admitPreparedFirst(operationId: string, raw: unknown): Promise<{ dispatched: boolean }> {
    if (!operationId) throw unavailable();
    return this.admitCommand(raw, false, operationId);
  }
  async admitResume(raw: unknown): Promise<{ dispatched: boolean }> {
    this.assertCurrent();
    const native = this.owners.nativeStore;
    if (native) {
      const custody = native.readHostCustody(
        this.#reservation.conversationId,
        this.#reservation.binding,
      );
      if (!custody || !ordinaryOperatorOwnsConversation(custody.authSessionId, this.#authSessionId))
        throw unavailable();
      const current = reconcilePreparedRepositoryTransitionProjection({
        workspace: this.owners.workspace,
        events: this.owners.eventStore,
        native,
        conversationId: this.#reservation.conversationId,
        binding: this.#reservation.binding,
        assertCurrentSync: () => this.assertCurrent(),
      });
      if (current && current.id !== this.#reservation.id) throw unavailable();
    }
    return this.admitCommand(raw, true);
  }
  /** Explicit recovery of an exact, positively undispatched retained command. */
  async recoverResume(raw: unknown): Promise<{ dispatched: boolean }> {
    this.assertCurrent();
    if (this.#admission) return { dispatched: false };
    if (!this.owners.nativeStore || !this.#authSessionId) throw unavailable();
    const recovery = RetainedLocalCodexRecovery.capture(
      this.owners.eventStore,
      this.owners.nativeStore,
      this.#reservation.conversationId,
      this.#authSessionId,
      raw,
    );
    if (recovery.commandId !== this.owners.commandId) throw unavailable();
    recovery.prepareQueue();
    return this.admitCommand(raw, true, undefined, recovery);
  }
  async recoverSavedResume(): Promise<{ dispatched: boolean }> {
    this.assertCurrent();
    if (this.#admission) return { dispatched: false };
    if (!this.owners.nativeStore || !this.#authSessionId) throw unavailable();
    const { request, proof } = RetainedLocalCodexRecovery.captureSaved(
      this.owners.eventStore,
      this.owners.nativeStore,
      this.#reservation.conversationId,
      this.#authSessionId,
      this.owners.commandId,
    );
    proof.prepareQueue();
    return this.admitCommand(request, true, undefined, proof);
  }
  private async admitCommand(
    raw: unknown,
    resume: boolean,
    preparationOperationId?: string,
    recovery?: RetainedLocalCodexRecovery,
  ): Promise<{ dispatched: boolean }> {
    let bootstrap: FrozenHostCodexBootstrapAuthority | undefined;
    let capturedBootstrap: FrozenHostCodexBootstrapAuthority | undefined;
    let capturedLeaseGetter: FrozenHostCodexBootstrapAuthority['currentLease'] | undefined;
    let coldThreadOwner: ReturnType<CodexConversationStore['captureLiveThreadOwner']> | undefined;
    const coldCurrentLease = () => {
      if (
        !capturedBootstrap ||
        bootstrap !== capturedBootstrap ||
        !capturedLeaseGetter ||
        capturedBootstrap.currentLease !== capturedLeaseGetter
      )
        throw unavailable();
      const lease = Reflect.apply(capturedLeaseGetter, capturedBootstrap, []);
      if (bootstrap !== capturedBootstrap || capturedBootstrap.currentLease !== capturedLeaseGetter)
        throw unavailable();
      return lease;
    };
    const retainedLease = this.#lease;
    try {
      this.assertCurrent();
      if (custodianControllerMode || custodianOwnerMode) throw unavailable();
      const request = OrdinaryLocalCodexCommandRequestSchema.parse(raw);
      if (request.clientMsgId !== this.owners.commandId) throw unavailable();
      // Builtins remain code-owned; a matching user Library ID cannot change namespace.
      const rawPayload = RawPayload.parse(request.payload);
      assembleSourceSnapshots(rawPayload.text, rawPayload.sourceSnapshots);
      const profiles = loadAccountProfiles();
      const binding = profiles.resolve(request.runtime.account.accountId, request.selection.model);
      const accountIdentity = (value: typeof binding) => ({
        accountId: value.accountId,
        provider: value.provider,
        profileRevision: value.profileRevision,
      });
      if (
        resume
          ? !isDeepStrictEqual(accountIdentity(binding), accountIdentity(this.#reservation.binding))
          : !isDeepStrictEqual(binding, this.#reservation.binding)
      )
        throw unavailable();
      const profile = profiles.localCodexProfile(binding);
      if (profile.workspaceId !== undefined) throw unavailable();
      const descriptor = this.#workspaceOwner.get();
      let custody = resume
        ? this.owners.nativeStore?.readHostCustody(
            this.#reservation.conversationId,
            this.#reservation.binding,
          )
        : undefined;
      if (
        resume &&
        (!hasPersistentRevocationAuthority() ||
          !custody ||
          !ordinaryOperatorOwnsConversation(custody.authSessionId, this.#authSessionId) ||
          !this.owners.nativeStore?.read(
            this.#reservation.conversationId,
            this.#reservation.binding,
          ).threadId ||
          descriptor.state !== 'claimed')
      )
        throw unavailable();
      if (resume) {
        const native = this.owners.nativeStore!;
        native.assertNoPendingThreadDispatch(
          this.#reservation.conversationId,
          this.#reservation.binding,
        );
        native.assertNoPendingThreadOwnership(
          this.#reservation.conversationId,
          this.#reservation.binding,
        );
        if (
          native
            .commands(this.#reservation.conversationId, this.#reservation.binding)
            .some((command) => command.status === 'running')
        )
          throw unavailable();
      }
      const coldServices = {
        workspace: this.owners.workspace,
        eventStore: this.owners.eventStore,
        nativeStore: this.owners.nativeStore,
      };
      const coldSources = [
        {
          owner: this.owners.workspace,
          names: ['getForConversation', 'assertPreparedRepositoryTransitionAdopted'],
        },
        {
          owner: this.owners.eventStore,
          names: [
            'getOrdinaryLocalCommandAdmission',
            'getOrdinaryLocalCommandExecutionAdmission',
            'getSendCommand',
            'getSession',
            'observePreparedRepositoryContinuation',
            'observePreparedRepositoryBootstrapAdmission',
          ],
        },
        ...(this.owners.nativeStore
          ? [
              {
                owner: this.owners.nativeStore,
                names: [
                  'read',
                  'readHostCustody',
                  'commands',
                  'assertNoPendingThreadDispatch',
                  'assertNoPendingThreadOwnership',
                  'assertPreparedRepositoryRecovery',
                  'preparedRepositoryWorkspaceTransition',
                  'captureLiveThreadOwner',
                  'readNativeExecution',
                ],
              },
            ]
          : []),
      ].map(({ owner, names }) => ({
        owner,
        references: Object.fromEntries(names.map((name) => [name, Reflect.get(owner, name)])),
      }));
      const assertColdSources = () => {
        if (
          this.owners.workspace !== coldServices.workspace ||
          this.owners.eventStore !== coldServices.eventStore ||
          this.owners.nativeStore !== coldServices.nativeStore
        )
          throw unavailable();
        for (const { owner, references } of coldSources)
          for (const [name, original] of Object.entries(references))
            if (typeof original !== 'function' || Reflect.get(owner, name) !== original)
              throw unavailable();
      };
      const qualified =
        resume && this.#workspaceOwner.kind === 'repository'
          ? this.owners.workspace.getForConversation(this.#reservation.conversationId)
          : undefined;
      const coldMarker = qualified?.qualifiedLocalPreparation
        ? qualified.preparedRepositoryTransitionAdoption
        : undefined;
      if (qualified?.qualifiedLocalPreparation && !coldMarker) throw unavailable();
      const coldFacts = coldMarker && freezePendingHostTaskData(structuredClone(coldMarker.facts));
      const coldPrimary = coldMarker?.childCommandId;
      const coldNative =
        coldFacts &&
        this.owners.nativeStore!.read(this.#reservation.conversationId, this.#reservation.binding);
      const coldCustody = custody && freezePendingHostTaskData(structuredClone(custody));
      coldThreadOwner =
        coldFacts &&
        this.owners.nativeStore!.captureLiveThreadOwner(
          this.#reservation.conversationId,
          this.#reservation.binding,
        );
      let coldPrimaryInterrupted: ReturnType<
        CodexConversationStore['assertPreparedRepositoryRecovery']
      >;
      const assertColdEvidence = () => {
        assertColdSources();
        this.assertCurrent();
        assertColdSources();
        if (!coldFacts || !coldPrimary || !coldNative || !coldCustody) throw unavailable();
        const native = this.owners.nativeStore!;
        strictSync(
          this.owners.workspace.assertPreparedRepositoryTransitionAdopted(coldFacts, coldPrimary),
        );
        // Find only the exact persisted prior-pointer root, then let the
        // unchanged canonical observer validate all source/order/binding edges.
        let ancestorId = coldPrimary;
        let ancestry = false;
        for (let depth = 0; depth < 100; depth++) {
          const edge =
            this.owners.eventStore.observePreparedRepositoryContinuation(
              ancestorId,
            ).preparedRepositoryTransition!;
          if (!edge.priorPrimaryCommandId) {
            this.owners.eventStore.observePreparedRepositoryBootstrapAdmission(
              coldPrimary,
              edge.source.commandId,
            );
            ancestry = true;
            break;
          }
          ancestorId = edge.priorPrimaryCommandId;
        }
        if (!ancestry) throw unavailable();
        const receipt = this.owners.eventStore.getOrdinaryLocalCommandAdmission(coldPrimary);
        const send = this.owners.eventStore.getSendCommand(coldPrimary);
        const meta = this.owners.eventStore.getSession(this.#reservation.conversationId);
        const state = native.read(this.#reservation.conversationId, this.#reservation.binding);
        const command = native
          .commands(this.#reservation.conversationId, this.#reservation.binding)
          .find((value) => value.id === coldPrimary);
        const workspaceRevision = native.preparedRepositoryWorkspaceTransition(
          this.#reservation.conversationId,
          this.#reservation.binding,
          coldPrimary,
        );
        const retainedSource =
          workspaceRevision &&
          isDeepStrictEqual(workspaceRevision.source, coldFacts.request.nativeTarget) &&
          workspaceRevision.fromCwd === coldFacts.oldWorkspace.directory &&
          workspaceRevision.toCwd === coldFacts.newWorkspace.directory;
        if (
          !receipt ||
          receipt.state !== 'consumed' ||
          !receipt.preparedRepositoryTransition ||
          !send ||
          send.error ||
          send.sessionId !== this.#reservation.conversationId ||
          receipt.workspace.workspaceId !== coldFacts.newWorkspace.id ||
          receipt.workspace.cwd !== coldFacts.newWorkspace.directory ||
          !isDeepStrictEqual(receipt.binding, coldFacts.request.runtimeBinding) ||
          !meta ||
          meta.cwd !== coldFacts.newWorkspace.directory ||
          meta.repositoryWorkspaceId !== coldFacts.newWorkspace.id ||
          meta.ordinaryWorkspaceId != null ||
          !isDeepStrictEqual(meta.accountBinding, this.#reservation.binding) ||
          state.cwd !== coldFacts.newWorkspace.directory ||
          !state.threadId ||
          (!this.#admission &&
            (state.threadId !== coldNative.threadId ||
              state.threadGeneration !== coldNative.threadGeneration)) ||
          !isDeepStrictEqual(
            native.readHostCustody(this.#reservation.conversationId, this.#reservation.binding),
            coldCustody,
          ) ||
          (!command && !retainedSource) ||
          (command &&
            !(command.status === 'cancelled' && retainedSource) &&
            (!(
              this.#admission
                ? ['queued', 'running', 'completed', 'interrupted']
                : ['queued', 'completed', 'interrupted']
            ).includes(command.status) ||
              !isDeepStrictEqual(command.environmentContinuation, {
                sourceCommandId: coldFacts.request.nativeTarget.commandId,
                sourceThreadId: coldFacts.request.nativeTarget.threadId,
                sourceTurnId: coldFacts.request.nativeTarget.turnId,
                sourceGeneration: coldFacts.request.nativeTarget.generation,
              })))
        )
          throw unavailable();
        if (this.#admission) coldThreadOwner!.assertCurrentSync();
        coldPrimaryInterrupted?.assertCurrentSync();
        if (command?.status === 'interrupted' && !coldPrimaryInterrupted && this.#admission)
          coldThreadOwner!.assertAcceptedCommand(command.id);
        if (state.recovery || (command?.status === 'interrupted' && !coldPrimaryInterrupted)) {
          const witness = native.assertPreparedRepositoryRecovery(
            this.#reservation.conversationId,
            this.#reservation.binding,
            coldPrimary,
            this.#admission ? this.owners.commandId : undefined,
          );
          coldPrimaryInterrupted ??= witness;
        }
        if (!this.#admission) {
          native.assertNoPendingThreadDispatch(
            this.#reservation.conversationId,
            this.#reservation.binding,
          );
          native.assertNoPendingThreadOwnership(
            this.#reservation.conversationId,
            this.#reservation.binding,
          );
        }
        assertColdSources();
      };
      const coldWorkspace =
        coldFacts && coldPrimary
          ? new PreparedRepositoryWorkspaceOwner(this.owners.workspace, coldFacts, coldPrimary, {
              assertCurrentSync: assertColdEvidence,
              withReadAccess: async (operationSignal, action) => {
                const lease = coldCurrentLease();
                if (!lease || (this.#lease && this.#lease !== lease)) throw unavailable();
                const withReadOwner = lease.withQualifiedWorkspaceReadOwner;
                if (!withReadOwner) throw unavailable();
                let completed = false;
                const result: unknown = await Reflect.apply(withReadOwner, lease, [
                  AbortSignal.any([this.#signal, operationSignal]),
                  async (current) => {
                    const selectedPolicy = () =>
                      composeOwnedLocalNativeExecutionPolicyForWorkspace(
                        {
                          binding: lease.binding,
                          readableRoots: this.owners.nativeExecutionReadRoots,
                          assertCurrentSync: () => current.assertCurrentSync(),
                        },
                        () => ({
                          cwd: coldFacts.newWorkspace.directory,
                          workspaceRoots: [coldFacts.newWorkspace.directory],
                          mode: this.owners.eventStore.getSession(this.#reservation.conversationId)!
                            .mode,
                          authSessionId: this.#authSessionId,
                        }),
                      );
                    await withPreparedRepositoryBarrierReadScope(
                      selectedPolicy(),
                      this.owners.commandId,
                      {
                        signal: current.signal,
                        selectedPolicy,
                        assertCurrentSync: () => current.assertCurrentSync(),
                        revalidate: () => current.revalidate(),
                      },
                      async (scope) => {
                        const reader = await capturePreparedRepositoryReader(scope, {
                          deadline: Date.now() + preparedRepositoryValidationReadMs,
                        });
                        try {
                          const result: unknown = await action(
                            new LocalRepositoryReadAccess(reader),
                          );
                          if (result !== undefined) throw unavailable();
                        } finally {
                          try {
                            await reader.dispose();
                          } finally {
                            await scope.revalidate();
                          }
                        }
                      },
                    );
                    completed = true;
                  },
                ]);
                if (
                  result !== undefined ||
                  !completed ||
                  lease !== coldCurrentLease() ||
                  lease.withQualifiedWorkspaceReadOwner !== withReadOwner
                )
                  throw unavailable();
              },
            })
          : undefined;
      if (coldWorkspace) {
        if (
          this.owners.eventStore.hasUncertainOrdinaryCommand(
            this.#reservation.conversationId,
            recovery?.commandId,
          )
        )
          throw unavailable();
        coldWorkspace.assertCurrentSync(descriptor.directory!);
      }
      // A retained checkout is usable only with its original command receipt.
      // The workspace and EventStore remain separate owners; never heal a
      // cross-store orphan by admitting a new command over existing task files.
      if (descriptor.state === 'claimed' && !resume) {
        const receipt = this.owners.eventStore.getOrdinaryLocalCommandAdmission(
          this.owners.commandId,
        );
        if (!receipt || !['uncertain', 'consumed'].includes(receipt.state)) throw unavailable();
      }
      const agentProfile = await resolveOrdinaryCodexAgentProfile({
        requested: request.selection.agent,
        stored: resume
          ? this.owners.eventStore.getSession(this.#reservation.conversationId)?.agentProfile
          : undefined,
        resume,
        provider: binding.provider,
        execution: { location: 'local' },
        lookup: async (selected) => readOrdinaryCodexAgentProfile(this.owners.library, selected),
      });
      assertAgentToolRoute(agentProfile?.definition, 'codex-owned-local');
      this.assertCurrent();
      if (!agentProfile || request.selection.permission.revision !== 0) throw unavailable();
      const retainedContext = resume
        ? this.owners.eventStore.getSession(this.#reservation.conversationId)?.agentContext
        : undefined;
      if (resume && agentProfile.definition.contextRecipe && !retainedContext) throw unavailable();
      assertOrdinaryCodexContextIdentity(agentProfile, request.selection, retainedContext);
      if (resume) assertOrdinaryCodexSnapshotCustody(custody!, agentProfile, retainedContext);
      const payload: Payload = {
        ...rawPayload,
        systemPrompt: resolveTelosWorkSystemPrompt(
          this.owners.eventStore,
          this.#reservation.conversationId,
          this.#reservation.binding,
          buildAgentProfilePrompt(agentProfile.definition),
        ),
      };
      const target = this.#runtime.target();
      const catalog = new OrdinaryLocalCodexCapabilityCatalog(profiles, target, 'ordinary');
      const retainedRuntime = resume
        ? this.owners.eventStore.getSessionRuntimeBinding(this.#reservation.conversationId)
        : undefined;
      if (
        resume &&
        (!retainedRuntime ||
          retainedRuntime.version !== 2 ||
          retainedRuntime.execution.location !== 'local' ||
          retainedRuntime.harness.implementation !== 'codex' ||
          retainedRuntime.execution.targetId !== target.descriptor().targetId)
      )
        throw unavailable();
      const configuration =
        retainedRuntime?.version === 2
          ? this.#runtime.continuationConfiguration(
              catalog,
              retainedRuntime.execution.targetRevision,
            )
          : { catalog, declaration: target.admissionDeclaration() };
      const selection = new OrdinaryLocalCodexSelectionOwner({
        events: this.owners.eventStore,
        library: this.owners.library,
        workspace: this.owners.workspace,
        workspaceKind: this.#workspaceOwner.kind,
        reservation: this.#reservation,
        operator: { assertCurrent: () => this.assertCurrent() },
        signal: this.#signal,
        commandId: this.owners.commandId,
        continuation: resume,
        qualifiedColdPrimary:
          coldWorkspace && Object.freeze({ commandId: coldPrimary!, workspace: coldWorkspace }),
        preparationOperationId,
      });
      const bridge = new OwnedCodexLifecycleBridge(() =>
        coldWorkspace ? coldCurrentLease() : bootstrap?.currentLease(),
      );
      const originalCustody = custody;
      bootstrap = new FrozenHostCodexBootstrapAuthority({
        loadProfiles: loadAccountProfiles,
        observeRuntime: () => this.#runtime.observe(),
        assertRuntimeCurrentSync: () => this.#runtime.assertCurrentSync(),
        assertSelectionCurrent: (expected) => selection.assertCurrent(expected),
        ...(coldWorkspace
          ? {
              assertQualifiedColdSelectionBeforeBootstrapSync: (
                expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>,
              ) => {
                assertColdEvidence();
                selection.assertCurrentSync(expected);
              },
            }
          : {}),
        assertToolSelectionCurrent: (expected) => selection.assertToolCurrent(expected),
        assertSelectionCurrentSync: (expected) => selection.assertCurrentSync(expected),
        signal: this.#signal,
        privateRoot: this.owners.privateRoot,
        retainedCustody: custody ?? undefined,
        completeRetainedRuntimeBundle:
          originalCustody && this.owners.nativeStore
            ? (executable) => {
                this.assertCurrent();
                this.owners.nativeStore!.completeHostRuntimeBundle(
                  this.#reservation.conversationId,
                  this.#reservation.binding,
                  originalCustody,
                  executable,
                );
                custody = this.owners.nativeStore!.readHostCustody(
                  this.#reservation.conversationId,
                  this.#reservation.binding,
                );
                this.assertCurrent();
              }
            : undefined,
        retainedAccountBinding: resume ? this.#reservation.binding : undefined,
        isSelectionPending: () => {
          const receipt = this.#preparedPrimaryCommandId
            ? coldPrimary
              ? this.owners.eventStore.observePreparedRepositoryColdBootstrapAdmission(
                  this.#preparedPrimaryCommandId,
                  this.owners.commandId,
                  coldPrimary,
                )
              : resume
                ? this.owners.eventStore.observePreparedRepositoryResumedBootstrapAdmission(
                    this.#preparedPrimaryCommandId,
                    this.owners.commandId,
                  )
                : this.owners.eventStore.observePreparedRepositoryBootstrapAdmission(
                    this.#preparedPrimaryCommandId,
                    this.owners.commandId,
                  )
            : this.owners.eventStore.getOrdinaryLocalCommandExecutionAdmission(
                this.owners.commandId,
              );
          if (receipt?.state !== 'consumed') return true;
          if (!this.owners.nativeStore) return false;
          try {
            const status = this.owners.nativeStore.commandStatus(
              this.#reservation.conversationId,
              this.#reservation.binding,
              this.owners.commandId,
            );
            return status === 'queued' || status === 'running';
          } catch {
            throw unavailable();
          }
        },
        pendingSelections: () => {
          if (!this.owners.nativeStore) return [];
          try {
            return this.owners.nativeStore.pendingModelSelections(
              this.#reservation.conversationId,
              this.#reservation.binding,
            );
          } catch {
            // Initial bootstrap has no native row yet; its uncertain selection
            // remains separately required above. Existing custody must be readable.
            if (
              resume ||
              this.owners.eventStore.getOrdinaryLocalCommandExecutionAdmission(
                this.owners.commandId,
              )?.state === 'consumed'
            )
              throw unavailable();
            return [];
          }
        },
        baseEnv: this.owners.env,
        lifecycle: bridge.lifecycle,
        launch: this.owners.launch,
        launchApi: this.owners.launchApi,
      });
      capturedBootstrap = bootstrap;
      capturedLeaseGetter = bootstrap.currentLease;
      const coordinator = new OrdinaryLocalCodexAdmissionCoordinator({
        recovery,
        enabled: this.owners.enabled,
        store: coldPrimary
          ? {
              qualifiesOrdinaryCommandCapability:
                this.owners.eventStore.qualifiesOrdinaryCommandCapability.bind(
                  this.owners.eventStore,
                ),
              admitOrdinaryLocalCommand: this.owners.eventStore.admitOrdinaryLocalCommand.bind(
                this.owners.eventStore,
              ),
              claimOrdinaryLocalCommandDispatch:
                this.owners.eventStore.claimOrdinaryLocalCommandDispatch.bind(
                  this.owners.eventStore,
                ),
              completeOrdinaryLocalCommand:
                this.owners.eventStore.completeOrdinaryLocalCommand.bind(this.owners.eventStore),
              admitOrdinaryLocalContinuation: (...args) => {
                assertColdEvidence();
                return this.owners.eventStore.admitPreparedRepositoryPrimaryContinuation(
                  ...args,
                  coldPrimary,
                );
              },
            }
          : this.owners.eventStore,
        ...configuration,
        bootstrapAuthority: bootstrap,
      });
      let claimedWorkspace: LocalWorkspaceRecord<K> | undefined;
      let preparedContext: AgentContextSnapshot | undefined;
      const result = await (
        preparationOperationId
          ? (this.#workspaceOwner.kind === 'ordinary'
              ? coordinator.admitPreparedOrdinaryWorkspaceFirst
              : coordinator.admitPreparedFirst
            ).bind(coordinator, preparationOperationId)
          : resume
            ? coordinator.admitResume.bind(coordinator)
            : coordinator.admit.bind(coordinator)
      )(
        {
          sessionId: this.#reservation.conversationId,
          ...(this.#workspaceOwner.kind === 'ordinary'
            ? { ordinaryWorkspaceId: descriptor.id }
            : { repositoryWorkspaceId: descriptor.id }),
          cwd: descriptor.directory,
          accountBinding: binding,
          agentProfile,
          agentContext: resume
            ? this.owners.eventStore.getSession(this.#reservation.conversationId)?.agentContext
            : undefined,
          mode: request.selection.permission.mode,
          selectedModel: request.selection.model,
          reasoningEffort: request.selection.thinking,
        },
        {
          ...request,
          capabilityRevision: recovery
            ? configuration.catalog.inventory().capabilityRevision
            : request.capabilityRevision,
          payload,
        },
        {
          prepareWorkspace: async (expected) => {
            this.assertCurrent();
            if (
              expected.workspace.workspaceId !== descriptor.id ||
              expected.workspace.cwd !== descriptor.directory
            )
              throw unavailable();
            if (resume) {
              await (coldWorkspace ?? this.#workspaceOwner).validate(descriptor.directory!);
              claimedWorkspace = (
                coldWorkspace ?? this.#workspaceOwner
              ).get() as LocalWorkspaceRecord<K>;
            } else claimedWorkspace = await this.#workspaceOwner.claim(this.#signal);
            this.assertCurrent();
            if (
              !claimedWorkspace ||
              claimedWorkspace.id !== expected.workspace.workspaceId ||
              claimedWorkspace.directory !== expected.workspace.cwd ||
              claimedWorkspace.state !== 'claimed' ||
              ('sandbox' in claimedWorkspace && claimedWorkspace.sandbox === true)
            )
              throw unavailable();
          },
          dispatch: async (originalExpected, clientMsgId) => {
            preparedContext = await selection.prepareContext(originalExpected, resume);
            const expected = { ...originalExpected, agentContext: preparedContext };
            this.assertCurrent();
            const lease = bootstrap!.currentLease();
            if (
              !lease ||
              !claimedWorkspace ||
              clientMsgId !== this.owners.commandId ||
              (this.#lease && this.#lease !== lease)
            )
              throw unavailable();
            lease.assertCurrentSync();
            const withQualifiedReadOwner = lease.withQualifiedWorkspaceReadOwner;
            const liveThreadOwner = coldThreadOwner;
            const owner = {
              eventStore: this.owners.eventStore,
              workspaceKind: this.#workspaceOwner.kind,
              sessionId: this.#reservation.conversationId,
              commandId: this.owners.commandId,
              expected,
              lease,
              bridge,
              authSessionId: this.#authSessionId,
              nativeStore: this.owners.nativeStore,
              recovery,
              authorizeNativeThreadDispatch:
                liveThreadOwner &&
                ((commandId: string) => {
                  this.assertCurrent();
                  if (!this.#admission || this.#lease !== lease) throw unavailable();
                  liveThreadOwner.authorizeDispatch(commandId);
                }),
              qualifiedColdPrimary:
                coldWorkspace &&
                Object.freeze({
                  commandId: coldPrimary!,
                  assertCurrentSync: () => coldWorkspace.assertCurrentSync(descriptor.directory!),
                }),
              preparedRepositoryBoundary: Object.freeze({
                assertCurrentSync: () => {
                  this.assertCurrent();
                  if (this.#lease !== lease || !this.#expected) throw unavailable();
                  lease.assertCurrentSync();
                  (this.#adoptedWorkspaceOwner ?? this.#workspaceOwner).assertCurrentSync(
                    this.#expected.workspace.cwd,
                  );
                },
                adopt: async (
                  scope: import('./prepared-repository-barrier-read.js').PreparedRepositoryBarrierReadScope,
                  source: Readonly<import('./codex-conversation-store.js').CodexNativeTurnTarget>,
                  assertConversationCurrentSync: () => void,
                  policyOwner: import('./prepared-repository-workspace-owner.js').PreparedRepositoryNativePolicyOwner,
                ) => {
                  this.assertCurrent();
                  assertConversationCurrentSync();
                  const currentExpected = this.#expected;
                  const native = this.owners.nativeStore;
                  if (
                    !currentExpected ||
                    !native ||
                    this.#lease !== lease ||
                    !Object.isFrozen(policyOwner)
                  )
                    throw unavailable();
                  const nativeDescriptor = Object.getOwnPropertyDescriptor(
                    policyOwner,
                    'assertNativeExecutionCurrent',
                  );
                  if (nativeDescriptor && !('value' in nativeDescriptor)) throw unavailable();
                  for (const key of ['signal', 'selectedPolicy', 'assertCurrentSync']) {
                    const descriptor = Object.getOwnPropertyDescriptor(policyOwner, key);
                    if (!descriptor || !('value' in descriptor)) throw unavailable();
                  }
                  const selectedPolicy = policyOwner.selectedPolicy,
                    currentPolicyOwner = policyOwner.assertCurrentSync,
                    nativeCurrent = policyOwner.assertNativeExecutionCurrent,
                    policySignal = policyOwner.signal;
                  const assertPolicyOwner = () => {
                    if (
                      policyOwner.selectedPolicy !== selectedPolicy ||
                      policyOwner.assertCurrentSync !== currentPolicyOwner ||
                      policyOwner.assertNativeExecutionCurrent !== nativeCurrent ||
                      policyOwner.signal !== policySignal
                    )
                      throw unavailable();
                    this.assertCurrent();
                    policySignal.throwIfAborted();
                    strictSync(Reflect.apply(currentPolicyOwner, policyOwner, []));
                  };
                  assertPolicyOwner();
                  let transitionBarrier: { ready: Promise<void>; release(): void } | undefined;
                  let primarySource:
                    | import('./owned-local-codex-chat-admission.js').CapturedPreparedRepositoryPrimarySource
                    | undefined;
                  try {
                    const input = Object.freeze({
                      binding,
                      conversationId: this.#reservation.conversationId,
                      sourceTarget: source,
                      oldWorkspace: Object.freeze({
                        kind: this.#adoptedWorkspaceOwner?.kind ?? this.#workspaceOwner.kind,
                        id: currentExpected.workspace.workspaceId,
                        directory: currentExpected.workspace.cwd,
                      }),
                    });
                    // Pure bounded SQL discovery precedes any physical/queue owner
                    // work when a completed turn did not prepare a repository.
                    if (!this.owners.workspace.findPreparedRepositoryTransitionCandidate(input))
                      return undefined;
                    if (this.#workspaceTransitionBarrier) throw unavailable();
                    const precedingAdmissions = this.#continuationAdmissionTail;
                    let release!: () => void;
                    const ready = new Promise<void>((resolve) => {
                      release = resolve;
                    });
                    transitionBarrier = { ready, release };
                    this.#workspaceTransitionBarrier = transitionBarrier;
                    await precedingAdmissions;
                    assertConversationCurrentSync();
                    assertPolicyOwner();
                    const queueFence = native.holdPreparedRepositoryTransition(
                      input.conversationId,
                      binding,
                      source,
                    );
                    primarySource = admission.capturePreparedRepositoryPrimarySource(
                      source,
                      assertConversationCurrentSync,
                      queueFence,
                    );
                    const queue = () => {
                      assertConversationCurrentSync();
                      this.assertCurrent();
                      primarySource?.assertCurrentSync();
                      queueFence.assertCurrentSync();
                      admission.assertPreparedRepositoryQueuedCommands(queueFence);
                    };
                    const proof = await this.owners.workspace.capturePreparedRepositoryTransition(
                      input,
                      {
                        readScope: scope,
                        assertNoQueuedOldWorkspaceCommandsSync: queue,
                        resultSha256: (request) =>
                          native.completedPreparedRepositoryResultSha256(
                            input.conversationId,
                            binding,
                            source,
                            request.prepareCallId,
                            request.requestHash,
                            primarySource,
                            queueFence,
                          ),
                      },
                    );
                    if (!proof) return undefined;
                    const result = await performPreparedRepositoryPrimaryTransition(proof, {
                      events: this.owners.eventStore,
                      native,
                      admission,
                      conversationId: input.conversationId,
                      binding,
                      expected: currentExpected,
                      preparedPrimarySource: primarySource,
                      queueFence,
                      hasPendingExplicitCommands: () => this.#pendingContinuations > 0,
                      assertCurrentSync: () => {
                        assertConversationCurrentSync();
                        assertPolicyOwner();
                        lease.assertCurrentSync();
                      },
                      assertConversationCurrentSync,
                      assertOperatorAndLeaseCurrentSync: () => {
                        this.assertCurrent();
                        lease.assertCurrentSync();
                      },
                      prepareWorkspaceHandoff: (facts, nextExpected, childId) => {
                        const workspace = new PreparedRepositoryWorkspaceOwner(
                          this.owners.workspace,
                          facts,
                          childId,
                          {
                            assertCurrentSync: () => {
                              this.assertCurrent();
                              if (this.#lease !== lease) throw unavailable();
                            },
                            withReadAccess: async (operationSignal, action) => {
                              const withReadOwner = withQualifiedReadOwner;
                              if (
                                !withReadOwner ||
                                lease.withQualifiedWorkspaceReadOwner !== withReadOwner
                              )
                                throw unavailable();
                              let started = false,
                                completed = false;
                              const checked: unknown = await Reflect.apply(withReadOwner, lease, [
                                AbortSignal.any([this.#signal, policySignal, operationSignal]),
                                async (current) => {
                                  if (started) throw unavailable();
                                  started = true;
                                  assertPolicyOwner();
                                  const policy = Reflect.apply(selectedPolicy, policyOwner, []);
                                  await withPreparedRepositoryBarrierReadScope(
                                    policy,
                                    childId,
                                    {
                                      signal: current.signal,
                                      selectedPolicy: () =>
                                        Reflect.apply(selectedPolicy, policyOwner, []),
                                      assertCurrentSync: () => {
                                        current.assertCurrentSync();
                                        assertPolicyOwner();
                                      },
                                      revalidate: async () => {
                                        await current.revalidate();
                                        assertPolicyOwner();
                                      },
                                      assertNativeExecutionCurrent:
                                        nativeCurrent &&
                                        ((policy, commandId) =>
                                          Reflect.apply(nativeCurrent, policyOwner, [
                                            policy,
                                            commandId,
                                          ])),
                                    },
                                    async (readScope) => {
                                      const reader = await capturePreparedRepositoryReader(
                                        readScope,
                                        {
                                          deadline: Date.now() + preparedRepositoryValidationReadMs,
                                        },
                                      );
                                      try {
                                        const result: unknown = await action(
                                          new LocalRepositoryReadAccess(reader),
                                        );
                                        if (result !== undefined) throw unavailable();
                                      } finally {
                                        try {
                                          await reader.dispose();
                                        } finally {
                                          await readScope.revalidate();
                                        }
                                      }
                                    },
                                  );
                                  completed = true;
                                },
                              ]);
                              if (
                                !completed ||
                                checked !== undefined ||
                                lease.withQualifiedWorkspaceReadOwner !== withReadOwner
                              )
                                throw unavailable();
                            },
                          },
                        );
                        const transition =
                          this.owners.eventStore.observePreparedRepositoryContinuation(
                            childId,
                          ).preparedRepositoryTransition!;
                        selection.preparePreparedRepositoryPrimary(
                          expected,
                          childId,
                          transition,
                          workspace,
                          {
                            assertCurrentSync: () => {
                              this.assertCurrent();
                              assertConversationCurrentSync();
                            },
                            assertAdoptedSync: () =>
                              this.owners.workspace.assertPreparedRepositoryTransitionAdopted(
                                facts,
                                childId,
                              ),
                          },
                        );
                        this.#preparedPrimaryCommandId = childId;
                        let committed = false;
                        return {
                          assertCurrentSync: () => {
                            this.assertCurrent();
                            lease.assertCurrentSync();
                            workspace.assertCurrentSync(nextExpected.workspace.cwd);
                          },
                          commit: () => {
                            if (committed) throw unavailable();
                            this.assertCurrent();
                            lease.assertCurrentSync();
                            workspace.assertCurrentSync(nextExpected.workspace.cwd);
                            this.#adoptedWorkspaceOwner = workspace;
                            this.#adoptedWorkspace = workspace.get();
                            this.#expected = structuredClone(nextExpected);
                            committed = true;
                          },
                        };
                      },
                    });
                    return {
                      ...result.workspace,
                      repositoryWorkspace: this.owners.workspace.getForConversation(
                        input.conversationId,
                      )!,
                    };
                  } finally {
                    primarySource?.dispose();
                    if (
                      transitionBarrier &&
                      this.#workspaceTransitionBarrier === transitionBarrier
                    ) {
                      this.#workspaceTransitionBarrier = undefined;
                      transitionBarrier.release();
                    }
                  }
                },
              }),
            };
            const admission = resume
              ? OwnedLocalCodexChatAdmission.captureResume({
                  ...owner,
                  nativeStore: this.owners.nativeStore!,
                  custody: custody!,
                })
              : OwnedLocalCodexChatAdmission.capture(owner);
            this.#lease = lease;
            if (coldWorkspace) {
              this.#adoptedWorkspaceOwner = coldWorkspace;
              this.#adoptedWorkspace = coldWorkspace.get();
            }
            this.#admission = admission;
            this.#liveThreadOwner = coldThreadOwner;
            this.#expected = structuredClone(expected);
            this.#workspace = structuredClone(claimedWorkspace);
            await this.owners.dispatch({
              admission,
              lease,
              profile: lease.profile,
              expected: structuredClone(expected),
              workspace: structuredClone(claimedWorkspace),
              payload: structuredClone(payload),
              sessionId: this.#reservation.conversationId,
              commandId: this.owners.commandId,
              resume,
              recovery: !!recovery,
            });
            this.assertCurrent();
            lease.assertCurrentSync();
          },
        },
      );
      if (!result.dispatched && coldThreadOwner !== this.#liveThreadOwner)
        coldThreadOwner?.dispose();
      return result;
    } catch (error) {
      // A rejected later retry must not dispose the original live conversation.
      // Nor may a losing concurrent call abort the shared operator lifetime.
      // Failed native attempts retain uncertainty and close only their own client;
      // explicit close, operator invalidation and task cancellation own this driver.
      const lease = bootstrap?.currentLease();
      if (lease && lease !== retainedLease) lease.close();
      if (coldThreadOwner !== this.#liveThreadOwner || this.#lease !== retainedLease)
        coldThreadOwner?.dispose();
      const capabilityError = findNativeMacExecutionUnavailable(error);
      if (capabilityError) throw capabilityError;
      throw unavailable();
    }
  }

  /** Admit a new explicit user command into the original live native FIFO.
   * This cannot reopen a closed owner or replay a retained uncertain command.
   */
  async admitContinuation(
    raw: unknown,
    preparationSignal?: AbortSignal,
    peer?: { messageId: string; assertCurrent(): void },
    assertCredentialSetupCurrent?: () => void,
  ): Promise<{ dispatched: boolean }> {
    raw = structuredClone(raw);
    // Preserve arrival order even when model qualification crosses awaits.
    // A transition drains preceding admissions, then later requests wait for
    // its committed workspace before gaining any execution admission.
    const barrier = this.#workspaceTransitionBarrier;
    this.#pendingContinuations++;
    const operation = this.#continuationAdmissionTail
      .then(async () => {
        if (barrier) await barrier.ready;
        return this.admitContinuationNow(
          raw,
          preparationSignal,
          peer,
          assertCredentialSetupCurrent,
        );
      })
      .finally(() => {
        this.#pendingContinuations--;
      });
    this.#continuationAdmissionTail = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
  private async admitContinuationNow(
    raw: unknown,
    preparationSignal?: AbortSignal,
    peer?: { messageId: string; assertCurrent(): void },
    assertCredentialSetupCurrent?: () => void,
  ): Promise<{ dispatched: boolean }> {
    const assertAdmissionCurrent = () => {
      preparationSignal?.throwIfAborted();
      peer?.assertCurrent();
      assertCredentialSetupCurrent?.();
      this.assertCurrent();
    };
    try {
      assertAdmissionCurrent();
      const lease = this.#lease,
        admission = this.#admission,
        original = this.#expected,
        workspace = this.#adoptedWorkspace ?? this.#workspace;
      if (!lease || !admission || !original || !workspace || !this.owners.dispatchContinuation)
        throw unavailable();
      const request = OrdinaryLocalCodexCommandRequestSchema.parse(raw);
      const rawPayload = RawPayload.parse(request.payload);
      assembleSourceSnapshots(rawPayload.text, rawPayload.sourceSnapshots);
      const profiles = loadAccountProfiles();
      const binding = profiles.resolve(request.runtime.account.accountId, request.selection.model);
      profiles.validateModelSelection(binding, request.selection.model, request.selection.thinking);
      const payload: Payload = {
        ...rawPayload,
        systemPrompt: resolveTelosWorkSystemPrompt(
          this.owners.eventStore,
          this.#reservation.conversationId,
          this.#reservation.binding,
          buildAgentProfilePrompt(original.agentProfile!.definition),
        ),
      };
      let modelQualification: Promise<void> | undefined;
      const assertSelection = async (
        expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>,
      ) => {
        assertAdmissionCurrent();
        admission.assertCurrentSync();
        if (
          !isDeepStrictEqual(expected.binding, original.binding) ||
          !isDeepStrictEqual(expected.workspace, original.workspace) ||
          !isDeepStrictEqual(expected.agentProfile, original.agentProfile) ||
          !isDeepStrictEqual(expected.agentContext, original.agentContext) ||
          !isDeepStrictEqual(expected.selection.agent, original.selection.agent) ||
          !isDeepStrictEqual(expected.selection.context, original.selection.context) ||
          !isDeepStrictEqual(expected.selection.permission, original.selection.permission) ||
          expected.hostId !== original.hostId ||
          expected.runtimeContractRevision !== original.runtimeContractRevision
        )
          throw unavailable();
        const current = loadAccountProfiles();
        const selected = current.resolve(
          expected.binding.account.accountId,
          expected.selection.model,
        );
        if (
          selected.profileRevision !== original.binding.account.profileRevision ||
          selected.provider !== original.binding.account.provider
        )
          throw unavailable();
        current.validateModelSelection(
          selected,
          expected.selection.model,
          expected.selection.thinking,
        );
        await lease.assertCurrent();
        assertAdmissionCurrent();
        const qualifyModels = async () => {
          if (lease.qualifyModelSelection) {
            await lease.qualifyModelSelection(
              expected.selection.model,
              expected.selection.thinking,
            );
            return;
          }
          let pages = 0;
          const models = await readCodexModels({
            request: async (method, params) => {
              assertAdmissionCurrent();
              if (++pages > 16) throw unavailable();
              const response = await lease.client.request(method, params);
              assertAdmissionCurrent();
              admission.assertCurrentSync();
              if (Buffer.byteLength(JSON.stringify(response), 'utf8') > 1048576)
                throw unavailable();
              z.object({
                data: z.array(z.unknown()).max(100),
                nextCursor: z.string().min(1).max(200).nullable().optional(),
              }).parse(response);
              return response;
            },
          });
          const model = models.find((entry) => entry.id === expected.selection.model);
          if (
            !model ||
            (expected.selection.thinking === null
              ? !!model.reasoningEfforts?.length
              : !model.reasoningEfforts?.includes(expected.selection.thinking))
          )
            throw unavailable();
        };
        await (modelQualification ??= qualifyModels());
        assertAdmissionCurrent();
        admission.assertCurrentSync();
      };
      const target = this.#runtime.target();
      const coordinator = new OrdinaryLocalCodexAdmissionCoordinator({
        enabled: this.owners.enabled,
        store: {
          qualifiesOrdinaryCommandCapability:
            this.owners.eventStore.qualifiesOrdinaryCommandCapability.bind(this.owners.eventStore),
          admitOrdinaryLocalContinuation: (...args) => {
            assertAdmissionCurrent();
            const primary = admission.currentPreparedRepositoryPrimaryCommandId();
            return primary
              ? this.owners.eventStore.admitPreparedRepositoryPrimaryContinuation(...args, primary)
              : this.owners.eventStore.admitOrdinaryLocalContinuation(...args);
          },
          admitOrdinaryLocalCommand: (...args) => {
            assertAdmissionCurrent();
            return this.owners.eventStore.admitOrdinaryLocalCommand(...args);
          },
          claimOrdinaryLocalCommandDispatch: (...args) => {
            assertAdmissionCurrent();
            return this.owners.eventStore.claimOrdinaryLocalCommandDispatch(...args);
          },
          completeOrdinaryLocalCommand: (...args) => {
            assertAdmissionCurrent();
            return this.owners.eventStore.completeOrdinaryLocalCommand(...args);
          },
        },
        ...this.#runtime.continuationConfiguration(
          new OrdinaryLocalCodexCapabilityCatalog(profiles, target, 'ordinary'),
          original.binding.execution.targetRevision,
        ),
        authority: {
          withAdmission: async (expected, operation) => {
            await assertSelection(expected);
            return operation({ assertCurrent: () => assertSelection(expected) });
          },
        },
      });
      return await coordinator.admitContinuation(
        {
          sessionId: this.#reservation.conversationId,
          ...((this.#adoptedWorkspaceOwner ?? this.#workspaceOwner).kind === 'ordinary'
            ? { ordinaryWorkspaceId: workspace.id }
            : { repositoryWorkspaceId: workspace.id }),
          cwd: workspace.directory,
          accountBinding: binding,
          agentProfile: original.agentProfile,
          agentContext: original.agentContext,
          mode: request.selection.permission.mode,
          selectedModel: request.selection.model,
          reasoningEffort: request.selection.thinking,
        },
        { ...request, payload },
        {
          prepareWorkspace: async () => {
            assertAdmissionCurrent();
            await admission.assertCurrent();
            assertAdmissionCurrent();
          },
          dispatch: async (expected, commandId) => {
            assertAdmissionCurrent();
            admission.admitContinuation(commandId, expected);
            await this.owners.dispatchContinuation!({
              admission,
              lease,
              profile: lease.profile,
              expected,
              workspace: structuredClone(workspace),
              payload,
              sessionId: this.#reservation.conversationId,
              commandId,
              preparationSignal,
              ...(peer ? { agentMessageId: peer.messageId } : {}),
              assertCredentialSetupCurrent,
            });
            assertAdmissionCurrent();
          },
        },
      );
    } catch {
      // A rejected future choice must not dispose the original conversation.
      throw unavailable();
    }
  }

  /** Host-only readiness uses the latest consumed settings and the ordinary
   * admission coordinator, without claiming peer-message provenance. */
  async notifyCredentialSetup(notice: CredentialSetupNotification): Promise<boolean> {
    notice.assertCurrent();
    this.assertCurrent();
    const events = this.owners.eventStore;
    const id = this.#reservation.conversationId;
    const saved = events.getOrdinaryLocalCommandAdmission(notice.messageId);
    if (saved && saved.state !== 'consumed') return false;
    const current = saved ?? events.getLatestOrdinaryCommandAdmission(id);
    if (
      current?.state !== 'consumed' ||
      !this.#expected ||
      current.binding.execution.location !== 'local' ||
      current.binding.harness.implementation !== 'codex' ||
      events.getSession(id)?.mode !== current.selection.permission.mode
    )
      throw unavailable();
    const catalog = new OrdinaryLocalCodexCapabilityCatalog(
      loadAccountProfiles(),
      this.#runtime.target(),
      'ordinary',
    );
    const result = await this.admitContinuation(
      {
        clientMsgId: notice.messageId,
        capabilityRevision: catalog.inventory().capabilityRevision,
        runtime: {
          account: current.binding.account,
          harness: 'codex',
          targetId: current.binding.execution.targetId,
          mode: current.selection.permission.mode,
        },
        selection: current.selection,
        payload: { text: notice.prompt },
      },
      notice.signal,
      undefined,
      notice.assertCurrent,
    );
    notice.assertCurrent();
    return (
      result.dispatched ||
      events.getOrdinaryLocalCommandAdmission(notice.messageId)?.state === 'consumed'
    );
  }

  /** A separately approved native agent tool may enqueue exactly its retained
   * peer message. The ordinary account/context/workspace/permission coordinator
   * still owns every effect. No public payload can select this entry point. */
  async admitAgentMessage(messageId: string, assertSenderCurrent: () => void, signal: AbortSignal) {
    const assertCurrent = () => {
      signal.throwIfAborted();
      assertSenderCurrent();
      this.assertCurrent();
      const retained = this.owners.eventStore.agentCommunication.forHost(messageId);
      if (
        retained.operatorAuthSessionId !== this.#authSessionId ||
        retained.message.recipientConversationId !== this.#reservation.conversationId ||
        retained.message.status !== 'uncertain'
      )
        throw unavailable();
      return retained.message;
    };
    const message = assertCurrent();
    const current = this.owners.eventStore.getLatestOrdinaryCommandAdmission(
      this.#reservation.conversationId,
    );
    if (
      !current ||
      current.state !== 'consumed' ||
      current.binding.harness.implementation !== 'codex' ||
      !this.#expected
    )
      throw unavailable();
    const catalog = new OrdinaryLocalCodexCapabilityCatalog(
      loadAccountProfiles(),
      this.#runtime.target(),
      'ordinary',
    );
    return this.admitContinuation(
      {
        clientMsgId: message.commandId,
        capabilityRevision: catalog.inventory().capabilityRevision,
        runtime: {
          account: current.binding.account,
          harness: 'codex',
          targetId: current.binding.execution.targetId,
          mode: current.selection.permission.mode,
        },
        selection: current.selection,
        payload: { text: agentMessagePrompt(message) },
      },
      signal,
      { messageId, assertCurrent },
    );
  }

  private assertCurrent(): void {
    if (this.#closed) throw unavailable();
    this.#signal.throwIfAborted();
    this.#operator.assertCurrent();
    resolveTelosWorkRoleContext(
      this.owners.eventStore,
      this.#reservation.conversationId,
      this.owners.eventStore.getSession(this.#reservation.conversationId)?.accountBinding ??
        undefined,
    );
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#workspaceTransitionBarrier?.release();
    this.#workspaceTransitionBarrier = undefined;
    this.#controller.abort(unavailable());
    this.#signal?.removeEventListener('abort', this.#onAbort);
    this.#operator?.release();
    this.#liveThreadOwner?.dispose();
    this.#lease?.close();
  }
}
