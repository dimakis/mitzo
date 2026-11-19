import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  ordinaryOperatorOwnsConversation,
  ordinaryOperatorsShareIdentity,
} from './ordinary-operator-identity.js';
import type { ManagedSession } from '@mitzo/harness';
import { agentMessagePrompt, type AgentMessage } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { AuthSession } from './auth.js';
import { AgentCommunicationError, type AgentMessageRuntime } from './agent-message-runtime.js';
import { createLogger } from './logger.js';
import { SDK_STEER_PRIORITY, SdkUserSteering } from './sdk-user-steering.js';
import type { CodexSteerInput } from './codex-steering.js';

const log = createLogger('sdk-agent-messages');
function inputText(content: unknown): string | undefined {
  return typeof content === 'string'
    ? content
    : Array.isArray(content) &&
        content.every((block) => block?.type === 'text' && typeof block.text === 'string')
      ? content.map((block) => block.text).join('')
      : undefined;
}
type Pending = {
  message: AgentMessage;
  target: string;
  current(): void;
  signal: AbortSignal;
  attempted: boolean;
  query?: object;
  heldTurn?: boolean;
};

/** Corrections stay in the existing SDK query and its frozen active command.
 * Only the exact replay-user-messages acknowledgement proves provider acceptance.
 * Peer ACKs are consumed before the ordinary input/result correlation owner.
 */
export class SdkAgentMessageRuntime implements AgentMessageRuntime {
  readonly runtime = 'claude-sdk';
  readonly identity: object;
  private readonly userCorrections: SdkUserSteering;
  readonly #inputs = new WeakMap<SDKUserMessage, Pending>();
  readonly #pending = new Map<string, Pending>();
  readonly #ordinary = new Map<string, { current(): void; signal: AbortSignal }>();
  #ordinaryAck?: { commandId: string; uuid: string; text: string; acknowledged: boolean };
  /** Bounded internal causes; public receipts/logs contain only sanitized diagnostics. */
  readonly #failures = new Map<string, Error>();
  constructor(
    private readonly owners: {
      events: EventStore;
      session: ManagedSession;
      identity: object;
      operatorAuthSessionId: string;
      assertCurrent(): void;
      activeCommandId(): string | undefined;
      ordinaryCommandId?(): string | undefined;
      preparing?(): boolean;
      stopped(): boolean;
      push(input: SDKUserMessage): void;
      enqueue(
        message: AgentMessage,
        current: () => void,
        signal: AbortSignal,
        auth: AuthSession,
      ): Promise<void>;
    },
  ) {
    this.identity = owners.identity;
    this.userCorrections = new SdkUserSteering({
      events: owners.events,
      sessionId: this.sessionId,
      operator: owners.operatorAuthSessionId,
      assertCurrent: () => this.assertCurrent(owners.operatorAuthSessionId),
      activeCommandId: () => (this.state() === 'busy' ? owners.activeCommandId() : undefined),
      ordinaryCommandId: () =>
        owners.ordinaryCommandId ? owners.ordinaryCommandId() : owners.activeCommandId(),
      push: (input) => owners.push(input),
    });
    owners.session.abortController.signal.addEventListener(
      'abort',
      () => this.#abandonUnacknowledged(),
      { once: true },
    );
  }

