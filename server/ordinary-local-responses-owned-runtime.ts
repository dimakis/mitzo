import { assembleSourceSnapshots } from './source-snapshot-context.js';
import { assertAgentToolRoute } from './agent-tool-selection.js';
import { readOrdinaryCodexAgentProfile as readResponsesAgentProfile } from './ordinary-codex-agent-profile.js';
import { registerWorkspaceRuntimeAuthorityPaths } from './workspace-runtime-private-paths.js';
import { GoogleAuth } from 'google-auth-library';
import { VertexAdcCustody } from './ordinary-local-vertex-custody.js';
import type { GeminiOptions } from './gemini-session.js';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { LocalResponsesFirstCommandSchema, type AccountBinding } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { AgentLibraryStore } from './agent-library-store.js';
import type {
  HostRepositoryReservationInput,
  RepositoryWorkspaces,
  RepositoryWorkspace,
} from './repository-workspaces.js';
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
import { retainAgentContextAuthority } from './agent-context-authority.js';
import { loadAccountProfiles } from './account-profiles.js';
import { openAIAccountKeyAuthority } from './openai-account-key-authority.js';
import { hasPersistentRevocationAuthority } from './auth.js';
import { custodianControllerMode, custodianOwnerMode } from './symposium-custodian-mode.js';
import {
  OrdinaryLocalResponsesTarget,
  localResponsesCapabilities,
} from './ordinary-local-responses-capabilities.js';
import {
  OrdinaryLocalCodexAdmissionCoordinator,
  OrdinaryLocalResponsesCommandRequestSchema,
  OrdinaryLocalGeminiCommandRequestSchema,
  type OrdinaryLocalCodexAdmissionExpectation,
} from './ordinary-local-codex-admission.js';
import { OrdinaryLocalCodexSelectionOwner } from './ordinary-local-codex-selection-owner.js';
import { NativeResponsesStore } from './native-responses-store.js';
import { buildAgentProfilePrompt } from './agent-library-prompt.js';
import { responsesUserContent } from './responses-input.js';
import type { ResponsesCommandAuthority } from './native-responses-runner.js';
const Payload = LocalResponsesFirstCommandSchema.shape.payload;
export interface OrdinaryLocalResponsesOwnedDispatch {
  owner: OrdinaryLocalResponsesOwnedRuntime;
  expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>;
  binding: AccountBinding;
  payload: z.infer<typeof Payload> & { systemPrompt: string };
  workspace: RepositoryWorkspace;
  sessionId: string;
  commandId: string;
  resume: boolean;
}
interface Owners {
  enabled: boolean;
  eventStore: EventStore;
  library: AgentLibraryStore;
  workspace: RepositoryWorkspaces;
  reservation: Omit<HostRepositoryReservationInput, 'signal'>;
  nativeStore: NativeResponsesStore;
  commandId: string;
  operatorConnectionId: string;
  signal: AbortSignal;
  env?: Readonly<NodeJS.ProcessEnv>;
  dispatch(input: OrdinaryLocalResponsesOwnedDispatch): Promise<void>;
  onCommandTerminal?(): void;
  dispatchContinuation?(input: OrdinaryLocalResponsesOwnedDispatch): Promise<void>;
}
const unavailable = () => Error('Owned Local Responses runtime unavailable');
const googleProjectOverrides = [
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',
] as const;
/** Owns admission on existing command, repository, credential and private history stores. */
export class OrdinaryLocalResponsesOwnedRuntime implements ResponsesCommandAuthority {
  readonly #controller = new AbortController();
  readonly #signal: AbortSignal;
  readonly #operator: ReturnType<typeof retainAgentContextAuthority>;
  readonly #target: OrdinaryLocalResponsesTarget;
  readonly authSessionId: string;
  readonly #commands = new Map<
    string,
    {
      expected: OrdinaryLocalCodexAdmissionExpectation;
      selection: OrdinaryLocalCodexSelectionOwner;
      payload: OrdinaryLocalResponsesOwnedDispatch['payload'];
    }
  >();
  readonly #adc?: VertexAdcCustody;
  readonly #adcEnv?: Readonly<Record<string, string | undefined>>;
  #closed = false;
  #initialized = false;
  #active?: string;
  constructor(private readonly owners: Owners) {
    if (owners.reservation.binding.provider !== 'google-vertex')
      throw Error('Custom Responses execution is retired; review a linked native continuation');
    if (!owners.enabled || custodianControllerMode || custodianOwnerMode) throw unavailable();
    owners.signal.throwIfAborted();
    this.owners = {
      ...owners,
      reservation: structuredClone(owners.reservation),
      env: owners.env ? { ...owners.env } : undefined,
    };
    const captured = captureAgentLibraryAuthorization(owners.operatorConnectionId);
    captured.assertCurrent();
    this.authSessionId = captured.auth.id;
    this.#signal = AbortSignal.any([owners.signal, this.#controller.signal]);
    const google = owners.reservation.binding.provider === 'google-vertex';
    this.#target = new OrdinaryLocalResponsesTarget(owners.env, google ? 'gemini' : 'responses');
    if (google) {
      const profile = loadAccountProfiles().googleProfile(owners.reservation.binding);
      this.#adcEnv = {
        CLAUDE_CODE_USE_VERTEX: '1',
        GOOGLE_APPLICATION_CREDENTIALS: profile.credentialRef,
        ANTHROPIC_VERTEX_PROJECT_ID: profile.projectId,
        CLOUD_ML_REGION: profile.region,
      };
      const retained = owners.nativeStore.readOrdinaryCustody(
        owners.reservation.conversationId,
        owners.reservation.binding,
      );
      this.#adc = retained
        ? VertexAdcCustody.reopen(retained.credentialAuthority, this.#adcEnv)
        : VertexAdcCustody.capture(this.#adcEnv);
      registerWorkspaceRuntimeAuthorityPaths([profile.credentialRef], [profile.credentialRef]);
    }
    this.#operator = retainAgentContextAuthority({ ...captured.auth }, this.#controller);
    this.#signal.addEventListener('abort', () => this.close(), { once: true });
    try {
      this.assertOwner();
    } catch (error) {
      this.#operator.release();
      throw error;
    }
  }
  static assertRetainedCredential(
    binding: AccountBinding,
    custody: ReturnType<NativeResponsesStore['readOrdinaryCustody']>,
  ) {
    if (binding.provider !== 'google-vertex') return;
    if (googleProjectOverrides.some((key) => !!process.env[key])) throw unavailable();
    if (
      !custody?.credentialAuthority ||
      !custody.nativeSelection ||
      custody.nativeSelection.model !== binding.model
    )
      throw unavailable();
    const profile = loadAccountProfiles().googleProfile(binding);
    VertexAdcCustody.reopen(custody.credentialAuthority, {
      CLAUDE_CODE_USE_VERTEX: '1',
      GOOGLE_APPLICATION_CREDENTIALS: profile.credentialRef,
      ANTHROPIC_VERTEX_PROJECT_ID: profile.projectId,
      CLOUD_ML_REGION: profile.region,
    });
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller.abort();
    this.#commands.clear();
    this.#operator.release();
  }
  private assertOwner() {
    if (this.#closed) throw unavailable();
    this.#signal.throwIfAborted();
    this.#operator.assertCurrent();
    this.#target.assertCurrentSync();
    if (
      this.#adc &&
      googleProjectOverrides.some((key) => !!process.env[key] || !!this.owners.env?.[key])
    )
      throw Error(
        'Original Google project authority unavailable: ambient project or quota override',
      );
    this.#adc?.assertCurrent(this.#adcEnv!);
  }
  private manager() {
    const profiles = loadAccountProfiles(),
      binding = this.owners.reservation.binding;
    if (binding.provider === 'google-vertex') {
      const profile = profiles.googleProfile(binding);
      if (
        profile.projectId !== this.#adcEnv?.ANTHROPIC_VERTEX_PROJECT_ID ||
        profile.region !== this.#adcEnv?.CLOUD_ML_REGION ||
        profile.credentialRef !== this.#adcEnv?.GOOGLE_APPLICATION_CREDENTIALS
      )
        throw unavailable();
      this.#adc!.assertCurrent(this.#adcEnv!);
      return undefined;
    }
    return openAIAccountKeyAuthority(binding, profiles);
  }
  geminiOptions(): GeminiOptions {
    this.assertOwner();
    this.manager();
    if (!this.#adc || !this.#adcEnv) throw unavailable();
    return {
      accountId: this.owners.reservation.binding.accountId,
      projectId: this.#adcEnv.ANTHROPIC_VERTEX_PROJECT_ID!,
      region: this.#adcEnv.CLOUD_ML_REGION!,
      getAccessToken: async () => {
        const commandId = this.activeCommandId();
        if (!commandId) throw unavailable();
        await this.assertEffect(commandId);
        const auth = new GoogleAuth({
          credentials: this.#adc!.credentials(this.#adcEnv!),
          projectId: this.#adcEnv!.ANTHROPIC_VERTEX_PROJECT_ID,
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        });
        const token = await auth.getAccessToken();
        await this.assertEffect(commandId);
        if (!token) throw unavailable();
        return token;
      },
    };
  }
  private assertNativeSelection(selection: { model: string; thinking: string | null }) {
    if (!this.#adc) return;
    const custody = this.owners.nativeStore.readOrdinaryCustody(
      this.owners.reservation.conversationId,
      this.owners.reservation.binding,
    );
    const state = this.owners.nativeStore.load(
      this.owners.reservation.conversationId,
      this.owners.reservation.binding,
    );
    if (
      selection.model !== this.owners.reservation.binding.model ||
      (custody &&
        (!custody.nativeSelection ||
          custody.nativeSelection.model !== selection.model ||
          custody.nativeSelection.reasoningEffort !== selection.thinking)) ||
      (state?.checkpoint && state.checkpoint.model !== selection.model) ||
      (state?.nativeSelection &&
        (state.nativeSelection.model !== selection.model ||
          state.nativeSelection.reasoningEffort !== selection.thinking))
    )
      throw Error(
        'Continue with the original Gemini model and thinking. Start another conversation to change them.',
      );
  }
  async resolveKey(commandId: string, signal?: AbortSignal): Promise<string> {
    const credentialSignal = signal ? AbortSignal.any([this.#signal, signal]) : this.#signal;
    credentialSignal.throwIfAborted();
    await this.assertEffect(commandId);
    credentialSignal.throwIfAborted();
    const manager = this.manager();
    if (!manager) throw unavailable();
    const key = await manager.resolveKey(
      this.owners.reservation.binding.accountId,
      credentialSignal,
    );
    await this.assertEffect(commandId);
    credentialSignal.throwIfAborted();
    if (!key.trim()) throw unavailable();
    return key;
  }
  assertSetupSync(commandId: string) {
    this.assertOwner();
    const command = this.#commands.get(commandId);
    if (!command) throw unavailable();
    const receipt = this.owners.eventStore.getOrdinaryLocalResponsesCommandAdmission(commandId);
    if (!receipt || !['uncertain', 'consumed'].includes(receipt.state)) throw unavailable();
    const queue = this.owners.nativeStore.queue(
      this.owners.reservation.conversationId,
      this.owners.reservation.binding,
    );
    if (queue.active !== commandId && !queue.queued.includes(commandId)) throw unavailable();
    command.selection.assertCurrentSync(command.expected);
    this.assertNativeSelection(command.expected.selection);
    this.manager();
    loadAccountProfiles().validateModelSelection(
      this.owners.reservation.binding,
      command.expected.selection.model,
      command.expected.selection.thinking,
    );
  }
  async assertSetup(commandId: string) {
    this.assertSetupSync(commandId);
    const command = this.#commands.get(commandId)!;
    await command.selection.assertCurrent(command.expected);
    this.assertSetupSync(commandId);
  }
  assertPrepare(
    commandId: string,
    content: Parameters<ResponsesCommandAuthority['assertPrepare']>[1],
    selection?: { model?: string; reasoningEffort?: string | null },
  ) {
    this.assertOwner();
    const command = this.#commands.get(commandId),
      receipt = this.owners.eventStore.getOrdinaryLocalResponsesCommandAdmission(commandId);
    if (
      !command ||
      !receipt ||
      !['uncertain', 'consumed'].includes(receipt.state) ||
      !isDeepStrictEqual(receipt.selection, command.expected.selection) ||
      !isDeepStrictEqual(
        content,
        responsesUserContent(
          assembleSourceSnapshots(command.payload.text, command.payload.sourceSnapshots),
          command.payload.images,
        ),
      ) ||
      selection?.model !== command.expected.selection.model ||
      selection?.reasoningEffort !== command.expected.selection.thinking
    )
      throw unavailable();
    command.selection.assertCurrentSync(command.expected);
  }
  assertStart(commandId: string) {
    this.assertOwner();
    const command = this.#commands.get(commandId);
    if (
      !command ||
      this.owners.nativeStore.queue(
        this.owners.reservation.conversationId,
        this.owners.reservation.binding,
      ).active !== commandId ||
      this.owners.eventStore.getOrdinaryLocalResponsesCommandAdmission(commandId)?.state !==
        'consumed' ||
      (this.#active && this.#active !== commandId)
    )
      throw unavailable();
    command.selection.assertCurrentSync(command.expected);
    this.assertNativeSelection(command.expected.selection);
    this.manager();
    loadAccountProfiles().validateModelSelection(
      this.owners.reservation.binding,
      command.expected.selection.model,
      command.expected.selection.thinking,
    );
    this.#active = commandId;
  }
  async assertEffect(commandId: string) {
    this.assertStart(commandId);
    const command = this.#commands.get(commandId)!;
    await command.selection.assertCurrent(command.expected);
    this.assertStart(commandId);
  }
  get signal() {
    return this.#signal;
  }
  activeCommandId() {
    return this.#active;
  }
  hasPendingCommand(commandId: string) {
    return this.#commands.has(commandId);
  }
  commandTerminal(commandId: string) {
    const native = this.owners.nativeStore,
      reservation = this.owners.reservation;
    if (native.queue(reservation.conversationId, reservation.binding).active === commandId)
      native.finishCommand(reservation.conversationId, reservation.binding, commandId);
    this.#commands.delete(commandId);
    if (this.#active === commandId) this.#active = undefined;
    if (!this.#closed) this.owners.onCommandTerminal?.();
  }
  interruptQueue() {
    if (!this.#closed)
      this.owners.nativeStore.pauseQueue(
        this.owners.reservation.conversationId,
        this.owners.reservation.binding,
      );
  }
  resumeQueue() {
    this.assertOwner();
    this.owners.nativeStore.pauseQueue(
      this.owners.reservation.conversationId,
      this.owners.reservation.binding,
      false,
    );
    this.owners.onCommandTerminal?.();
  }
  snapshot(commandId: string) {
    const command = this.#commands.get(commandId);
    if (!command) throw unavailable();
    return structuredClone({ expected: command.expected, payload: command.payload });
  }
  private pruneCancelledAuthorities() {
    if (!this.#initialized) return;
    const queue = this.owners.nativeStore.queue(
      this.owners.reservation.conversationId,
      this.owners.reservation.binding,
    );
    for (const commandId of queue.cancelledIds) this.#commands.delete(commandId);
  }
  async claimNextCommand(): Promise<string | undefined> {
    this.assertOwner();
    const reservation = this.owners.reservation,
      native = this.owners.nativeStore;
    for (let attempt = 0; attempt < 32; attempt++) {
      const queue = native.queue(reservation.conversationId, reservation.binding),
        id = queue.queued[0];
      const meta = this.owners.eventStore.getSession(reservation.conversationId);
      if (meta?.executionPhase && meta.executionPhase !== 'TERMINAL') return undefined;
      if (
        !id ||
        queue.active ||
        queue.paused ||
        native.status(reservation.conversationId, reservation.binding) === 'running'
      )
        return undefined;
      if (
        this.owners.eventStore.getOrdinaryLocalResponsesCommandAdmission(id)?.state !== 'consumed'
      )
        return undefined;
      const command = this.#commands.get(id);
      if (!command) throw unavailable();
      await command.selection.assertCurrent(command.expected);
      this.assertOwner();
      if (native.queue(reservation.conversationId, reservation.binding).queued[0] !== id) {
        this.pruneCancelledAuthorities();
        continue;
      }
      this.manager();
      loadAccountProfiles().validateModelSelection(
        reservation.binding,
        command.expected.selection.model,
        command.expected.selection.thinking,
      );
      return native.claimNextCommand(
        reservation.conversationId,
        reservation.binding,
        (candidate) => {
          if (
            candidate !== id ||
            this.owners.eventStore.getOrdinaryLocalResponsesCommandAdmission(id)?.state !==
              'consumed'
          )
            return false;
          this.assertOwner();
          command.selection.assertCurrentSync(command.expected);
          return true;
        },
      );
    }
    // A bounded pass must not strand accepted work if cancellation keeps changing
    // the head; the existing live pump coalesces this scheduling notification.
    this.owners.onCommandTerminal?.();
    return undefined;
  }
  private assertTerminalNativeClaim(commandId: string) {
    const events = this.owners.eventStore,
      id = this.owners.reservation.conversationId;
    const prior = events.getExecutionAdmission(id, commandId),
      meta = events.getSession(id);
    if (
      !prior ||
      meta?.executionPhase !== 'TERMINAL' ||
      meta.executionId !== prior.token.executionId ||
      meta.executionGeneration !== prior.token.generation ||
      !events.getExecutionTerminalReason(prior.token) ||
      this.owners.nativeStore.status(id, this.owners.reservation.binding) === 'running'
    )
      throw unavailable();
  }
  private async restoreQueuedCommands() {
    const reservation = this.owners.reservation,
      events = this.owners.eventStore;
    const queue = this.owners.nativeStore.queue(reservation.conversationId, reservation.binding),
      meta = events.getSession(reservation.conversationId);
    if (!meta?.agentProfile) throw unavailable();
    if (queue.active) this.assertTerminalNativeClaim(queue.active);
    const catalog = localResponsesCapabilities(loadAccountProfiles(), this.#target).inventory();
    const declaration = this.#target.admissionDeclaration();
    for (const commandId of queue.queued) {
      const receipt = events.getOrdinaryLocalResponsesCommandAdmission(commandId),
        send = events.getSendCommand(commandId);
      if (
        !receipt ||
        receipt.state !== 'consumed' ||
        send?.sessionId !== reservation.conversationId ||
        events.getExecutionAdmission(reservation.conversationId, commandId) ||
        !isDeepStrictEqual(
          receipt.binding,
          events.getSessionRuntimeBinding(reservation.conversationId),
        ) ||
        receipt.workspace.workspaceId !== reservation.id ||
        receipt.workspace.cwd !== meta.cwd
      )
        throw unavailable();
      this.assertNativeSelection(receipt.selection);
      const { systemPrompt, ...rawPayload } = send.payload;
      const payload = {
        ...Payload.parse(rawPayload),
        systemPrompt: buildAgentProfilePrompt(meta.agentProfile.definition),
      };
      if (systemPrompt !== payload.systemPrompt) throw unavailable();
      const expected: OrdinaryLocalCodexAdmissionExpectation = {
        binding: receipt.binding,
        hostId: declaration.hostId,
        runtimeContractRevision: declaration.runtimeContractRevision,
        capabilityRevision: catalog.capabilityRevision,
        workspace: receipt.workspace,
        selection: receipt.selection,
        agentProfile: meta.agentProfile,
      };
      const selection = new OrdinaryLocalCodexSelectionOwner({
        events,
        library: this.owners.library,
        workspace: this.owners.workspace,
        reservation,
        operator: this.#operator,
        signal: this.#signal,
        commandId,
        continuation: true,
        responses: true,
      });
      await selection.assertCurrent(expected);
      this.assertOwner();
      loadAccountProfiles().validateModelSelection(
        reservation.binding,
        receipt.selection.model,
        receipt.selection.thinking,
      );
      this.#commands.set(commandId, { expected, selection, payload });
    }
  }
  private assertResumeCustody(descriptor: ReturnType<RepositoryWorkspaces['getHostReservation']>) {
    const previous = this.owners.eventStore.getSession(this.owners.reservation.conversationId);
    if (previous?.executionPhase && previous.executionPhase !== 'TERMINAL') throw unavailable();
    const custody = this.owners.nativeStore.readOrdinaryCustody(
      this.owners.reservation.conversationId,
      this.owners.reservation.binding,
    );
    if (
      !hasPersistentRevocationAuthority() ||
      !custody ||
      custody.authSessionId !== this.authSessionId ||
      !isDeepStrictEqual(
        custody.binding,
        this.owners.eventStore.getSessionRuntimeBinding(this.owners.reservation.conversationId),
      ) ||
      !isDeepStrictEqual(custody.workspace, {
        workspaceId: descriptor.id,
        cwd: descriptor.directory,
      }) ||
      descriptor.state !== 'claimed' ||
      this.owners.nativeStore.status(
        this.owners.reservation.conversationId,
        this.owners.reservation.binding,
      ) === 'running'
    )
      throw unavailable();
    const target = this.#target.descriptor();
    if (
      custody.binding.execution.location !== 'local' ||
      custody.binding.harness.implementation !== (this.#adc ? 'gemini' : 'responses') ||
      custody.binding.execution.targetId !== target.targetId ||
      custody.binding.execution.targetRevision !== target.targetRevision
    )
      throw unavailable();
  }

  /** Reopen only positively accepted, never-attempted FIFO snapshots; no new command receipt. */
  async reopenRetainedQueue(): Promise<{ dispatched: boolean }> {
    this.assertOwner();
    this.manager();
    const reservation = this.owners.reservation;
    const descriptor = this.owners.workspace.getHostReservation(reservation);
    this.assertResumeCustody(descriptor);
    if (this.owners.eventStore.hasUncertainOrdinaryCommand(reservation.conversationId))
      throw unavailable();
    await this.restoreQueuedCommands();
    this.assertOwner();
    const queue = this.owners.nativeStore.queue(reservation.conversationId, reservation.binding);
    if (queue.active) {
      this.assertTerminalNativeClaim(queue.active);
      this.owners.nativeStore.finishCommand(
        reservation.conversationId,
        reservation.binding,
        queue.active,
      );
    }
    const commandId = queue.queued[0];
    if (!commandId || commandId !== this.owners.commandId) throw unavailable();
    const selected = this.snapshot(commandId);
    const workspace = this.owners.workspace.getForConversation(reservation.conversationId);
    if (
      !workspace ||
      workspace.state !== 'claimed' ||
      workspace.sandbox ||
      workspace.directory !== selected.expected.workspace.cwd
    )
      throw unavailable();
    this.assertSetupSync(commandId);
    await this.owners.dispatch({
      owner: this,
      ...selected,
      binding: structuredClone(reservation.binding),
      workspace,
      sessionId: reservation.conversationId,
      commandId,
      resume: true,
    });
    this.assertSetupSync(commandId);
    this.#initialized = true;
    this.resumeQueue();
    return { dispatched: true };
  }

  admit(input: unknown) {
    return this.admitCommand(input, false, false);
  }
  admitResume(input: unknown) {
    return this.admitCommand(input, true, true);
  }
  admitContinuation(input: unknown, preparationSignal?: AbortSignal) {
    return this.admitCommand(input, true, false, preparationSignal);
  }
  private async admitCommand(
    raw: unknown,
    continuation: boolean,
    resume: boolean,
    preparationSignal?: AbortSignal,
  ): Promise<{ dispatched: boolean }> {
    const assertAdmissionCurrent = () => {
      preparationSignal?.throwIfAborted();
      this.assertOwner();
    };
    assertAdmissionCurrent();
    this.manager();
    this.pruneCancelledAuthorities();
    const request = (
      this.#adc
        ? OrdinaryLocalGeminiCommandRequestSchema
        : OrdinaryLocalResponsesCommandRequestSchema
    ).parse(raw);
    this.assertNativeSelection(request.selection);
    if ((!continuation || resume) && request.clientMsgId !== this.owners.commandId)
      throw unavailable();
    if (continuation && !resume && (!this.#initialized || !this.owners.dispatchContinuation))
      throw unavailable();
    const payload = Payload.parse(request.payload);
    assembleSourceSnapshots(payload.text, payload.sourceSnapshots);
    if (this.#adc && payload.images?.length)
      throw Error('Google Vertex image attachments are unsupported');
    responsesUserContent(payload.text, payload.images);
    const profiles = loadAccountProfiles(),
      original = this.owners.reservation.binding;
    const account = profiles.resolve(request.runtime.account.accountId, request.selection.model);
    if (
      !isDeepStrictEqual(
        {
          accountId: account.accountId,
          provider: account.provider,
          profileRevision: account.profileRevision,
        },
        request.runtime.account,
      ) ||
      account.provider !== (this.#adc ? 'google-vertex' : 'openai') ||
      (!continuation && !isDeepStrictEqual(account, original))
    )
      throw unavailable();
    profiles.validateModelSelection(original, request.selection.model, request.selection.thinking);
    const existing = this.owners.eventStore.getOrdinaryLocalResponsesCommandAdmission(
      request.clientMsgId,
    );
    if (
      continuation &&
      !existing &&
      this.owners.nativeStore.queue(this.owners.reservation.conversationId, original).queued
        .length >= 32
    )
      throw unavailable();
    const descriptor = this.owners.workspace.getHostReservation(this.owners.reservation);
    const queueWasIdle =
      !continuation ||
      resume ||
      !this.owners.nativeStore.queue(this.owners.reservation.conversationId, original).active;
    if (resume) {
      this.assertResumeCustody(descriptor);
      await this.restoreQueuedCommands();
    } else if (!continuation && descriptor.state === 'claimed') {
      const receipt = this.owners.eventStore.getOrdinaryLocalResponsesCommandAdmission(
        request.clientMsgId,
      );
      if (!receipt || !['uncertain', 'consumed'].includes(receipt.state)) throw unavailable();
    }
    const profile = readResponsesAgentProfile(this.owners.library, request.selection.agent);
    if (profile?.definition.contextRecipe)
      throw Error(
        'This runtime does not support the selected reusable context recipe. Choose a plain profile.',
      );
    if (
      !profile ||
      profile.definition.contextRecipe !== undefined ||
      (profile.definition.recipe !== undefined &&
        !profile.definition.recipe.compatibleProviders.some(
          (provider) => provider === original.provider,
        )) ||
      request.selection.context.source !== 'none' ||
      request.selection.context.revision !== null ||
      request.selection.permission.revision !== 0
    )
      throw unavailable();
    assertAgentToolRoute(profile.definition, 'local-api');
    const frozenPayload = { ...payload, systemPrompt: buildAgentProfilePrompt(profile.definition) };
    const admittedRequest = { ...request, payload: frozenPayload };
    const selected = new OrdinaryLocalCodexSelectionOwner({
      events: this.owners.eventStore,
      library: this.owners.library,
      workspace: this.owners.workspace,
      reservation: this.owners.reservation,
      operator: this.#operator,
      signal: this.#signal,
      commandId: request.clientMsgId,
      continuation,
      responses: true,
    });
    const authority = {
      withAdmission: async <T>(
        expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>,
        operation: (lease: { assertCurrent(): Promise<void> }) => Promise<T>,
      ) =>
        operation({
          assertCurrent: async () => {
            assertAdmissionCurrent();
            this.manager();
            loadAccountProfiles().validateModelSelection(
              original,
              expected.selection.model,
              expected.selection.thinking,
            );
            await selected.assertCurrent(expected);
            assertAdmissionCurrent();
          },
        }),
    };
    const catalog = localResponsesCapabilities(profiles, this.#target),
      events = this.owners.eventStore;
    const coordinator = new OrdinaryLocalCodexAdmissionCoordinator({
      enabled: true,
      adapter: this.#adc ? 'gemini' : 'responses',
      catalog,
      declaration: this.#target.admissionDeclaration(),
      authority,
      store: {
        admitOrdinaryLocalCommand: (meta, binding, input) => {
          assertAdmissionCurrent();
          return events.admitOrdinaryLocalResponsesCommand(meta, binding, input);
        },
        admitOrdinaryLocalContinuation: (meta, binding, input) => {
          assertAdmissionCurrent();
          if (
            !events.getOrdinaryLocalResponsesCommandAdmission(input.clientMsgId) &&
            this.owners.nativeStore.queue(this.owners.reservation.conversationId, original).queued
              .length >= 32
          )
            throw unavailable();
          return events.admitOrdinaryLocalResponsesContinuation(meta, binding, input);
        },
        claimOrdinaryLocalCommandDispatch: (id) => {
          assertAdmissionCurrent();
          return events.claimOrdinaryLocalResponsesCommandDispatch(id);
        },
        completeOrdinaryLocalCommand: (id) => {
          assertAdmissionCurrent();
          return events.completeOrdinaryLocalResponsesCommand(id);
        },
      },
    });
    const meta = {
      sessionId: this.owners.reservation.conversationId,
      repositoryWorkspaceId: descriptor.id,
      cwd: descriptor.directory,
      accountBinding: account,
      agentProfile: profile,
      selectedModel: request.selection.model,
      reasoningEffort: request.selection.thinking,
      mode: request.selection.permission.mode,
    };
    let workspace: RepositoryWorkspace | null | undefined;
    const result = await (
      continuation
        ? coordinator.admitContinuation.bind(coordinator)
        : coordinator.admit.bind(coordinator)
    )(meta, admittedRequest, {
      prepareWorkspace: async (expected) => {
        assertAdmissionCurrent();
        if (continuation) {
          await this.owners.workspace.validateHostTask(meta.sessionId, expected.workspace.cwd);
          workspace = this.owners.workspace.getForConversation(meta.sessionId);
        } else
          workspace = await this.owners.workspace.claimReservedHostTask({
            ...this.owners.reservation,
            signal: this.#signal,
          });
        assertAdmissionCurrent();
        if (
          !workspace ||
          workspace.state !== 'claimed' ||
          workspace.sandbox ||
          workspace.directory !== expected.workspace.cwd
        )
          throw unavailable();
      },
      dispatch: async (expected, commandId) => {
        assertAdmissionCurrent();
        const custody = {
          version: 1 as const,
          authSessionId: this.authSessionId,
          binding: expected.binding,
          workspace: expected.workspace,
          ...(this.#adc
            ? {
                credentialAuthority: this.#adc.snapshot(),
                nativeSelection: {
                  model: expected.selection.model,
                  reasoningEffort: expected.selection.thinking,
                },
              }
            : {}),
        };
        this.owners.nativeStore.setOrdinaryCustody(meta.sessionId, original, custody);
        if (resume) {
          const queue = this.owners.nativeStore.queue(meta.sessionId, original);
          if (queue.active) {
            this.assertTerminalNativeClaim(queue.active);
            this.owners.nativeStore.finishCommand(meta.sessionId, original, queue.active);
          }
        }
        this.#commands.set(commandId, {
          expected: structuredClone(expected),
          selection: selected,
          payload: structuredClone(frozenPayload),
        });
        this.owners.nativeStore.enqueueCommand(meta.sessionId, original, commandId);
        assertAdmissionCurrent();
        await (continuation && !resume ? this.owners.dispatchContinuation! : this.owners.dispatch)({
          owner: this,
          expected,
          binding: structuredClone(original),
          payload: frozenPayload,
          workspace: workspace!,
          sessionId: meta.sessionId,
          commandId,
          resume,
        });
      },
    });
    if (result.dispatched) {
      this.#initialized = true;
      if (queueWasIdle) this.resumeQueue();
    }
    return result;
  }
}
