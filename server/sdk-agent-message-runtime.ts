import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ManagedSession } from '@mitzo/harness';
import { agentMessagePrompt, type AgentMessage } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { AuthSession } from './auth.js';
import { AgentCommunicationError, type AgentMessageRuntime } from './agent-message-runtime.js';
import { createLogger } from './logger.js';

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
};

/** Corrections stay in the existing SDK query and its frozen active command.
 * Only the exact replay-user-messages acknowledgement proves provider acceptance.
 * Peer ACKs are consumed before the ordinary input/result correlation owner.
 */
export class SdkAgentMessageRuntime implements AgentMessageRuntime {
  readonly runtime = 'claude-sdk';
  readonly identity: object;
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
  }

  assertCurrent(operator: string) {
    const owner = this.owners.session.ordinaryRuntimeOwner;
    if (
      operator !== this.owners.operatorAuthSessionId ||
      owner?.authSessionId !== operator ||
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
      retained.operatorAuthSessionId !== this.owners.operatorAuthSessionId ||
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
      priority: 'now',
      message: { role: 'user', content: agentMessagePrompt(message) },
    };
    this.#inputs.set(input, pending);
    this.#pending.set(message.messageId, pending);
    this.owners.push(input);
    return 'uncertain' as const;
  }

  /** Called after asynchronous SDK authority checks and immediately before stdin yield.
   * Expected peer revocation/stale target drops only this unsubmitted correction.
   */
  beforeInput(input: SDKUserMessage, queryAvailable = true): boolean {
    const pending = this.#inputs.get(input);
    if (!pending) {
      const commandId = (input as SDKUserMessage & { mitzoMessageId?: string }).mitzoMessageId;
      const retained = commandId && this.owners.events.agentCommunication.forCommand(commandId);
      if (!retained) return true;
      try {
        const guard = this.#ordinary.get(commandId!);
        if (
          !guard ||
          !queryAvailable ||
          retained.operatorAuthSessionId !== this.owners.operatorAuthSessionId ||
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
    return true;
  }

  observe(event: Readonly<Record<string, unknown>>): boolean {
    if (event.type !== 'user' || typeof event.uuid !== 'string' || event.parent_tool_use_id)
      return false;
    const text = inputText((event.message as { content?: unknown } | undefined)?.content);
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
      retained.operatorAuthSessionId === this.owners.operatorAuthSessionId &&
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
      retained.operatorAuthSessionId !== this.owners.operatorAuthSessionId ||
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