  /** A steer released to stdin is queued until its replay ACK. If its owning
   * session ends first, the outcome is unknown; never leave it looking queued. */
  #abandonUnacknowledged() {
    for (const pending of this.#pending.values()) {
      const { messageId } = pending.message;
      try {
        const { message } = this.owners.events.agentCommunication.forHost(messageId);
        if (message.status === 'queued')
          this.owners.events.agentCommunication.recordForHost(
            messageId,
            'uncertain',
            'admission_uncertain',
          );
      } catch (error) {
        log.warn('Unacknowledged SDK peer input receipt not settled', {
          code: 'peer_receipt_settlement_failed',
          stage: 'session_abort',
          messageId,
          causeType: error instanceof Error ? error.name : typeof error,
        });
      }
    }
    this.#pending.clear();
  }

  async steerUser(input: CodexSteerInput, authorize: () => void) {
    const result = await this.userCorrections.steer(input, authorize);
    return result.status === 'uncertain' ? this.userCorrections.waitForReceipt(input) : result;
  }

  assertCurrent(operator: string) {
    const owner = this.owners.session.ordinaryRuntimeOwner;
    if (
      !ordinaryOperatorsShareIdentity(this.owners.operatorAuthSessionId, operator) ||
      owner?.authSessionId !== this.owners.operatorAuthSessionId ||
      owner.identity !== this.identity ||
      this.owners.session.abortController.signal.aborted
    )
      throw new AgentCommunicationError(
        'recipient_owner_changed',
        'authorization',
        'The original SDK recipient owner is unavailable.',
      );
    this.owners.assertCurrent();
  }

  state(): ReturnType<AgentMessageRuntime['state']> {
    const meta = this.owners.events.getSession(this.sessionId);
    if (
      this.owners.stopped() ||
      this.owners.session.abortController.signal.aborted ||
      meta?.executionPhase === 'STOPPING' ||
      (meta?.executionPhase === 'TERMINAL' &&
        ['stopped', 'interrupted'].includes(meta.executionTerminalReason ?? ''))
    )
      return 'stopped';
    if (this.owners.preparing?.()) return 'preparing';
    return this.owners.activeCommandId() ? 'busy' : 'idle';
  }

  private get sessionId() {
    const id = this.owners.session.sessionId;
    if (!id) throw Error('Original SDK message session unavailable');
    return id;
  }

  async steer(message: AgentMessage, current: () => void, signal: AbortSignal) {
    signal.throwIfAborted();
    current();
    this.assertCurrent(this.owners.operatorAuthSessionId);
    const target = this.owners.activeCommandId();
    if (this.state() !== 'busy' || !target) return 'inactive' as const;
    const retained = this.owners.events.agentCommunication.forHost(message.messageId);
    if (
      !ordinaryOperatorOwnsConversation(
        retained.operatorAuthSessionId,
        this.owners.operatorAuthSessionId,
      ) ||
      retained.message.recipientConversationId !== this.sessionId ||
      retained.message.commandId !== message.commandId ||
      retained.message.text !== message.text
    )
      throw Error('Original SDK peer-message identity unavailable');
    if (this.#pending.has(message.messageId)) return 'uncertain' as const;
    const pending: Pending = { message, target, current, signal, attempted: false };
    const input: SDKUserMessage = {
      type: 'user',
      // The retained protocol record has already validated this UUID. The SDK
      // additionally spells its string type as a hyphenated template literal.
      uuid: message.messageId as SDKUserMessage['uuid'],
      parent_tool_use_id: null,
      priority: SDK_STEER_PRIORITY,
      message: { role: 'user', content: agentMessagePrompt(message) },
    };
    this.#inputs.set(input, pending);
    this.#pending.set(message.messageId, pending);
    this.owners.push(input);
    // The input is now held by the recipient's live query: queued, not
    // uncertain. Its stdin guard records a refusal as failed, its exact replay
    // ACK records delivered, and losing the session first records uncertain.
    return 'queued' as const;
  }

  /** Called after asynchronous SDK authority checks and immediately before stdin yield.
   * Expected peer revocation/stale target drops only this unsubmitted correction.
   */
  /** Only the ordinary queue owner's positive pre-input cancellation may retire
   * an admitted idle peer without running its stopped-recipient dispatch guard. */
  cancelInput(input: SDKUserMessage): void {
    const commandId = (input as SDKUserMessage & { mitzoMessageId?: string }).mitzoMessageId;
    const retained = commandId && this.owners.events.agentCommunication.forCommand(commandId);
    if (!retained) return;
    const events = this.owners.events;
    const execution = events.getExecutionAdmission(this.sessionId, commandId!);
    if (
      retained.message.recipientConversationId !== this.sessionId ||
      !execution ||
      events.getExecutionTerminalReason(execution.token) !== 'stopped' ||
      events.getOrdinaryLocalVertexCommandAdmission(commandId!)?.state !== 'consumed' ||
      events.getSendCommand(commandId!)?.error !== 'Cancelled before SDK dispatch' ||
      events.getOrdinarySdkTurnEvents(this.sessionId, commandId!).length !== 0
    )
      throw Error('Original idle peer cancellation proof unavailable');
    this.#ordinary.delete(commandId!);
    events.agentCommunication.recordForHost(retained.message.messageId, 'failed', 'cancelled');
  }
  beforeInput(input: SDKUserMessage, queryAvailable = true, query?: object): boolean | undefined {
    const userCorrection = this.userCorrections.beforeInput(input, queryAvailable, query);
    if (userCorrection !== undefined) return userCorrection;
    const pending = this.#inputs.get(input);
    if (!pending) {
      const commandId = (input as SDKUserMessage & { mitzoMessageId?: string }).mitzoMessageId;
      const retained = commandId && this.owners.events.agentCommunication.forCommand(commandId);
      if (!retained) return undefined;
      try {
        const guard = this.#ordinary.get(commandId!);
        if (
          !guard ||
          !queryAvailable ||
          !ordinaryOperatorOwnsConversation(
            retained.operatorAuthSessionId,
            this.owners.operatorAuthSessionId,
          ) ||
          retained.message.recipientConversationId !== this.sessionId
        )
          throw Error('Original idle peer permission unavailable');
        guard.signal.throwIfAborted();
        guard.current();
        this.assertCurrent(this.owners.operatorAuthSessionId);
        if (this.state() === 'stopped') throw Error('Original idle peer recipient stopped');
        const text = inputText(input.message.content);
        if (text === undefined) throw Error('Original idle peer input unavailable');
        input.uuid = retained.message.messageId as SDKUserMessage['uuid'];
        this.#ordinaryAck = {
          commandId: commandId!,
          uuid: retained.message.messageId,
          text,
          acknowledged: false,
        };
        // One live guard authorizes one stdin submission. Reopen/replay never
        // reconstructs sender consent from a durable command or receipt.
        this.#ordinary.delete(commandId!);
        return true;
      } catch (cause) {
        this.#ordinary.delete(commandId!);
        this.owners.events.agentCommunication.recordForHost(
          retained.message.messageId,
          'failed',
          'before_provider_submission',
        );
        log.warn('Idle SDK peer input refused before submission', {
          code: 'before_provider_submission',
          stage: 'stdin',
          sessionId: this.sessionId,
          messageId: retained.message.messageId,
          commandId,
        });
        // This is an ordinary command, so its query must fail rather than wait
        // indefinitely for a result for input which was never submitted.
        throw new AgentCommunicationError(
          'before_provider_submission',
          'stdin',
          'Idle SDK peer input was refused before provider submission.',
          { cause },
        );
      }
    }
    try {
      pending.signal.throwIfAborted();
      pending.current();
      this.assertCurrent(this.owners.operatorAuthSessionId);
      if (
        !queryAvailable ||
        this.state() !== 'busy' ||
        this.owners.activeCommandId() !== pending.target
      )
        throw new AgentCommunicationError(
          'stale_target',
          'stdin',
          'The original SDK turn is unavailable.',
        );
    } catch (cause) {
      this.#failures.set(
        pending.message.messageId,
        new AgentCommunicationError(
          'before_provider_submission',
          'stdin',
          'SDK peer input was refused before provider submission.',
          { cause },
        ),
      );
      while (this.#failures.size > 32) this.#failures.delete(this.#failures.keys().next().value!);
      this.owners.events.agentCommunication.recordForHost(
        pending.message.messageId,
        'failed',
        'before_provider_submission',
      );
      this.#pending.delete(pending.message.messageId);
      log.warn('SDK peer input refused before submission', {
        code: 'before_provider_submission',
        stage: 'stdin',
        sessionId: this.sessionId,
        messageId: pending.message.messageId,
        commandId: pending.message.commandId,
      });
      return false;
    }
    pending.attempted = true;
    pending.query = query;
    return true;
  }

  /** Keep one terminal result open when a steer released to stdin has not been
   * echoed yet: the CLI runs it as a follow-up turn owned by the same command.
   * Returns a sanitized label of the steer that claimed the hold. */
  holdTurnForLateEcho(query: object): { kind: 'correction' | 'peer'; id: string } | undefined {
    const correction = this.userCorrections.holdTurnForLateEcho(query);
    if (correction) return { kind: 'correction', id: correction };
    const target = this.owners.activeCommandId();
    for (const pending of this.#pending.values()) {
      if (
        pending.attempted &&
        !pending.heldTurn &&
        pending.query === query &&
        pending.target === target
      ) {
        pending.heldTurn = true;
        return { kind: 'peer', id: pending.message.messageId };
      }
    }
    return undefined;
  }

  awaitingLateEcho(query: object): boolean {
    if (this.userCorrections.awaitingLateEcho(query)) return true;
    for (const pending of this.#pending.values())
      if (pending.heldTurn && pending.attempted && pending.query === query) return true;
    return false;
  }

  observe(
    event: Readonly<Record<string, unknown>>,
    query?: object,
    queryAvailable = true,
  ): boolean {
    if (this.userCorrections.observe(event, query, queryAvailable)) return true;
    if (event.type !== 'user' || typeof event.uuid !== 'string' || event.parent_tool_use_id)
      return false;
    const text = inputText((event.message as { content?: unknown } | undefined)?.content);
    // Tool results are SDK user envelopes too. They belong to the normal query
    // consumer, never to replay-input acknowledgement/correlation filtering.
    if (text === undefined) return false;
    const active = this.owners.ordinaryCommandId
      ? this.owners.ordinaryCommandId()
      : this.owners.activeCommandId();
    const ordinary = active && this.owners.events.agentCommunication.forCommand(active);
    const retained = this.owners.events.agentCommunication.forCommand(
      `agent-message:${event.uuid}`,
    );
    const separatePeer =
      retained &&
      retained.message.commandId !== active &&
      ordinaryOperatorOwnsConversation(
        retained.operatorAuthSessionId,
        this.owners.operatorAuthSessionId,
      ) &&
      retained.message.recipientConversationId === this.sessionId;
    if (ordinary && !separatePeer) {
      const expected = this.#ordinaryAck;
      if (
        !expected ||
        expected.commandId !== active ||
        expected.acknowledged ||
        expected.uuid !== event.uuid ||
        expected.text !== text
      ) {
        log.warn('Idle SDK peer acknowledgement did not match submitted input', {
          code: 'acknowledgement_mismatch',
          stage: 'provider_ack',
          sessionId: this.sessionId,
          messageId: ordinary.message.messageId,
        });
        return true;
      }
      expected.acknowledged = true;
      this.owners.events.agentCommunication.recordForHost(ordinary.message.messageId, 'delivered');
      // Exactly one verified ordinary replay reaches the command/result owner.
      return false;
    }
    if (
      !retained ||
      !ordinaryOperatorOwnsConversation(
        retained.operatorAuthSessionId,
        this.owners.operatorAuthSessionId,
      ) ||
      retained.message.recipientConversationId !== this.sessionId
    )
      return false;
    const pending = this.#pending.get(event.uuid);
    if (
      text !== agentMessagePrompt(retained.message) ||
      (pending && !pending.attempted) ||
      retained.message.reason === 'before_provider_submission'
    ) {
      log.warn('SDK peer acknowledgement did not match submitted input', {
        code: 'acknowledgement_mismatch',
        stage: 'provider_ack',
        sessionId: this.sessionId,
        messageId: retained.message.messageId,
      });
      // The provider echoed something else for this exact message: its
      // delivery is now unknown, no longer merely awaiting acknowledgement.
      if (['pending', 'queued'].includes(retained.message.status))
        this.owners.events.agentCommunication.recordForHost(
          retained.message.messageId,
          'uncertain',
          'admission_uncertain',
        );
      return true;
    }
    this.owners.events.agentCommunication.recordForHost(retained.message.messageId, 'delivered');
    this.#pending.delete(event.uuid);
    return true;
  }

  async enqueue(
    message: AgentMessage,
    current: () => void,
    signal: AbortSignal,
    auth: AuthSession,
  ) {
    signal.throwIfAborted();
    current();
    this.assertCurrent(auth.id);
    if (this.state() !== 'idle') return 'rejected' as const;
    if (this.#ordinary.has(message.commandId)) return 'uncertain' as const;
    const guard = () => {
      current();
      this.assertCurrent(auth.id);
      if (this.state() === 'stopped')
        throw new AgentCommunicationError(
          'recipient_stopped',
          'admission',
          'The recipient was stopped before admission.',
        );
    };
    this.#ordinary.set(message.commandId, { current: guard, signal });
    try {
      await this.owners.enqueue(message, guard, signal, auth);
    } catch (error) {
      this.#ordinary.delete(message.commandId);
      throw error;
    }
    return 'queued' as const;
  }
}
