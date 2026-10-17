import { resolveTelosWorkRoleContext } from './telos-work-role-context.js';
import {
  assertOrdinaryCodexSnapshotCustody,
  ordinaryCodexSnapshotCustody,
} from './ordinary-codex-agent-context.js';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { AccountBinding, AgentLibraryVersion, AgentContextSnapshot } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { CodexConversationStore } from './codex-conversation-store.js';
import { HostCodexCustodySchema, type HostCodexCustody } from './host-codex-custody.js';
import type { FrozenHostCodexBootstrapLease } from './frozen-host-codex-bootstrap.js';
import type { OwnedCodexLifecycleBridge } from './owned-codex-lifecycle-bridge.js';
import type { OrdinaryLocalCodexAdmissionExpectation } from './ordinary-local-codex-admission.js';
import type { CodexAccountProfile } from './codex-account.js';
import type { CodexCommandInput } from './codex-conversation-store.js';
import type { CodexLifecycleTransport } from './codex-app-server-client.js';
const unavailable = () => new Error('Owned local Codex chat unavailable');
const Images = z
  .array(z.strictObject({ data: z.string().min(1), mediaType: z.string().min(1).max(128) }))
  .max(16);
const Payload = z.strictObject({
  text: z.string().min(1).max(1_000_000),
  systemPrompt: z.string().max(1_000_000),
  intent: z.string().max(1_000_000).optional(),
  images: Images.optional(),
});
export interface OwnedLocalCodexChatOptions {
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
  repositoryWorkspace?: { id: string; directory?: string; sandbox?: boolean };
  resume?: boolean;
  reattachOnly?: boolean;
}
interface Owner {
  eventStore: EventStore;
  sessionId: string;
  commandId: string;
  expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>;
  lease: FrozenHostCodexBootstrapLease;
  bridge: OwnedCodexLifecycleBridge;
  authSessionId?: string;
  custody?: HostCodexCustody;
  nativeStore?: CodexConversationStore;
}
/** A server-internal first-command capability built from the existing durable
 * uncertain receipt and actual bootstrap lease. Request JSON cannot forge a class
 * instance. The prepared provider prompt, original intent and images are frozen
 * in the strict {text,systemPrompt,intent?,images?} receipt payload; other route
 * payloads refuse.
 */
