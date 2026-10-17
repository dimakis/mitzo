import {
  resolveTelosWorkRoleContext,
  resolveTelosWorkSystemPrompt,
} from './telos-work-role-context.js';
import { SourceSnapshotsSchema } from '@mitzo/protocol';
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
  RepositoryWorkspace,
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

const unavailable = () => new Error('Owned local Codex runtime unavailable');
const RawPayload = z.strictObject({
  sourceSnapshots: SourceSnapshotsSchema.optional(),
  text: z.string().min(1).max(1_000_000),
  intent: z.string().max(1_000_000).optional(),
  images: z
    .array(z.strictObject({ data: z.string().min(1), mediaType: z.string().min(1).max(128) }))
    .max(16)
    .optional(),
});
type Payload = z.infer<typeof RawPayload> & { systemPrompt: string };
export interface OrdinaryLocalCodexOwnedDispatch {
  admission: OwnedLocalCodexChatAdmission;
  lease: FrozenHostCodexBootstrapLease;
  profile: FrozenHostCodexBootstrapLease['profile'];
  expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>;
  workspace: RepositoryWorkspace;
  payload: Payload;
  sessionId: string;
  commandId: string;
  resume?: boolean;
  preparationSignal?: AbortSignal;
}
interface Owners {
  enabled: boolean;
  eventStore: EventStore;
  library: AgentLibraryStore;
  workspace: RepositoryWorkspaces;
  reservation: Omit<HostRepositoryReservationInput, 'signal'>;
  commandId: string;
  /** Middleware-authenticated connection captured once, never supplied by request JSON. */
  operatorConnectionId: string;
  signal: AbortSignal;
  env?: Readonly<NodeJS.ProcessEnv>;
  privateRoot?: string;
  nativeStore?: CodexConversationStore;
  /** Only native transport creation is replaceable for offline qualification. */
  launch?: (privateHome: string, executable: FrozenHostCodexExecutable) => FrozenHostCodexClient;
  /** Existing chat/conversation owner opens/enqueues the exact first command
   * while the receipt is uncertain. Retain its prepared event-loop handle here;
   * pump that handle only after admit returns dispatched:true (consumed), so
   * fast turn completion cannot dispose the lease before coordinator completion.
   */
  dispatch(input: OrdinaryLocalCodexOwnedDispatch): Promise<void>;
  /** Existing live native FIFO owner; absent means first-command-only. */
  dispatchContinuation?(input: OrdinaryLocalCodexOwnedDispatch): Promise<void>;
}

/** Server-internal composition for one reserved local first command. No endpoint,
 * automatic enrollment, provider loop or second ledger is introduced. The exact
 * interactive subject survives transport detach and remains revocation-bound.
 */
export class OrdinaryLocalCodexOwnedRuntime {
  readonly #reservation: Owners['reservation'];
  readonly #runtime: OrdinaryLocalCodexHostRuntime;
  readonly #controller = new AbortController();
  readonly #signal: AbortSignal;
  readonly #operator: ReturnType<typeof retainAgentContextAuthority>;
  #lease?: FrozenHostCodexBootstrapLease;
  #admission?: OwnedLocalCodexChatAdmission;
  #expected?: Readonly<OrdinaryLocalCodexAdmissionExpectation>;
  #workspace?: RepositoryWorkspace;
  #authSessionId?: string;
  #closed = false;
  readonly #onAbort = () => this.close();

