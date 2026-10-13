import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { AccountBinding, AgentLibraryVersion, AgentContextSnapshot } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
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
}
/** A server-internal first-command capability built from the existing durable
 * uncertain receipt and actual bootstrap lease. Request JSON cannot forge a class
 * instance. The prepared provider prompt, original intent and images are frozen
 * in the strict {text,systemPrompt,intent?,images?} receipt payload; other route
 * payloads refuse.
 */
export class OwnedLocalCodexChatAdmission {
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
  private assertReceipt(initial = false): void {
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
      session.selectedModel !== expected.selection.model ||
      (session.reasoningEffort ?? null) !== expected.selection.thinking ||
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
      binding.model === this.#expected.selection.model
    );
  }
  assertOptions(options: OwnedLocalCodexChatOptions): void {
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
        options.resume ||
        options.reattachOnly ||
        options.conversationId !== this.owner.sessionId ||
        options.messageId !== this.owner.commandId ||
        !this.sameAccount(options.binding) ||
        options.profile.accountId !== expected.binding.account.accountId ||
        options.profile.model !== expected.selection.model ||
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
      // Retain the actual session mode/CWD observer but freeze all supplied data.
      this.#session = options.session;
      this.#opened = true;
    } catch {
      throw unavailable();
    }
  }
  assertCurrentSync(): void {
    try {
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
    this.#enqueued = true;
  }
  assertBeforeDispatch(commandId: string): void {
    this.assertCurrentSync();
    this.assertReceipt(true);
    if (!this.#enqueued || this.#dispatched || commandId !== this.owner.commandId)
      throw unavailable();
    this.#dispatched = true;
  }
  assertModelSelection(model: string, thinking?: string | null): void {
    this.assertCurrentSync();
    if (
      model !== this.#expected.selection.model ||
      (thinking ?? null) !== this.#expected.selection.thinking
    )
      throw unavailable();
  }
  close(): void {
    this.owner.lease.close();
  }
}