export class OwnedLocalCodexChatAdmission {
  readonly #continuations = new Map<string, OwnedLocalCodexChatAdmission>();
  #continuation = false;
  #resume = false;
  #closed = false;
  #enqueued = false;
  #dispatched = false;
  #opened = false;
  #session?: OwnedLocalCodexChatOptions['session'];
  #expected: OrdinaryLocalCodexAdmissionExpectation;
  #payload;
  #profile: CodexAccountProfile;
  #binding: AccountBinding;
  private constructor(private readonly owner: Owner) {
    this.#expected = structuredClone(owner.expected);
    this.#profile = structuredClone(owner.lease.profile);
    this.#binding = structuredClone(owner.lease.binding);
    this.#payload = Payload.parse(owner.eventStore.getSendCommand(owner.commandId)?.payload);
  }
  static capture(owner: Owner): OwnedLocalCodexChatAdmission {
    try {
      const admission = new OwnedLocalCodexChatAdmission(owner);
      admission.assertReceipt(true);
      owner.lease.assertCurrentSync();
      return admission;
    } catch {
      throw unavailable();
    }
  }
  static captureResume(
    owner: Owner & { nativeStore: CodexConversationStore; custody: HostCodexCustody },
  ): OwnedLocalCodexChatAdmission {
    try {
      const custody = HostCodexCustodySchema.parse(owner.custody);
      const session = owner.eventStore.getSession(owner.sessionId);
      if (
        !owner.authSessionId ||
        custody.authSessionId !== owner.authSessionId ||
        !session?.accountBinding ||
        !isDeepStrictEqual(session.accountBinding, owner.lease.binding) ||
        !isDeepStrictEqual(
          owner.nativeStore.readHostCustody(owner.sessionId, owner.lease.binding),
          custody,
        ) ||
        !owner.nativeStore.read(owner.sessionId, owner.lease.binding).threadId
      )
        throw unavailable();
      assertOrdinaryCodexSnapshotCustody(
        custody,
        owner.expected.agentProfile,
        owner.expected.agentContext,
      );
      const admission = new OwnedLocalCodexChatAdmission(owner);
      admission.#resume = true;
      admission.#continuation = true;
      admission.assertReceipt(true);
      owner.lease.assertCurrentSync();
      for (const queued of owner.nativeStore
        .commands(owner.sessionId, owner.lease.binding)
        .filter((command) => command.status === 'queued')) {
        const receipt = owner.eventStore.getOrdinaryLocalCommandAdmission(queued.id);
        if (!receipt || receipt.state !== 'consumed') throw unavailable();
        const child = new OwnedLocalCodexChatAdmission({
          ...owner,
          commandId: queued.id,
          expected: { ...structuredClone(owner.expected), selection: receipt.selection },
        });
        child.#continuation = true;
        child.assertReceipt();
        if (
          child.#payload.systemPrompt !== admission.#payload.systemPrompt ||
          queued.prompt !== child.#payload.text ||
          (queued.intent ?? queued.prompt) !== (child.#payload.intent ?? child.#payload.text) ||
          !isDeepStrictEqual(queued.images ?? [], child.#payload.images ?? []) ||
          queued.model !== child.#expected.selection.model ||
          (queued.reasoningEffort ?? null) !== child.#expected.selection.thinking ||
          !isDeepStrictEqual(receipt.selection.agent, owner.expected.selection.agent) ||
          !isDeepStrictEqual(receipt.selection.context, owner.expected.selection.context) ||
          !isDeepStrictEqual(receipt.selection.permission, owner.expected.selection.permission)
        )
          throw unavailable();
        owner.lease.assertModelSelectionCurrentSync?.(
          child.#expected.selection.model,
          child.#expected.selection.thinking,
        );
        child.#enqueued = true;
        admission.#continuations.set(queued.id, child);
      }
      return admission;
    } catch {
      throw unavailable();
    }
  }
  private assertReceipt(initial = false): void {
    resolveTelosWorkRoleContext(this.owner.eventStore, this.owner.sessionId, this.#binding);
    const receipt = this.owner.eventStore.getOrdinaryLocalCommandAdmission(this.owner.commandId);
    const send = this.owner.eventStore.getSendCommand(this.owner.commandId);
    const session = this.owner.eventStore.getSession(this.owner.sessionId);
    const expected = this.#expected;
    if (
      !receipt ||
      !send ||
      send.sessionId !== this.owner.sessionId ||
      send.error ||
      !session ||
      (initial
        ? receipt.state !== 'uncertain'
        : !['uncertain', 'consumed'].includes(receipt.state)) ||
      !isDeepStrictEqual(receipt.binding, expected.binding) ||
      !isDeepStrictEqual(receipt.selection, expected.selection) ||
      !isDeepStrictEqual(receipt.workspace, expected.workspace) ||
      !isDeepStrictEqual(Payload.parse(send.payload), this.#payload) ||
      !isDeepStrictEqual(session.agentProfile ?? undefined, expected.agentProfile) ||
      !isDeepStrictEqual(session.agentContext ?? undefined, expected.agentContext) ||
      session.mode !== expected.selection.permission.mode ||
      (!this.#continuation &&
        (session.selectedModel !== expected.selection.model ||
          (session.reasoningEffort ?? null) !== expected.selection.thinking)) ||
      !this.sameAccount(this.#binding)
    )
      throw unavailable();
  }
  private sameAccount(binding: AccountBinding): boolean {
    const account = this.#expected.binding.account;
    return (
      binding.accountId === account.accountId &&
      binding.provider === account.provider &&
      binding.profileRevision === account.profileRevision &&
      (this.#continuation || binding.model === this.#expected.selection.model)
    );
  }
  /** Register only an already claimed durable continuation. Native FIFO admission
   * remains unavailable until the owning coordinator supplies this capability.
   * A future command may vary inference settings, never runtime or context.
   */
  admitContinuation(
    commandId: string,
    expectedInput: Readonly<OrdinaryLocalCodexAdmissionExpectation>,
  ): void {
    try {
      this.assertCurrentSync();
      if (
        !this.#opened ||
        (this.#continuation && !this.#resume) ||
        this.#continuations.has(commandId) ||
        commandId === this.owner.commandId ||
        this.owner.eventStore.getOrdinaryLocalCommandAdmission(this.owner.commandId)?.state !==
          'consumed'
      )
        throw unavailable();
      const expected = structuredClone(expectedInput);
      const original = this.#expected;
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
      const child = new OwnedLocalCodexChatAdmission({ ...this.owner, commandId, expected });
      if (child.#payload.systemPrompt !== this.#payload.systemPrompt) throw unavailable();
      child.#continuation = true;
      child.#session = this.#session;
      child.assertReceipt(true);
      this.#continuations.set(commandId, child);
    } catch {
      throw unavailable();
    }
  }
  assertConsumerOwner(eventStore: EventStore, sessionId: string, commandId: string): void {
    if (
      eventStore !== this.owner.eventStore ||
      sessionId !== this.owner.sessionId ||
      commandId !== this.owner.commandId
    )
      throw unavailable();
    this.assertCurrentSync();
  }
  assertPreparedOptions(options: OwnedLocalCodexChatOptions): void {
    try {
      if (this.#opened) throw unavailable();
      this.assertReceipt(true);
      this.owner.lease.assertCurrentSync();
      const expected = this.#expected;
      const routing = (profile: CodexAccountProfile) => [
        profile.accountId,
        profile.credentialRef,
        profile.email,
        profile.planType,
        profile.workspaceId,
        profile.nativeAuth,
        profile.sandboxProvider,
        profile.sandboxProviderType,
        profile.sandboxProviderId,
        profile.sandboxGrantId,
        profile.model,
      ];
      if (!isDeepStrictEqual(routing(options.profile), routing(this.#profile))) throw unavailable();
      if (
        !!options.resume !== this.#resume ||
        options.reattachOnly ||
        options.conversationId !== this.owner.sessionId ||
        options.messageId !== this.owner.commandId ||
        !this.sameAccount(options.binding) ||
        options.profile.accountId !== expected.binding.account.accountId ||
        (!this.#resume && options.profile.model !== expected.selection.model) ||
        options.session.cwd !== expected.workspace.cwd ||
        options.session.mode !== expected.selection.permission.mode ||
        (options.model ?? options.binding.model) !== expected.selection.model ||
        (options.reasoningEffort ?? null) !== expected.selection.thinking ||
        options.prompt !== this.#payload.text ||
        options.systemPrompt !== this.#payload.systemPrompt ||
        (options.intent ?? options.prompt) !== (this.#payload.intent ?? this.#payload.text) ||
        !isDeepStrictEqual(options.images ?? [], this.#payload.images ?? []) ||
        !isDeepStrictEqual(options.agentProfile, expected.agentProfile) ||
        !isDeepStrictEqual(options.agentContext, expected.agentContext) ||
        options.repositoryWorkspace?.id !== expected.workspace.workspaceId ||
        options.repositoryWorkspace.directory !== expected.workspace.cwd ||
        options.repositoryWorkspace.sandbox === true
      )
        throw unavailable();
    } catch {
      throw unavailable();
    }
  }
  assertOptions(options: OwnedLocalCodexChatOptions): void {
    this.assertPreparedOptions(options);
    // Retain the actual session mode/CWD observer but freeze all supplied data.
    this.#session = options.session;
    this.#opened = true;
  }
  assertCurrentSync(): void {
    try {
      if (this.#closed) throw unavailable();
      if (this.owner.nativeStore) {
        for (const commandId of this.#continuations.keys()) {
          const status = this.owner.nativeStore.commandStatus(
            this.owner.sessionId,
            this.#binding,
            commandId,
          );
          if (status && ['completed', 'interrupted', 'failed', 'cancelled'].includes(status))
            this.#continuations.delete(commandId);
        }
      }
      this.assertReceipt();
      this.owner.lease.assertCurrentSync();
      if (
        this.#session &&
        (this.#session.mode !== this.#expected.selection.permission.mode ||
          this.#session.cwd !== this.#expected.workspace.cwd)
      )
        throw unavailable();
    } catch {
      throw unavailable();
    }
  }
  async assertCurrent(): Promise<void> {
    try {
      this.assertCurrentSync();
      await this.owner.lease.assertCurrent();
      this.assertCurrentSync();
    } catch {
      throw unavailable();
    }
  }
  attach(callbacks: CodexLifecycleTransport) {
    this.assertCurrentSync();
    const client = this.owner.bridge.attach(callbacks);
    if (client !== this.owner.lease.client) throw unavailable();
    return client;
  }
  assertBeforeEnqueue(input: CodexCommandInput): void {
    this.assertCurrentSync();
    const continuation = this.#continuations.get(input.id);
    if (continuation) {
      this.assertCurrentSync();
      continuation.assertBeforeEnqueue(input);
      return;
    }
    this.assertCurrentSync();
    this.assertReceipt(true);
    if (
      this.#enqueued ||
      input.id !== this.owner.commandId ||
      input.prompt !== this.#payload.text ||
      (input.intent ?? input.prompt) !== (this.#payload.intent ?? this.#payload.text) ||
      !isDeepStrictEqual(input.images ?? [], this.#payload.images ?? []) ||
      (input.model ?? this.#expected.selection.model) !== this.#expected.selection.model ||
      (input.reasoningEffort ?? null) !== this.#expected.selection.thinking ||
      input.allowedTools !== undefined
    )
      throw unavailable();
    this.owner.lease.assertModelSelectionCurrentSync?.(
      this.#expected.selection.model,
      this.#expected.selection.thinking,
    );
    this.#enqueued = true;
  }
  canClaimCommand(commandId: string): boolean {
    this.assertCurrentSync();
    if (commandId === this.owner.commandId) return true;
    const continuation = this.#continuations.get(commandId);
    if (!continuation) return false;
    continuation.assertCurrentSync();
    return this.owner.eventStore.getOrdinaryLocalCommandAdmission(commandId)?.state === 'consumed';
  }
  assertBeforeDispatch(commandId: string): void {
    this.assertCurrentSync();
    const continuation = this.#continuations.get(commandId);
    if (continuation) {
      this.assertCurrentSync();
      continuation.assertBeforeDispatch(commandId);
      return;
    }
    this.assertCurrentSync();
    this.assertReceipt(!this.#continuation);
    if (
      this.#continuation &&
      !this.#resume &&
      this.owner.eventStore.getOrdinaryLocalCommandAdmission(commandId)?.state !== 'consumed'
    )
      throw unavailable();
    if (!this.#enqueued || this.#dispatched || commandId !== this.owner.commandId)
      throw unavailable();
    this.owner.lease.assertModelSelectionCurrentSync?.(
      this.#expected.selection.model,
      this.#expected.selection.thinking,
    );
    this.#dispatched = true;
  }
  assertModelSelection(model: string, thinking?: string | null): void {
    this.assertCurrentSync();
    if (
      (!this.#continuation || this.#resume) &&
      [...this.#continuations.values()].some(
        (continuation) =>
          continuation.#enqueued &&
          continuation.#expected.selection.model === model &&
          continuation.#expected.selection.thinking === (thinking ?? null),
      )
    )
      return;
    if (
      model !== this.#expected.selection.model ||
      (thinking ?? null) !== this.#expected.selection.thinking
    )
      throw unavailable();
  }
  persistCustody(store: CodexConversationStore): void {
    this.assertCurrentSync();
    if (!this.owner.lease.custodySnapshot) return; // Offline compatibility fixtures.
    if (!this.owner.authSessionId || !this.#expected.bootstrapId) throw unavailable();
    store.setHostCustody(this.owner.sessionId, this.#binding, {
      version: 1,
      authSessionId: this.owner.authSessionId,
      bootstrapId: this.owner.custody?.bootstrapId ?? this.#expected.bootstrapId,
      ...this.owner.lease.custodySnapshot(),
      ...(this.owner.custody
        ? {
            ...(this.owner.custody.agentProfileSha256
              ? { agentProfileSha256: this.owner.custody.agentProfileSha256 }
              : {}),
            ...(this.owner.custody.agentContextSha256
              ? { agentContextSha256: this.owner.custody.agentContextSha256 }
              : {}),
          }
        : ordinaryCodexSnapshotCustody(this.#expected.agentProfile, this.#expected.agentContext)),
    });
    this.assertCurrentSync();
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#continuations.clear();
    this.owner.lease.close();
  }
}