  constructor(private readonly owners: Owners) {
    try {
      if (!owners.enabled || custodianControllerMode || custodianOwnerMode) throw unavailable();
      this.owners = {
        ...owners,
        reservation: structuredClone(owners.reservation),
        env: owners.env ? { ...owners.env } : undefined,
        dispatch: owners.dispatch.bind(owners),
        dispatchContinuation: owners.dispatchContinuation?.bind(owners),
      };
      owners = this.owners;
      owners.signal.throwIfAborted();
      const captured = captureAgentLibraryAuthorization(owners.operatorConnectionId);
      captured.assertCurrent();
      this.#authSessionId = captured.auth.id;
      this.#reservation = structuredClone(owners.reservation);
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

  async admit(raw: unknown): Promise<{ dispatched: boolean }> {
    return this.admitCommand(raw, false);
  }
  async admitPreparedFirst(operationId: string, raw: unknown): Promise<{ dispatched: boolean }> {
    if (!operationId) throw unavailable();
    return this.admitCommand(raw, false, operationId);
  }
  async admitResume(raw: unknown): Promise<{ dispatched: boolean }> {
    return this.admitCommand(raw, true);
  }
  private async admitCommand(
    raw: unknown,
    resume: boolean,
    preparationOperationId?: string,
  ): Promise<{ dispatched: boolean }> {
    let bootstrap: FrozenHostCodexBootstrapAuthority | undefined;
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
      const profile = profiles.codexProfile(binding);
      if (profile.workspaceId !== undefined) throw unavailable();
      const descriptor = this.owners.workspace.getHostReservation(this.#reservation);
      const custody = resume
        ? this.owners.nativeStore?.readHostCustody(
            this.#reservation.conversationId,
            this.#reservation.binding,
          )
        : undefined;
      if (
        resume &&
        (!hasPersistentRevocationAuthority() ||
          !custody ||
          custody.authSessionId !== this.#authSessionId ||
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
      const selection = new OrdinaryLocalCodexSelectionOwner({
        events: this.owners.eventStore,
        library: this.owners.library,
        workspace: this.owners.workspace,
        reservation: this.#reservation,
        operator: { assertCurrent: () => this.assertCurrent() },
        signal: this.#signal,
        commandId: this.owners.commandId,
        continuation: resume,
        preparationOperationId,
      });
      const bridge = new OwnedCodexLifecycleBridge(() => bootstrap?.currentLease());
      bootstrap = new FrozenHostCodexBootstrapAuthority({
        loadProfiles: loadAccountProfiles,
        observeRuntime: () => this.#runtime.observe(),
        assertRuntimeCurrentSync: () => this.#runtime.assertCurrentSync(),
        assertSelectionCurrent: (expected) => selection.assertCurrent(expected),
        assertSelectionCurrentSync: (expected) => selection.assertCurrentSync(expected),
        signal: this.#signal,
        privateRoot: this.owners.privateRoot,
        retainedCustody: custody ?? undefined,
        retainedAccountBinding: resume ? this.#reservation.binding : undefined,
        isSelectionPending: () => {
          const receipt = this.owners.eventStore.getOrdinaryLocalCommandAdmission(
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
              this.owners.eventStore.getOrdinaryLocalCommandAdmission(this.owners.commandId)
                ?.state === 'consumed'
            )
              throw unavailable();
            return [];
          }
        },
        baseEnv: this.owners.env,
        lifecycle: bridge.lifecycle,
        launch: this.owners.launch,
      });
      const coordinator = new OrdinaryLocalCodexAdmissionCoordinator({
        enabled: this.owners.enabled,
        store: this.owners.eventStore,
        catalog,
        declaration: target.admissionDeclaration(),
        bootstrapAuthority: bootstrap,
      });
      let claimedWorkspace: RepositoryWorkspace | undefined;
      let preparedContext: AgentContextSnapshot | undefined;
      const result = await (
        preparationOperationId
          ? coordinator.admitPreparedFirst.bind(coordinator, preparationOperationId)
          : resume
            ? coordinator.admitResume.bind(coordinator)
            : coordinator.admit.bind(coordinator)
      )(
        {
          sessionId: this.#reservation.conversationId,
          repositoryWorkspaceId: descriptor.id,
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
        { ...request, payload },
        {
          prepareWorkspace: async (expected) => {
            this.assertCurrent();
            if (
              expected.workspace.workspaceId !== descriptor.id ||
              expected.workspace.cwd !== descriptor.directory
            )
              throw unavailable();
            if (resume) {
              await this.owners.workspace.validateHostTask(
                this.#reservation.conversationId,
                descriptor.directory!,
              );
              claimedWorkspace =
                this.owners.workspace.getForConversation(this.#reservation.conversationId) ??
                undefined;
            } else
              claimedWorkspace = await this.owners.workspace.claimReservedHostTask({
                ...structuredClone(this.#reservation),
                signal: this.#signal,
              });
            this.assertCurrent();
            if (
              !claimedWorkspace ||
              claimedWorkspace.id !== expected.workspace.workspaceId ||
              claimedWorkspace.directory !== expected.workspace.cwd ||
              claimedWorkspace.state !== 'claimed' ||
              claimedWorkspace.sandbox === true
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
            const owner = {
              eventStore: this.owners.eventStore,
              sessionId: this.#reservation.conversationId,
              commandId: this.owners.commandId,
              expected,
              lease,
              bridge,
              authSessionId: this.#authSessionId,
              nativeStore: this.owners.nativeStore,
            };
            const admission = resume
              ? OwnedLocalCodexChatAdmission.captureResume({
                  ...owner,
                  nativeStore: this.owners.nativeStore!,
                  custody: custody!,
                })
              : OwnedLocalCodexChatAdmission.capture(owner);
            this.#lease = lease;
            this.#admission = admission;
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
            });
            this.assertCurrent();
            lease.assertCurrentSync();
          },
        },
      );
      return result;
    } catch {
      // A rejected later retry must not dispose the original live conversation.
      // Nor may a losing concurrent call abort the shared operator lifetime.
      // Failed native attempts retain uncertainty and close only their own client;
      // explicit close, operator invalidation and task cancellation own this driver.
      const lease = bootstrap?.currentLease();
      if (lease && lease !== retainedLease) lease.close();
      throw unavailable();
    }
  }

  /** Admit a new explicit user command into the original live native FIFO.
   * This cannot reopen a closed owner or replay a retained uncertain command.
   */
  async admitContinuation(
    raw: unknown,
    preparationSignal?: AbortSignal,
  ): Promise<{ dispatched: boolean }> {
    const assertAdmissionCurrent = () => {
      preparationSignal?.throwIfAborted();
      this.assertCurrent();
    };
    try {
      assertAdmissionCurrent();
      const lease = this.#lease,
        admission = this.#admission,
        original = this.#expected,
        workspace = this.#workspace;
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
        let pages = 0;
        const models = await readCodexModels({
          request: async (method, params) => {
            assertAdmissionCurrent();
            if (++pages > 16) throw unavailable();
            const response = await lease.client.request(method, params);
            assertAdmissionCurrent();
            admission.assertCurrentSync();
            if (Buffer.byteLength(JSON.stringify(response), 'utf8') > 1048576) throw unavailable();
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
        assertAdmissionCurrent();
        admission.assertCurrentSync();
      };
      const target = this.#runtime.target();
      const coordinator = new OrdinaryLocalCodexAdmissionCoordinator({
        enabled: this.owners.enabled,
        store: {
          admitOrdinaryLocalContinuation: (...args) => {
            assertAdmissionCurrent();
            return this.owners.eventStore.admitOrdinaryLocalContinuation(...args);
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
        catalog: new OrdinaryLocalCodexCapabilityCatalog(profiles, target, 'ordinary'),
        declaration: target.admissionDeclaration(),
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
          repositoryWorkspaceId: workspace.id,
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
    this.#controller.abort(unavailable());
    this.#signal?.removeEventListener('abort', this.#onAbort);
    this.#operator?.release();
    this.#lease?.close();
  }
}
