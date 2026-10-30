import { assembleCommandPrompt } from './message-reply-context.js';
import { assertAgentToolRoute } from './agent-tool-selection.js';
import { readOrdinaryCodexAgentProfile } from './ordinary-codex-agent-profile.js';
import { assertOrdinaryLocalVertexHistory } from './ordinary-local-vertex-native-history.js';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { LocalVertexClaudeFirstCommandSchema, type AccountBinding } from '@mitzo/protocol';
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
import { hasPersistentRevocationAuthority } from './auth.js';
import { custodianControllerMode, custodianOwnerMode } from './symposium-custodian-mode.js';
import {
  OrdinaryLocalVertexTarget,
  localVertexCapabilities,
} from './ordinary-local-vertex-capabilities.js';
import {
  OrdinaryLocalCodexAdmissionCoordinator,
  OrdinaryLocalVertexCommandRequestSchema,
  type OrdinaryLocalCodexAdmissionExpectation,
} from './ordinary-local-codex-admission.js';
import { OrdinaryLocalCodexSelectionOwner } from './ordinary-local-codex-selection-owner.js';
import { VertexAdcCustody } from './ordinary-local-vertex-custody.js';
import { buildAgentProfilePrompt } from './agent-library-prompt.js';

const Payload = LocalVertexClaudeFirstCommandSchema.shape.payload;
export interface OrdinaryLocalVertexOwnedDispatch {
  owner: OrdinaryLocalVertexOwnedRuntime;
  expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>;
  binding: AccountBinding;
  payload: z.infer<typeof Payload> & { systemPrompt: string };
  workspace: RepositoryWorkspace;
  sessionId: string;
  commandId: string;
  resume: boolean;
  preparationSignal?: AbortSignal;
}
interface Owners {
  enabled: boolean;
  eventStore: EventStore;
  library: AgentLibraryStore;
  workspace: RepositoryWorkspaces;
  reservation: Omit<HostRepositoryReservationInput, 'signal'>;
  commandId: string;
  operatorConnectionId: string;
  signal: AbortSignal;
  env?: Readonly<NodeJS.ProcessEnv>;
  dispatch(input: OrdinaryLocalVertexOwnedDispatch): Promise<void>;
  dispatchContinuation?(input: OrdinaryLocalVertexOwnedDispatch): Promise<void>;
}
const unavailable = () => Error('Owned Local Vertex runtime unavailable');
/** Owns admission on existing command, repository, credential and private history stores. */
export class OrdinaryLocalVertexOwnedRuntime {
  readonly #controller = new AbortController();
  readonly #signal: AbortSignal;
  readonly #operator: ReturnType<typeof retainAgentContextAuthority>;
  readonly #target: OrdinaryLocalVertexTarget;
  readonly authSessionId: string;
  readonly #commands = new Map<
    string,
    {
      expected: OrdinaryLocalCodexAdmissionExpectation;
      selection: OrdinaryLocalCodexSelectionOwner;
      payload: OrdinaryLocalVertexOwnedDispatch['payload'];
    }
  >();
  #closed = false;
  #initialized = false;
  #active?: string;
  #lastCompleted?: string;
  constructor(private readonly owners: Owners) {
    if (
      !owners.enabled ||
      !process.env.MITZO_ACCOUNT_PROFILES_FILE ||
      custodianControllerMode ||
      custodianOwnerMode
    )
      throw unavailable();
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
    this.#target = new OrdinaryLocalVertexTarget(owners.env);
    this.#operator = retainAgentContextAuthority({ ...captured.auth }, this.#controller);
    this.#signal.addEventListener('abort', () => this.close(), { once: true });
    try {
      this.#operator.assertCurrent();
    } catch (error) {
      this.#operator.release();
      throw error;
    }
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
  }
  environment() {
    const profiles = loadAccountProfiles();
    profiles.resumeRouting(this.owners.reservation.binding);
    return profiles.sdkEnv(
      this.owners.reservation.binding,
      Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    );
  }
  private credentialAuthority() {
    const env = this.environment();
    const custody = this.owners.eventStore.getOrdinaryLocalVertexCustody(
      this.owners.reservation.conversationId,
    );
    if (custody) VertexAdcCustody.reopen(custody.credentialAuthority, env).assertCurrent(env);
    else VertexAdcCustody.capture(env).assertCurrent(env);
  }
  async assertSetup(commandId: string) {
    this.assertOwner();
    const command = this.#commands.get(commandId);
    if (!command) throw unavailable();
    const receipt = this.owners.eventStore.getOrdinaryLocalVertexCommandAdmission(commandId);
    if (!receipt || !['uncertain', 'consumed'].includes(receipt.state)) throw unavailable();
    await command.selection.assertCurrent(command.expected);
    this.assertOwner();
    this.credentialAuthority();
  }
  /** Idle custody remains current without revalidating a completed inference setting. */
  assertIdleSync(commandId: string) {
    this.assertOwner();
    const command = this.#commands.get(commandId);
    const receipt = this.owners.eventStore.getOrdinaryLocalVertexCommandAdmission(commandId);
    if (!command || !receipt || !['uncertain', 'consumed'].includes(receipt.state))
      throw unavailable();
    command.selection.assertCurrentSync(command.expected);
    this.credentialAuthority();
  }
  async assertIdle(commandId: string) {
    this.assertIdleSync(commandId);
    const command = this.#commands.get(commandId)!;
    await command.selection.assertCurrent(command.expected);
    this.assertIdleSync(commandId);
  }
  assertStart(commandId: string) {
    this.assertIdleSync(commandId);
    const command = this.#commands.get(commandId)!;
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
    return this.#active ?? this.#lastCompleted;
  }
  hasPendingCommand(commandId: string) {
    return this.#commands.has(commandId);
  }
  commandTerminal(commandId: string) {
    if (this.#lastCompleted && this.#lastCompleted !== commandId)
      this.#commands.delete(this.#lastCompleted);
    this.#lastCompleted = commandId;
    if (this.#active === commandId) this.#active = undefined;
  }
  /** Reconstitutes only acknowledged, never-started native FIFO entries from the
   * existing ledger after an explicit cold continuation. Reserved/unconfirmed
   * receipts require their original explicit retry and are never replayed here. */
  async restoreAcknowledgedQueue() {
    const events = this.owners.eventStore,
      sessionId = this.owners.reservation.conversationId;
    const meta = events.getSession(sessionId),
      profile = meta?.agentProfile;
    if (!profile || profile.definition.contextRecipe) throw unavailable();
    const declaration = this.#target.admissionDeclaration();
    for (const id of events.getPendingOrdinaryLocalVertexCommandIds(sessionId)) {
      if (this.#commands.has(id)) continue;
      const receipt = events.getOrdinaryLocalVertexCommandAdmission(id)!;
      loadAccountProfiles().validateModelSelection(
        this.owners.reservation.binding,
        receipt.selection.model,
        receipt.selection.thinking,
      );
      const { systemPrompt, ...rawPayload } = events.getSendCommand(id)!.payload;
      const payload = {
        ...Payload.parse(rawPayload),
        systemPrompt: buildAgentProfilePrompt(profile.definition),
      };
      if (systemPrompt !== payload.systemPrompt) throw unavailable();
      const expected: OrdinaryLocalCodexAdmissionExpectation = {
        binding: receipt.binding,
        workspace: receipt.workspace,
        selection: receipt.selection,
        agentProfile: profile,
        hostId: declaration.hostId,
        runtimeContractRevision: declaration.runtimeContractRevision,
        capabilityRevision: localVertexCapabilities(
          loadAccountProfiles(),
          this.#target,
          this.owners.library.list('user').versions,
        ).inventory().capabilityRevision,
      };
      const selection = new OrdinaryLocalCodexSelectionOwner({
        events,
        library: this.owners.library,
        workspace: this.owners.workspace,
        reservation: this.owners.reservation,
        operator: this.#operator,
        signal: this.#signal,
        commandId: id,
        continuation: true,
        vertex: true,
      });
      await selection.assertCurrent(expected);
      this.#commands.set(id, { expected, selection, payload });
    }
    this.assertOwner();
    this.credentialAuthority();
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
    this.credentialAuthority();
    const request = OrdinaryLocalVertexCommandRequestSchema.parse(raw);
    if ((!continuation || resume) && request.clientMsgId !== this.owners.commandId)
      throw unavailable();
    if (continuation && !resume && (!this.#initialized || !this.owners.dispatchContinuation))
      throw unavailable();
    const payload = Payload.parse(request.payload);
    assembleCommandPrompt(
      this.owners.eventStore,
      this.owners.reservation.conversationId,
      request.clientMsgId,
      payload,
    );
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
      account.provider !== 'anthropic-vertex' ||
      (!continuation && !isDeepStrictEqual(account, original))
    )
      throw unavailable();
    profiles.validateModelSelection(original, request.selection.model, request.selection.thinking);
    const descriptor = this.owners.workspace.getHostReservation(this.owners.reservation);
    if (resume) {
      const previous = this.owners.eventStore.getSession(this.owners.reservation.conversationId);
      if (previous?.executionPhase && previous.executionPhase !== 'TERMINAL') throw unavailable();
      const custody = this.owners.eventStore.getOrdinaryLocalVertexCustody(
        this.owners.reservation.conversationId,
      );
      if (
        !hasPersistentRevocationAuthority() ||
        !custody ||
        custody.authSessionId !== this.authSessionId ||
        !isDeepStrictEqual(
          custody.binding,
          this.owners.eventStore.getSessionRuntimeBinding(this.owners.reservation.conversationId),
        ) ||
        custody.repositoryWorkspaceId !== descriptor.id ||
        custody.cwd !== descriptor.directory ||
        descriptor.state !== 'claimed'
      )
        throw unavailable();
      await assertOrdinaryLocalVertexHistory(custody.sdkSessionId, custody.cwd);
      assertAdmissionCurrent();
      this.credentialAuthority();
    } else if (!continuation && descriptor.state === 'claimed') {
      const receipt = this.owners.eventStore.getOrdinaryLocalVertexCommandAdmission(
        request.clientMsgId,
      );
      if (!receipt || !['uncertain', 'consumed'].includes(receipt.state)) throw unavailable();
    }
    const profile = readOrdinaryCodexAgentProfile(this.owners.library, request.selection.agent);
    if (
      !profile ||
      profile.definition.contextRecipe !== undefined ||
      (profile.definition.recipe &&
        !profile.definition.recipe.compatibleProviders.includes('anthropic-vertex')) ||
      request.selection.context.source !== 'none' ||
      request.selection.context.revision !== null ||
      request.selection.permission.revision !== 0
    )
      throw unavailable();
    assertAgentToolRoute(profile.definition, 'claude-sdk');
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
      vertex: true,
    });
    const authority = {
      withAdmission: async <T>(
        expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>,
        operation: (lease: { assertCurrent(): Promise<void> }) => Promise<T>,
      ) =>
        operation({
          assertCurrent: async () => {
            assertAdmissionCurrent();
            this.credentialAuthority();
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
    const catalog = localVertexCapabilities(
        profiles,
        this.#target,
        this.owners.library.list('user').versions,
        continuation
          ? this.owners.eventStore.getSessionRuntimeBinding(this.owners.reservation.conversationId)
          : undefined,
      ),
      events = this.owners.eventStore;
    const coordinator = new OrdinaryLocalCodexAdmissionCoordinator({
      enabled: true,
      adapter: 'claude-sdk',
      catalog,
      declaration: catalog.declaration,
      authority,
      store: {
        admitOrdinaryLocalCommand: (
          ...args: Parameters<typeof events.admitOrdinaryLocalVertexCommand>
        ) => {
          assertAdmissionCurrent();
          return events.admitOrdinaryLocalVertexCommand(...args);
        },
        admitOrdinaryLocalContinuation: (
          ...args: Parameters<typeof events.admitOrdinaryLocalVertexContinuation>
        ) => {
          assertAdmissionCurrent();
          return events.admitOrdinaryLocalVertexContinuation(...args);
        },
        claimOrdinaryLocalCommandDispatch: (
          ...args: Parameters<typeof events.claimOrdinaryLocalVertexCommandDispatch>
        ) => {
          assertAdmissionCurrent();
          return events.claimOrdinaryLocalVertexCommandDispatch(...args);
        },
        completeOrdinaryLocalCommand: (
          ...args: Parameters<typeof events.completeOrdinaryLocalVertexCommand>
        ) => {
          assertAdmissionCurrent();
          return events.completeOrdinaryLocalVertexCommand(...args);
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
        const previousCustody = this.owners.eventStore.getOrdinaryLocalVertexCustody(
          meta.sessionId,
        );
        const custody = previousCustody ?? {
          version: 1 as const,
          sessionId: meta.sessionId,
          sdkSessionId: meta.sessionId,
          authSessionId: this.authSessionId,
          initialCommandId: commandId,
          repositoryWorkspaceId: expected.workspace.workspaceId,
          cwd: expected.workspace.cwd,
          binding: expected.binding,
          credentialAuthority: VertexAdcCustody.capture(this.environment()).snapshot(),
        };
        this.owners.eventStore.retainOrdinaryLocalVertexCustody(custody);
        this.#commands.set(commandId, {
          expected: structuredClone(expected),
          selection: selected,
          payload: structuredClone(frozenPayload),
        });
        await (continuation && !resume ? this.owners.dispatchContinuation! : this.owners.dispatch)({
          owner: this,
          expected,
          binding: structuredClone(original),
          payload: frozenPayload,
          workspace: workspace!,
          sessionId: meta.sessionId,
          commandId,
          resume,
          preparationSignal,
        });
        assertAdmissionCurrent();
      },
    });
    if (result.dispatched) this.#initialized = true;
    return result;
  }
}
