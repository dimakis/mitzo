import { assembleCommandPrompt } from './message-reply-context.js';
import { MessageReplyIdSchema } from '@mitzo/protocol';
import {
  CHAT_MAX_IMAGES,
  CHAT_MAX_PREPARED_PROMPT_CHARS,
  ChatMessageTextSchema,
} from '@mitzo/protocol';
import { ordinaryOperatorOwnsConversation } from './ordinary-operator-identity.js';
import { resolveTelosWorkRoleContext } from './telos-work-role-context.js';
import { SourceSnapshotsSchema } from '@mitzo/protocol';
import { bootContextWithRetainedReceipt } from './agent-context-delivery.js';
import {
  assertOrdinaryCodexContextIdentity,
  assertOrdinaryCodexSnapshotCustody,
  ordinaryCodexSnapshotCustody,
} from './ordinary-codex-agent-context.js';
import { sameOpenShellRouteAuthority } from './openshell-route-authority.js';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type {
  AccountBinding,
  AgentLibraryVersion,
  AgentContextSnapshot,
  SessionRuntimeBindingV2,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type {
  CodexCommandInput,
  ArtifactRuntime,
  CodexConversationStore,
} from './codex-conversation-store.js';
import type { CodexAccountProfile } from './codex-account.js';
import type { OpenShellRuntimeConfig } from './openshell-runtime.js';
import type { OrdinaryOpenShellCommandSelection } from '@mitzo/protocol';
import {
  assertOrdinaryOpenShellCodexRoute,
  ordinaryOpenShellCodexTarget,
} from './ordinary-openshell-codex-route.js';
import {
  OpenShellCodexCustodySchema,
  openShellPhysicalCustodyFingerprint,
} from './openshell-codex-custody.js';
import type { AccountProfiles } from './account-profiles.js';
import type { OrdinarySessionRuntimeCatalog } from './ordinary-session-runtime.js';

const unavailable = () => new Error('Owned OpenShell Codex chat unavailable');
export const OwnedOpenShellCodexPayloadSchema = z.strictObject({
  sourceSnapshots: SourceSnapshotsSchema.optional(),
  replyToMessageId: MessageReplyIdSchema.optional(),
  text: z.string().min(1).max(CHAT_MAX_PREPARED_PROMPT_CHARS),
  systemPrompt: z.string().max(1_000_000),
  intent: ChatMessageTextSchema.optional(),
  images: z
    .array(z.strictObject({ data: z.string().min(1), mediaType: z.string().min(1).max(128) }))
    .max(CHAT_MAX_IMAGES)
    .optional(),
});
const Payload = OwnedOpenShellCodexPayloadSchema;
export interface OrdinaryOpenShellCodexExpectation {
  binding: SessionRuntimeBindingV2;
  workspace: { workspaceId: string; cwd: string };
  selection: OrdinaryOpenShellCommandSelection;
  agentProfile?: AgentLibraryVersion;
  agentContext?: AgentContextSnapshot;
}
export interface OwnedOpenShellCodexOptions {
  conversationId: string;
  messageId: string;
  binding: AccountBinding;
  profile: CodexAccountProfile;
  session: { cwd?: string; mode: string };
  prompt: string;
  systemPrompt: string;
  intent?: string;
  model?: string;
  reasoningEffort?: string | null;
  images?: Array<{ data: string; mediaType: string }>;
  agentProfile?: AgentLibraryVersion;
  agentContext?: AgentContextSnapshot;
  ordinaryWorkspace?: { kind: 'ordinary'; id: string; sandbox?: boolean; conversationId?: string };
  repositoryWorkspace?: { id: string; sandbox?: boolean; conversationId?: string };
  resume?: boolean;
  reattachOnly?: boolean;
}
interface Owner {
  workspaceKind?: 'repository' | 'ordinary';
  events: EventStore;
  nativeStore: CodexConversationStore;
  sessionId: string;
  expected: OrdinaryOpenShellCodexExpectation;
  account: AccountBinding;
  profiles: AccountProfiles;
  profilesCurrent(): AccountProfiles;
  catalog: OrdinarySessionRuntimeCatalog;
  target: ReturnType<typeof ordinaryOpenShellCodexTarget>;
  config: OpenShellRuntimeConfig;
  /** Actual owning operator/profile/context/workspace/lifecycle authority. */
  assertCurrentSync(): void;
  assertSelectionCurrentSync(expected: OrdinaryOpenShellCodexExpectation): void;
  /** Fresh selected provider enrollment/grant observation under that same fence. */
  assertCurrent(expected: OrdinaryOpenShellCodexExpectation): Promise<void>;
  readRetained(): ArtifactRuntime | undefined;
  assertRetainedAuthority(artifact: ArtifactRuntime): void;
  close(): void;
  expectedRetained?: ArtifactRuntime;
  authSessionId: string;
}
/** In-process capability backed by the existing uncertain receipt and existing
 * continuation owners. No request can supply the authority or configure a route.
 * Each native queue command has its own frozen selection and payload.
 */
export class OwnedOpenShellCodexChatAdmission {
  readonly #commands = new Map<
    string,
    {
      expected: OrdinaryOpenShellCodexExpectation;
      payload: z.infer<typeof Payload>;
      enqueued: boolean;
      dispatched: boolean;
    }
  >();
  readonly #expected: OrdinaryOpenShellCodexExpectation;
  readonly #config: OpenShellRuntimeConfig;
  #session?: OwnedOpenShellCodexOptions['session'];
  #opened = false;
  #resume = false;
  #resumeCustody?: z.infer<typeof OpenShellCodexCustodySchema>;
  #retained?: ArtifactRuntime;
  private constructor(
    private readonly owner: Owner,
    private readonly initialCommandId: string,
  ) {
    this.#expected = structuredClone(owner.expected);
    this.#retained = owner.expectedRetained ? structuredClone(owner.expectedRetained) : undefined;
    this.#config = {
      ...owner.config,
      serviceProviders: [...owner.config.serviceProviders],
      grantableServiceProviders: [...owner.config.grantableServiceProviders],
      cliEnvironment: owner.config.cliEnvironment ? { ...owner.config.cliEnvironment } : undefined,
    };
  }
  static capture(owner: Owner, commandId: string) {
    const result = new OwnedOpenShellCodexChatAdmission(owner, commandId);
    result.register(commandId, owner.expected);
    result.assertCurrentSync();
    return result;
  }
  static captureResume(owner: Owner & { nativeStore: CodexConversationStore }, commandId: string) {
    const custody = owner.nativeStore.readOpenShellCustody(owner.sessionId, owner.account);
    const artifact = owner.nativeStore.readArtifactRuntime(owner.sessionId, owner.account);
    if (
      !custody ||
      !artifact ||
      !owner.expectedRetained ||
      !ordinaryOperatorOwnsConversation(custody.authSessionId, owner.authSessionId) ||
      (custody.workspaceKind ?? 'repository') !== (owner.workspaceKind ?? 'repository') ||
      !isDeepStrictEqual(custody.binding, owner.expected.binding) ||
      !isDeepStrictEqual(custody.workspace, owner.expected.workspace) ||
      custody.physicalIdentitySha256 !== openShellPhysicalCustodyFingerprint(artifact) ||
      !owner.nativeStore.read(owner.sessionId, owner.account).threadId ||
      owner.nativeStore
        .commands(owner.sessionId, owner.account)
        .some((command) => command.status === 'running')
    )
      throw unavailable();
    assertOrdinaryCodexSnapshotCustody(
      custody,
      owner.expected.agentProfile,
      owner.expected.agentContext,
    );
    owner.assertRetainedAuthority(artifact);
    const result = new OwnedOpenShellCodexChatAdmission(owner, commandId);
    result.#resume = true;
    result.#resumeCustody = structuredClone(custody);
    result.register(commandId, owner.expected);
    for (const queued of owner.nativeStore
      .commands(owner.sessionId, owner.account)
      .filter((command) => command.status === 'queued')) {
      const receipt = owner.events.getOrdinaryOpenShellCommandAdmission(queued.id);
      if (
        !receipt ||
        receipt.state !== 'consumed' ||
        !isDeepStrictEqual(receipt.selection.agent, owner.expected.selection.agent) ||
        !isDeepStrictEqual(receipt.selection.context, owner.expected.selection.context) ||
        !isDeepStrictEqual(receipt.selection.permission, owner.expected.selection.permission)
      )
        throw unavailable();
      result.register(queued.id, { ...owner.expected, selection: receipt.selection }, true);
      const retained = result.#commands.get(queued.id)!;
      if (
        queued.prompt !==
          assembleCommandPrompt(owner.events, owner.sessionId, queued.id, retained.payload) ||
        (queued.intent ?? queued.prompt) !== (retained.payload.intent ?? retained.payload.text) ||
        queued.model !== receipt.selection.model ||
        (queued.reasoningEffort ?? null) !== receipt.selection.thinking ||
        !isDeepStrictEqual(queued.images ?? [], retained.payload.images ?? [])
      )
        throw unavailable();
      retained.enqueued = true;
    }
    result.assertCurrentSync();
    return result;
  }
  persistNativeCustody(store: CodexConversationStore) {
    this.assertCurrentSync();
    if (!this.#retained) throw unavailable();
    const snapshot = OpenShellCodexCustodySchema.parse({
      version: 1,
      authSessionId: this.#resumeCustody?.authSessionId ?? this.owner.authSessionId,
      binding: this.#expected.binding,
      workspace: this.#expected.workspace,
      ...(this.owner.workspaceKind === 'ordinary' ? { workspaceKind: 'ordinary' } : {}),
      physicalIdentitySha256: openShellPhysicalCustodyFingerprint(this.#retained),
      ...(this.#resume
        ? (() => {
            const original = this.#resumeCustody;
            return {
              ...(original?.agentProfileSha256
                ? { agentProfileSha256: original.agentProfileSha256 }
                : {}),
              ...(original?.agentContextSha256
                ? { agentContextSha256: original.agentContextSha256 }
                : {}),
            };
          })()
        : ordinaryCodexSnapshotCustody(this.#expected.agentProfile, this.#expected.agentContext)),
    });
    if (this.#resume) {
      if (
        !isDeepStrictEqual(snapshot, this.#resumeCustody) ||
        !isDeepStrictEqual(
          store.readOpenShellCustody(this.owner.sessionId, this.owner.account),
          snapshot,
        )
      )
        throw unavailable();
    } else store.setOpenShellCustody(this.owner.sessionId, this.owner.account, snapshot);
  }
  configuration(): OpenShellRuntimeConfig {
    this.assertCurrentSync();
    return {
      ...this.#config,
      serviceProviders: [...this.#config.serviceProviders],
      grantableServiceProviders: [...this.#config.grantableServiceProviders],
      cliEnvironment: this.#config.cliEnvironment ? { ...this.#config.cliEnvironment } : undefined,
    };
  }
  private register(
    commandId: string,
    expected: OrdinaryOpenShellCodexExpectation,
    consumed = false,
  ) {
    if (this.#commands.has(commandId)) throw unavailable();
    const receipt = this.owner.events.getOrdinaryOpenShellCommandAdmission(commandId);
    const send = this.owner.events.getSendCommand(commandId);
    if (
      !receipt ||
      receipt.state !== (consumed ? 'consumed' : 'uncertain') ||
      !send ||
      send.error ||
      send.sessionId !== this.owner.sessionId ||
      !isDeepStrictEqual(receipt.binding, expected.binding) ||
      !isDeepStrictEqual(receipt.selection, expected.selection) ||
      !isDeepStrictEqual(receipt.workspace, expected.workspace)
    )
      throw unavailable();
    const payload = Payload.parse(send.payload);
    const origin = this.#commands.get(this.initialCommandId);
    if (origin && payload.systemPrompt !== origin.payload.systemPrompt) throw unavailable();
    this.#commands.set(commandId, {
      expected: structuredClone(expected),
      payload,
      enqueued: false,
      dispatched: false,
    });
  }
  admitContinuation(commandId: string, expected: OrdinaryOpenShellCodexExpectation) {
    this.assertCurrentSync();
    if (
      !this.#opened ||
      !isDeepStrictEqual(expected.binding, this.#expected.binding) ||
      !isDeepStrictEqual(expected.workspace, this.#expected.workspace) ||
      !isDeepStrictEqual(expected.agentProfile, this.#expected.agentProfile) ||
      !isDeepStrictEqual(expected.agentContext, this.#expected.agentContext) ||
      !isDeepStrictEqual(expected.selection.agent, this.#expected.selection.agent) ||
      !isDeepStrictEqual(expected.selection.context, this.#expected.selection.context) ||
      !isDeepStrictEqual(expected.selection.permission, this.#expected.selection.permission)
    )
      throw unavailable();
    this.register(commandId, expected);
  }
  assertConsumerOwner(events: EventStore, sessionId: string, commandId: string) {
    if (
      events !== this.owner.events ||
      sessionId !== this.owner.sessionId ||
      commandId !== this.initialCommandId
    )
      throw unavailable();
    this.assertCurrentSync();
  }
  assertPreparedOptions(options: OwnedOpenShellCodexOptions) {
    this.assertCurrentSync();
    const command = this.#commands.get(options.messageId);
    const ordinary = this.owner.workspaceKind === 'ordinary';
    const workspace = ordinary ? options.ordinaryWorkspace : options.repositoryWorkspace;
    if (
      !command ||
      options.conversationId !== this.owner.sessionId ||
      !!options.resume !== this.#resume ||
      options.reattachOnly ||
      options.session.cwd !== this.#expected.workspace.cwd ||
      options.session.mode !== this.#expected.selection.permission.mode ||
      (ordinary
        ? options.repositoryWorkspace !== undefined
        : options.ordinaryWorkspace !== undefined) ||
      workspace?.id !== this.#expected.workspace.workspaceId ||
      !workspace?.sandbox ||
      workspace.conversationId !== this.owner.sessionId ||
      options.prompt !==
        assembleCommandPrompt(
          this.owner.events,
          this.owner.sessionId,
          options.messageId,
          command.payload,
        ) ||
      options.systemPrompt !== command.payload.systemPrompt ||
      (options.intent ?? options.prompt) !== (command.payload.intent ?? command.payload.text) ||
      !isDeepStrictEqual(options.images ?? [], command.payload.images ?? []) ||
      (options.model ?? options.binding.model) !== command.expected.selection.model ||
      (options.reasoningEffort ?? null) !== command.expected.selection.thinking ||
      !isDeepStrictEqual(options.agentProfile, this.#expected.agentProfile) ||
      !isDeepStrictEqual(options.agentContext, this.#expected.agentContext) ||
      options.profile.accountId !== this.owner.account.accountId ||
      options.profile.model !== command.expected.selection.model ||
      options.binding.accountId !== this.owner.account.accountId ||
      options.binding.provider !== this.owner.account.provider ||
      options.binding.profileRevision !== this.owner.account.profileRevision
    )
      throw unavailable();
    const route = assertOrdinaryOpenShellCodexRoute({
      binding: command.expected.binding,
      account: this.owner.account,
      profiles: this.owner.profilesCurrent(),
      catalog: this.owner.catalog,
      target: this.owner.target,
      model: command.expected.selection.model,
      reasoningEffort: command.expected.selection.thinking,
      mode: command.expected.selection.permission.mode,
    });
    if (
      options.profile.sandboxProvider !== route.provider ||
      options.profile.nativeAuth ||
      (route.kind === 'chatgpt-subscription' &&
        (options.profile.credentialRef ||
          options.profile.sandboxProviderId !== route.providerId ||
          options.profile.sandboxGrantId !== route.grantId ||
          options.profile.sandboxProviderType !== route.providerType ||
          options.profile.planType.trim().toLowerCase() === 'api')) ||
      (route.kind === 'api' && options.profile.planType !== 'api')
    )
      throw unavailable();
  }
  assertOptions(options: OwnedOpenShellCodexOptions) {
    if (this.#opened) throw unavailable();
    this.assertPreparedOptions(options);
    this.#session = options.session;
    this.#opened = true;
  }
  /** Existing lifecycle owner authorizes the exact newly persisted physical mapping.
   * This does not authorize migration or replace an existing retained resource.
   */
  adoptPhysicalRuntime(artifact: ArtifactRuntime) {
    this.owner.assertCurrentSync();
    this.owner.assertRetainedAuthority(artifact);
    const physical = artifact.runtime;
    if (this.#retained && !isDeepStrictEqual(this.#retained.runtime, physical)) throw unavailable();
    if (
      !physical.sandboxId ||
      physical.workdir !== this.#config.workdir ||
      physical.cli !== this.#config.cli ||
      physical.gateway !== this.#config.gateway ||
      physical.workspace !== this.#config.workspace ||
      physical.gatewayEndpoint !== this.#config.gatewayEndpoint ||
      physical.gatewayInsecure !== this.#config.gatewayInsecure ||
      !isDeepStrictEqual(this.owner.readRetained(), artifact)
    )
      throw unavailable();
    this.#retained = structuredClone(artifact);
    this.assertCurrentSync();
  }
  /** One measured startup preparation, before any native command is enqueued. */
  adoptAgentContext(snapshot: AgentContextSnapshot) {
    this.owner.assertCurrentSync();
    const command = this.#commands.get(this.initialCommandId);
    if (!command || command.enqueued || command.dispatched) throw unavailable();
    if (
      !snapshot.sandbox ||
      !this.#retained ||
      snapshot.sandbox.sandboxId !== this.#retained.runtime.sandboxId ||
      snapshot.sandbox.sandboxName !== this.#retained.runtime.sandboxName ||
      snapshot.sandbox.workspaceRoot !== this.#expected.workspace.cwd
    )
      throw unavailable();
    assertOrdinaryCodexContextIdentity(
      this.#expected.agentProfile,
      this.#expected.selection,
      snapshot,
    );
    if (this.#expected.agentContext && !isDeepStrictEqual(this.#expected.agentContext, snapshot))
      throw unavailable();
    const saved = this.owner.events.getSession(this.owner.sessionId)?.agentContext;
    if (saved && !isDeepStrictEqual(saved, snapshot)) throw unavailable();
    this.#expected.agentContext = structuredClone(snapshot);
    this.owner.expected.agentContext = structuredClone(snapshot);
    command.expected.agentContext = structuredClone(snapshot);
    const context = bootContextWithRetainedReceipt(
      snapshot,
      this.owner.events.getSession(this.owner.sessionId)?.bootContext ?? undefined,
    );
    this.owner.events.upsertSession({
      sessionId: this.owner.sessionId,
      agentContext: snapshot,
      bootContext: JSON.stringify(context),
    });
    this.assertCurrentSync();
  }
  assertCurrentSync() {
    this.owner.assertCurrentSync();
    resolveTelosWorkRoleContext(this.owner.events, this.owner.sessionId, this.owner.account);
    if (
      this.#session &&
      (this.#session.cwd !== this.#expected.workspace.cwd ||
        this.#session.mode !== this.#expected.selection.permission.mode)
    )
      throw unavailable();
    const session = this.owner.events.getSession(this.owner.sessionId);
    if (
      !session ||
      !isDeepStrictEqual(session.accountBinding, this.owner.account) ||
      !isDeepStrictEqual(
        this.owner.events.getSessionRuntimeBinding(this.owner.sessionId),
        this.#expected.binding,
      ) ||
      !isDeepStrictEqual(session.agentProfile ?? undefined, this.#expected.agentProfile) ||
      !isDeepStrictEqual(session.agentContext ?? undefined, this.#expected.agentContext) ||
      session.mode !== this.#expected.selection.permission.mode
    )
      throw unavailable();
    const retained = this.owner.readRetained();
    if (
      Boolean(retained) !== Boolean(this.#retained) ||
      (retained &&
        this.#retained &&
        (!isDeepStrictEqual(retained.runtime, this.#retained.runtime) ||
          !sameOpenShellRouteAuthority(retained.route, this.#retained.route)))
    )
      throw unavailable();
    for (const [commandId, command] of this.#commands) {
      const receipt = this.owner.events.getOrdinaryOpenShellCommandAdmission(commandId);
      const send = this.owner.events.getSendCommand(commandId);
      if (
        !receipt ||
        !['uncertain', 'consumed'].includes(receipt.state) ||
        !send ||
        send.error ||
        !isDeepStrictEqual(receipt.binding, command.expected.binding) ||
        !isDeepStrictEqual(receipt.selection, command.expected.selection) ||
        !isDeepStrictEqual(receipt.workspace, command.expected.workspace) ||
        !isDeepStrictEqual(Payload.parse(send.payload), command.payload)
      )
        throw unavailable();
      if (!this.pending(commandId, command.dispatched)) continue;
      this.owner.assertSelectionCurrentSync(command.expected);
      assertOrdinaryOpenShellCodexRoute({
        binding: command.expected.binding,
        account: this.owner.account,
        profiles: this.owner.profilesCurrent(),
        catalog: this.owner.catalog,
        target: this.owner.target,
        model: command.expected.selection.model,
        reasoningEffort: command.expected.selection.thinking,
        mode: command.expected.selection.permission.mode,
        retained: this.owner.readRetained(),
        expectedRetained: this.#retained,
      });
    }
  }
  private pending(commandId: string, dispatched: boolean): boolean {
    if (!dispatched) return true;
    const status = this.owner.nativeStore.commandStatus(
      this.owner.sessionId,
      this.owner.account,
      commandId,
    );
    return !status || status === 'queued' || status === 'running';
  }
  async assertCurrent() {
    this.assertCurrentSync();
    const selected = [...this.#commands.entries()].find(([id, command]) =>
      this.pending(id, command.dispatched),
    )?.[1].expected;
    // Recovery and metadata reads still need fresh provider grant authority
    // when no live command remains. Settled work cannot turn this into a no-op.
    await this.owner.assertCurrent(selected ?? this.#expected);
    this.assertCurrentSync();
  }
  assertBeforeEnqueue(input: CodexCommandInput) {
    this.assertCurrentSync();
    const command = this.#commands.get(input.id);
    if (
      !command ||
      command.enqueued ||
      input.prompt !==
        assembleCommandPrompt(this.owner.events, this.owner.sessionId, input.id, command.payload) ||
      (input.intent ?? input.prompt) !== (command.payload.intent ?? command.payload.text) ||
      !isDeepStrictEqual(input.images ?? [], command.payload.images ?? []) ||
      (input.model ?? command.expected.selection.model) !== command.expected.selection.model ||
      (input.reasoningEffort ?? null) !== command.expected.selection.thinking ||
      input.allowedTools !== undefined
    )
      throw unavailable();
    command.enqueued = true;
  }
  canClaimCommand(commandId: string): boolean {
    this.assertCurrentSync();
    return (
      this.#commands.has(commandId) &&
      (commandId === this.initialCommandId ||
        this.owner.events.getOrdinaryOpenShellCommandAdmission(commandId)?.state === 'consumed')
    );
  }
  assertBeforeDispatch(commandId: string) {
    this.assertCurrentSync();
    const command = this.#commands.get(commandId);
    if (
      !command ||
      !command.enqueued ||
      command.dispatched ||
      (commandId !== this.initialCommandId &&
        this.owner.events.getOrdinaryOpenShellCommandAdmission(commandId)?.state !== 'consumed')
    )
      throw unavailable();
    command.dispatched = true;
  }
  assertModelSelection(model: string, thinking?: string | null) {
    this.assertCurrentSync();
    if (
      ![...this.#commands.values()].some(
        (command) =>
          command.enqueued &&
          command.expected.selection.model === model &&
          command.expected.selection.thinking === (thinking ?? null),
      )
    )
      throw unavailable();
  }
  close() {
    this.owner.close();
  }
}
