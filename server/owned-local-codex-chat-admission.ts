import { resolveTelosWorkRoleContext } from './telos-work-role-context.js';
import { ordinaryOperatorOwnsConversation } from './ordinary-operator-identity.js';
import { SourceSnapshotsSchema } from '@mitzo/protocol';
import { assembleSourceSnapshots } from './source-snapshot-context.js';
import {
  assertOrdinaryCodexSnapshotCustody,
  ordinaryCodexSnapshotCustody,
} from './ordinary-codex-agent-context.js';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { AccountBinding, AgentLibraryVersion, AgentContextSnapshot } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type {
  CodexConversationStore,
  CodexCommand,
  PreparedRepositoryPrimarySourceFence,
} from './codex-conversation-store.js';
import { HostCodexCustodySchema, type HostCodexCustody } from './host-codex-custody.js';
import type { FrozenHostCodexBootstrapLease } from './frozen-host-codex-bootstrap.js';
import type { OwnedCodexLifecycleBridge } from './owned-codex-lifecycle-bridge.js';
import type { OrdinaryLocalCodexAdmissionExpectation } from './ordinary-local-codex-admission.js';
import type { CodexAccountProfile } from './codex-account.js';
import type { CodexCommandInput } from './codex-conversation-store.js';
import type { CodexLifecycleTransport } from './codex-app-server-client.js';
import type { PreparedRepositoryTransition } from '@mitzo/protocol';
import type { PreparedRepositoryBarrierReadScope } from './prepared-repository-barrier-read.js';
import type { CodexNativeTurnTarget } from './codex-conversation-store.js';
import type { PreparedRepositoryTransitionFacts } from './prepared-repository-transition.js';
const unavailable = () => new Error('Owned local Codex chat unavailable');
const Images = z
  .array(z.strictObject({ data: z.string().min(1), mediaType: z.string().min(1).max(128) }))
  .max(16);
const Payload = z.strictObject({
  sourceSnapshots: SourceSnapshotsSchema.optional(),
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
  ordinaryWorkspace?: { kind: 'ordinary'; id: string; directory: string };
  repositoryWorkspace?: { id: string; directory?: string; sandbox?: boolean };
  resume?: boolean;
  reattachOnly?: boolean;
}
export interface CapturedPreparedRepositoryPrimarySource extends PreparedRepositoryPrimarySourceFence {
  bindOutgoing(childCommandId: string): void;
  dispose(): void;
}
interface Owner {
  workspaceKind?: 'repository' | 'ordinary';
  eventStore: EventStore;
  sessionId: string;
  commandId: string;
  expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>;
  lease: FrozenHostCodexBootstrapLease;
  bridge: OwnedCodexLifecycleBridge;
  authSessionId?: string;
  custody?: HostCodexCustody;
  nativeStore?: CodexConversationStore;
  preparedRepositoryBoundary?: {
    assertCurrentSync(): void;
    adopt(
      scope: PreparedRepositoryBarrierReadScope,
      source: Readonly<CodexNativeTurnTarget>,
    ): Promise<PreparedRepositoryTransitionFacts['newWorkspace'] | undefined>;
  };
}
/** A server-internal first-command capability built from the existing durable
 * uncertain receipt and actual bootstrap lease. Request JSON cannot forge a class
 * instance. The prepared provider prompt, original intent and images are frozen
 * in the strict {text,systemPrompt,intent?,images?} receipt payload; other route
 * payloads refuse.
 */
export class OwnedLocalCodexChatAdmission {
  #primary?: OwnedLocalCodexChatAdmission;
  #adoptedPrimary = false;
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
        !ordinaryOperatorOwnsConversation(custody.authSessionId, owner.authSessionId) ||
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
          queued.prompt !==
            assembleSourceSnapshots(child.#payload.text, child.#payload.sourceSnapshots) ||
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
      (this.owner.workspaceKind === 'ordinary'
        ? session.ordinaryWorkspaceId !== expected.workspace.workspaceId ||
          session.repositoryWorkspaceId != null
        : session.repositoryWorkspaceId !== expected.workspace.workspaceId ||
          session.ordinaryWorkspaceId != null) ||
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
    if (this.#primary) return this.#primary.admitContinuation(commandId, expectedInput);
    try {
      this.assertCurrentSync();
      if (
        !this.#opened ||
        (this.#continuation && !this.#resume && !this.#adoptedPrimary) ||
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
  /** Capture the exact old owner before the cross-store effect. The returned
   * synchronous handoff is usable only after the guarded repository CAS and
   * exact EventStore commit; it never authorizes either effect itself. Original
   * expected/payload remain intact; the live owner delegates to its new primary. */
  /** Capture only this live adopted primary, before repository lookup awaits.
   * The stack-scoped fence follows one exact UNCERTAIN outgoing handoff and
   * expires in the barrier's finally; it is neither a grant nor cold recovery. */
  capturePreparedRepositoryPrimarySource(
    target: Readonly<CodexNativeTurnTarget>,
    assertConversationCurrentSync: () => void,
  ): CapturedPreparedRepositoryPrimarySource | undefined {
    if (this.#primary)
      return this.#primary.capturePreparedRepositoryPrimarySource(
        target,
        assertConversationCurrentSync,
      );
    if (!this.#adoptedPrimary || target.commandId !== this.owner.commandId) return undefined;
    const owner = this.owner,
      expected = this.#expected,
      session = this.#session,
      lease = owner.lease,
      assertLease = lease.assertCurrentSync,
      events = owner.eventStore,
      sessionId = owner.sessionId,
      ownerExpected = owner.expected,
      nativeStore = owner.nativeStore,
      bridge = owner.bridge;
    const receipt = events.getOrdinaryLocalCommandAdmission(owner.commandId);
    if (!session || receipt?.state !== 'consumed' || !receipt.preparedRepositoryTransition)
      throw unavailable();
    const sourceTarget = structuredClone(target),
      commandId = owner.commandId;
    if (
      !nativeStore ||
      !isDeepStrictEqual(
        nativeStore.completedNativeTurnTarget(sessionId, this.#binding),
        sourceTarget,
      )
    )
      throw unavailable();
    let live = true,
      outgoing: { id: string; receipt: NonNullable<typeof receipt> } | undefined;
    const sync = (value: unknown) => {
      if (value === undefined) return;
      void Promise.resolve(value).catch(() => {});
      throw unavailable();
    };
    const validateContext = () => {
      if (
        !live ||
        this.#closed ||
        this.owner !== owner ||
        this.#expected !== expected ||
        this.#session !== session ||
        owner.commandId !== commandId ||
        owner.sessionId !== sessionId ||
        owner.expected !== ownerExpected ||
        owner.nativeStore !== nativeStore ||
        owner.bridge !== bridge ||
        owner.lease !== lease ||
        owner.eventStore !== events ||
        lease.assertCurrentSync !== assertLease ||
        session.mode !== expected.selection.permission.mode ||
        !isDeepStrictEqual(
          nativeStore.completedNativeTurnTarget(sessionId, this.#binding),
          sourceTarget,
        )
      )
        throw unavailable();
      const meta = events.getSession(sessionId),
        send = events.getSendCommand(commandId);
      if (
        !this.#opened ||
        !send ||
        send.error ||
        send.sessionId !== sessionId ||
        !isDeepStrictEqual(Payload.parse(send.payload), this.#payload) ||
        !isDeepStrictEqual(meta?.accountBinding, this.#binding) ||
        meta?.mode !== expected.selection.permission.mode ||
        !isDeepStrictEqual(meta.agentProfile ?? undefined, expected.agentProfile) ||
        !isDeepStrictEqual(meta.agentContext ?? undefined, expected.agentContext)
      )
        throw unavailable();
      return meta;
    };
    const assert = (command?: Readonly<CodexCommand>) => {
      validateContext();
      sync(assertConversationCurrentSync());
      validateContext();
      sync(assertLease.call(lease));
      validateContext();
      sync(assertConversationCurrentSync());
      const meta = validateContext();
      if (
        nativeStore
          .commands(sessionId, this.#binding)
          .some(
            (command) =>
              command.status === 'running' ||
              (command.status === 'queued' && command.id !== outgoing?.id),
          )
      )
        throw unavailable();
      if (
        command &&
        (command.id !== commandId ||
          command.status !== 'completed' ||
          command.allowedTools ||
          command.prompt !== this.#payload.text ||
          command.intent !== this.#payload.intent ||
          !isDeepStrictEqual(command.environmentContinuation, {
            sourceCommandId: receipt.preparedRepositoryTransition!.source.commandId,
            sourceTurnId: receipt.preparedRepositoryTransition!.source.turnId,
            sourceThreadId: receipt.preparedRepositoryTransition!.source.threadId,
            sourceGeneration: receipt.preparedRepositoryTransition!.source.generation,
          }))
      )
        throw unavailable();
      if (!outgoing) {
        if (
          this.#primary ||
          session.cwd !== expected.workspace.cwd ||
          !isDeepStrictEqual(events.getOrdinaryLocalCommandAdmission(commandId), receipt)
        )
          throw unavailable();
      } else {
        const child = events.observePreparedRepositoryContinuation(outgoing.id);
        if (
          child.state !== 'uncertain' ||
          !isDeepStrictEqual(child, outgoing.receipt) ||
          (this.#primary &&
            (this.#primary.owner.commandId !== outgoing.id ||
              this.#primary.owner.lease !== lease ||
              this.#primary.#session !== session))
        )
          throw unavailable();
        const next = child.preparedRepositoryTransition!.newWorkspace;
        if (
          typeof session.cwd !== 'string' ||
          ![expected.workspace.cwd, next.directory].includes(session.cwd)
        )
          throw unavailable();
        const oldMeta =
          meta?.cwd === expected.workspace.cwd &&
          meta.repositoryWorkspaceId === expected.workspace.workspaceId;
        const newMeta =
          meta?.cwd === next.directory &&
          meta.repositoryWorkspaceId === next.id &&
          meta.ordinaryWorkspaceId == null;
        if (!oldMeta && !newMeta) throw unavailable();
        const retained = oldMeta
          ? events.getOrdinaryLocalCommandAdmission(commandId)
          : events.getPreparedRepositorySourceAdmission(outgoing.id);
        if (!isDeepStrictEqual(retained, receipt)) throw unavailable();
      }
    };
    assert();
    return Object.freeze({
      commandId,
      assertCurrentSync: assert,
      bindOutgoing: (id: string) => {
        assert();
        if (outgoing) throw unavailable();
        const child = events.observePreparedRepositoryContinuation(id),
          transition = child.preparedRepositoryTransition;
        if (
          child.state !== 'uncertain' ||
          !transition ||
          transition.priorPrimaryCommandId !== commandId ||
          transition.source.commandId !== commandId ||
          !isDeepStrictEqual(
            {
              commandId: transition.source.commandId,
              attempt: transition.source.attempt,
              threadId: transition.source.threadId,
              turnId: transition.source.turnId,
              generation: transition.source.generation,
            },
            sourceTarget,
          ) ||
          transition.oldWorkspace.id !== expected.workspace.workspaceId ||
          transition.oldWorkspace.directory !== expected.workspace.cwd
        )
          throw unavailable();
        outgoing = { id, receipt: child };
        assert();
      },
      dispose: () => {
        live = false;
      },
    });
  }
  currentPreparedRepositoryPrimaryCommandId(): string | undefined {
    if (this.#primary) return this.#primary.currentPreparedRepositoryPrimaryCommandId();
    this.assertCurrentSync();
    if (!this.#adoptedPrimary) return undefined;
    const receipt = this.owner.eventStore.getOrdinaryLocalCommandAdmission(this.owner.commandId);
    if (receipt?.state !== 'consumed' || !receipt.preparedRepositoryTransition) throw unavailable();
    return this.owner.commandId;
  }
  preparePreparedRepositoryPrimary(
    commandId: string,
    expectedInput: Readonly<OrdinaryLocalCodexAdmissionExpectation>,
    transition: PreparedRepositoryTransition,
  ): () => void {
    if (this.#primary)
      return this.#primary.preparePreparedRepositoryPrimary(commandId, expectedInput, transition);
    this.assertCurrentSync();
    if (!this.#opened || !this.#session) throw unavailable();
    const expected = structuredClone(expectedInput);
    const original = this.#expected;
    const session = this.#session;
    const receipt = this.owner.eventStore.observePreparedRepositoryContinuation(commandId);
    const frozenTransition = structuredClone(transition);
    if (
      transition.priorPrimaryCommandId !==
        (this.#adoptedPrimary ? this.owner.commandId : undefined) ||
      receipt.state !== 'uncertain' ||
      !isDeepStrictEqual(receipt.preparedRepositoryTransition, frozenTransition) ||
      !isDeepStrictEqual(receipt.binding, original.binding) ||
      !isDeepStrictEqual(receipt.workspace, expected.workspace) ||
      !isDeepStrictEqual(receipt.selection, expected.selection) ||
      transition.oldWorkspace.id !== original.workspace.workspaceId ||
      transition.oldWorkspace.directory !== original.workspace.cwd ||
      transition.oldWorkspace.kind !== (this.owner.workspaceKind ?? 'repository') ||
      !isDeepStrictEqual(expected.binding, original.binding) ||
      !isDeepStrictEqual(expected.agentProfile, original.agentProfile) ||
      !isDeepStrictEqual(expected.agentContext, original.agentContext) ||
      !isDeepStrictEqual(expected.selection.agent, original.selection.agent) ||
      !isDeepStrictEqual(expected.selection.context, original.selection.context) ||
      !isDeepStrictEqual(expected.selection.permission, original.selection.permission) ||
      expected.hostId !== original.hostId ||
      expected.runtimeContractRevision !== original.runtimeContractRevision
    )
      throw unavailable();
    const child = new OwnedLocalCodexChatAdmission({
      ...this.owner,
      commandId,
      expected,
      workspaceKind: 'repository',
    });
    if (child.#payload.systemPrompt !== this.#payload.systemPrompt) throw unavailable();
    child.#continuation = true;
    child.#adoptedPrimary = true;
    child.#opened = true;
    child.#session = session;
    let committed = false;
    return () => {
      if (
        committed ||
        this.#closed ||
        this.#primary ||
        this.#expected !== original ||
        this.#session !== session ||
        session.cwd !== original.workspace.cwd ||
        session.mode !== original.selection.permission.mode
      )
        throw unavailable();
      this.owner.lease.assertCurrentSync();
      const current = this.owner.eventStore.getOrdinaryLocalCommandAdmission(commandId);
      if (
        !current ||
        !['uncertain', 'consumed'].includes(current.state) ||
        !isDeepStrictEqual(current.preparedRepositoryTransition, frozenTransition) ||
        !isDeepStrictEqual(
          this.owner.eventStore.getPreparedRepositorySourceAdmission(commandId).workspace,
          original.workspace,
        )
      )
        throw unavailable();
      child.assertReceipt();
      session.cwd = expected.workspace.cwd;
      this.#primary = child;
      committed = true;
      child.assertCurrentSync();
    };
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
      const ordinary = this.owner.workspaceKind === 'ordinary';
      const workspace = ordinary ? options.ordinaryWorkspace : options.repositoryWorkspace;
      if (
        ordinary
          ? options.repositoryWorkspace !== undefined ||
            options.ordinaryWorkspace?.kind !== 'ordinary'
          : options.ordinaryWorkspace !== undefined
      )
        throw unavailable();
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
        options.prompt !==
          assembleSourceSnapshots(this.#payload.text, this.#payload.sourceSnapshots) ||
        options.systemPrompt !== this.#payload.systemPrompt ||
        (options.intent ?? options.prompt) !== (this.#payload.intent ?? this.#payload.text) ||
        !isDeepStrictEqual(options.images ?? [], this.#payload.images ?? []) ||
        !isDeepStrictEqual(options.agentProfile, expected.agentProfile) ||
        !isDeepStrictEqual(options.agentContext, expected.agentContext) ||
        workspace?.id !== expected.workspace.workspaceId ||
        workspace?.directory !== expected.workspace.cwd ||
        (workspace && 'sandbox' in workspace && workspace.sandbox === true)
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
      if (this.#primary) return this.#primary.assertCurrentSync();
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
  /** The existing physical custody owner supplies this digest. Request metadata
   * or a runtime version label cannot qualify native sandbox implementation. */
  nativeExecutionArtifactSha256(): string {
    this.assertCurrentSync();
    return this.owner.lease.executableSha256;
  }
  /** Current operator, selected native lease and physical workspace authority,
   * supplied by the existing actual runtime owner, never a completed tool scope. */
  assertPreparedRepositoryBoundaryCurrentSync(): void {
    this.assertCurrentSync();
    const owner = this.owner.preparedRepositoryBoundary;
    if (!owner) throw unavailable();
    const result: unknown = owner.assertCurrentSync();
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {});
      throw unavailable();
    }
  }
  completedPreparedRepositorySourceTarget(): Readonly<CodexNativeTurnTarget> | undefined {
    this.assertPreparedRepositoryBoundaryCurrentSync();
    return this.owner.nativeStore?.completedNativeTurnTarget(this.owner.sessionId, this.#binding);
  }
  async adoptPreparedRepositoryAtBoundary(
    scope: PreparedRepositoryBarrierReadScope,
    source: Readonly<CodexNativeTurnTarget>,
  ) {
    this.assertPreparedRepositoryBoundaryCurrentSync();
    return this.owner.preparedRepositoryBoundary!.adopt(scope, source);
  }
  assertBeforeEnqueue(input: CodexCommandInput): void {
    if (this.#primary) return this.#primary.assertBeforeEnqueue(input);
    this.assertCurrentSync();
    const continuation = this.#continuations.get(input.id);
    if (continuation) {
      this.assertCurrentSync();
      continuation.assertBeforeEnqueue(input);
      return;
    }
    this.assertCurrentSync();
    this.assertReceipt(!this.#adoptedPrimary);
    if (
      this.#enqueued ||
      input.id !== this.owner.commandId ||
      input.prompt !== assembleSourceSnapshots(this.#payload.text, this.#payload.sourceSnapshots) ||
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
    if (this.#primary) return this.#primary.canClaimCommand(commandId);
    this.assertCurrentSync();
    if (commandId === this.owner.commandId)
      return (
        this.owner.eventStore.getOrdinaryLocalCommandAdmission(commandId)?.state === 'consumed'
      );
    const continuation = this.#continuations.get(commandId);
    if (!continuation) return false;
    continuation.assertCurrentSync();
    return this.owner.eventStore.getOrdinaryLocalCommandAdmission(commandId)?.state === 'consumed';
  }
  assertBeforeDispatch(commandId: string): void {
    if (this.#primary) return this.#primary.assertBeforeDispatch(commandId);
    this.assertCurrentSync();
    const continuation = this.#continuations.get(commandId);
    if (continuation) {
      this.assertCurrentSync();
      continuation.assertBeforeDispatch(commandId);
      return;
    }
    this.assertCurrentSync();
    this.assertReceipt();
    if (this.owner.eventStore.getOrdinaryLocalCommandAdmission(commandId)?.state !== 'consumed')
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
    if (this.#primary) return this.#primary.assertModelSelection(model, thinking);
    this.assertCurrentSync();
    if (
      (!this.#continuation || this.#resume || this.#adoptedPrimary) &&
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
      authSessionId: this.owner.custody?.authSessionId ?? this.owner.authSessionId,
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
    if (this.#primary) {
      this.#primary.close();
      return;
    }
    this.owner.lease.close();
  }
}
