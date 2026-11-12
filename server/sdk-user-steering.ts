import { isDeepStrictEqual } from 'node:util';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { CodexSteerInputSchema, type CodexSteerInput } from '@mitzo/protocol';
import type { CodexSteerResult } from './codex-steering.js';
import type { EventStore } from './event-store.js';
import { assembleReplyText, captureMessageReply } from './message-reply-context.js';
import { createLogger } from './logger.js';
const log = createLogger('sdk-user-steering');
type Outcome = 'accepted' | 'rejected' | 'uncertain';
type Pending = {
  input: CodexSteerInput;
  authorize(): void;
  attempted: boolean;
  query?: object;
  waiters: Set<(status: Outcome) => void>;
};
function sameContent(actual: unknown, expected: unknown) {
  const text = (value: unknown) =>
    typeof value === 'string'
      ? value
      : Array.isArray(value) &&
          value.every((block) => block?.type === 'text' && typeof block.text === 'string')
        ? value.map((block) => block.text).join('')
        : undefined;
  return (
    isDeepStrictEqual(actual, expected) ||
    (text(actual) !== undefined && text(actual) === text(expected))
  );
}

/** The original user's correction enters the existing SDK query only. The
 * captured command and live stdin fence prevent admission to a successor. */
export class SdkUserSteering {
  private readonly inputs = new WeakMap<SDKUserMessage, Pending>();
  private readonly pending = new Map<string, Pending>();
  private readonly failures = new Map<string, unknown>();
  private remember(requestId: string, cause: unknown) {
    this.failures.set(requestId, cause);
    while (this.failures.size > 32) this.failures.delete(this.failures.keys().next().value!);
  }
  constructor(
    private readonly owner: {
      events: EventStore;
      sessionId: string;
      operator: string;
      assertCurrent(): void;
      activeCommandId(): string | undefined;
      push(input: SDKUserMessage): void;
    },
  ) {}
  async steer(raw: CodexSteerInput, authorize: () => void): Promise<CodexSteerResult> {
    const input = CodexSteerInputSchema.parse(raw);
    authorize();
    this.owner.assertCurrent();
    const { events, sessionId, operator } = this.owner;
    const previous = events.userSteering.read(sessionId, operator, input);
    if (previous)
      return {
        status:
          previous.status === 'accepted' || previous.status === 'rejected'
            ? previous.status
            : 'uncertain',
      };
    if (this.owner.activeCommandId() !== input.targetCommandId) return { status: 'stale_target' };
    const reserved = events.userSteering.reserve(
      sessionId,
      operator,
      input,
      () => {
        const reply = input.replyToMessageId
          ? captureMessageReply(events, sessionId, input.requestId, input.replyToMessageId)
          : undefined;
        const text = assembleReplyText(input.text, reply);
        return input.images?.length
          ? [
              { type: 'text', text },
              ...input.images.map((image) => ({
                type: 'image',
                source: { type: 'base64', media_type: image.mediaType, data: image.data },
              })),
            ]
          : text;
      },
      () =>
        events.hasUserMessage(sessionId, input.requestId) ||
        !!events.getSendCommand(input.requestId) ||
        !!events.agentCommunication.forCommand(input.requestId),
    );
    const retained = reserved.receipt;
    if (!reserved.created)
      return {
        status:
          retained.status === 'accepted' || retained.status === 'rejected'
            ? retained.status
            : 'uncertain',
      };
    const pending: Pending = { input, authorize, attempted: false, waiters: new Set() };
    const message: SDKUserMessage = {
      type: 'user',
      uuid: retained.uuid as SDKUserMessage['uuid'],
      parent_tool_use_id: null,
      priority: 'now',
      message: { role: 'user', content: retained.content as SDKUserMessage['message']['content'] },
    };
    this.inputs.set(message, pending);
    this.pending.set(retained.uuid, pending);
    try {
      this.owner.push(message);
    } catch (cause) {
      this.remember(input.requestId, cause);
      log.warn('SDK correction queue refused input', {
        code: 'sdk_correction_queue_uncertain',
        stage: 'queue',
        sessionId,
        requestId: input.requestId,
        cause: cause instanceof Error ? cause.name : 'Unknown',
      });
      return { status: 'uncertain' };
    }
    return { status: 'uncertain' };
  }
  /** Let the initial HTTP action report a prompt native ACK. The deadline only
   * ends this wait; it never dispatches again or interprets silence as refusal. */
  waitForReceipt(input: CodexSteerInput): Promise<CodexSteerResult> {
    const { events, sessionId, operator } = this.owner;
    const receipt = events.userSteering.read(sessionId, operator, input);
    if (receipt?.status === 'accepted' || receipt?.status === 'rejected')
      return Promise.resolve({ status: receipt.status });
    const pending = receipt && this.pending.get(receipt.uuid);
    if (!pending) return Promise.resolve({ status: 'uncertain' });
    return new Promise((resolve) => {
      const finish = (status: Outcome) => {
        clearTimeout(timer);
        pending.waiters.delete(finish);
        resolve({ status });
      };
      const timer = setTimeout(() => finish('uncertain'), 1500);
      pending.waiters.add(finish);
    });
  }
  beforeInput(
    message: SDKUserMessage,
    queryAvailable: boolean,
    query?: object,
  ): boolean | undefined {
    const pending = this.inputs.get(message);
    if (!pending) return;
    const { events, sessionId, operator } = this.owner;
    try {
      pending.authorize();
      this.owner.assertCurrent();
      if (
        !query ||
        !queryAvailable ||
        this.owner.activeCommandId() !== pending.input.targetCommandId
      )
        throw Error('Original SDK turn unavailable');
    } catch (cause) {
      this.remember(pending.input.requestId, cause);
      events.userSteering.transition(sessionId, operator, pending.input, 'rejected');
      for (const finish of pending.waiters) finish('rejected');
      this.pending.delete(message.uuid!);
      log.warn('SDK correction refused before stdin', {
        code: 'sdk_correction_before_submission',
        stage: 'stdin',
        sessionId,
        requestId: pending.input.requestId,
        cause: cause instanceof Error ? cause.name : 'Unknown',
      });
      return false;
    }
    events.userSteering.transition(sessionId, operator, pending.input, 'submitted');
    pending.attempted = true;
    pending.query = query;
    return true;
  }
  observe(
    event: Readonly<Record<string, unknown>>,
    query?: object,
    queryAvailable = true,
  ): boolean {
    if (event.type !== 'user' || typeof event.uuid !== 'string' || event.parent_tool_use_id)
      return false;
    const { events, sessionId, operator } = this.owner;
    const retained = events.userSteering.forUuid(sessionId, operator, event.uuid);
    if (!retained) return false;
    const pending = this.pending.get(event.uuid);
    // Replayed old corrections never reach the ordinary command/result owner.
    // A retained receipt alone cannot qualify an ACK in a replacement query.
    if (
      !pending ||
      !pending.attempted ||
      !queryAvailable ||
      pending.query !== query ||
      retained.status !== 'submitted'
    )
      return true;
    const content = (event.message as { content?: unknown } | undefined)?.content;
    if (!sameContent(content, retained.content)) {
      log.warn('SDK correction acknowledgement mismatch', {
        code: 'sdk_correction_ack_mismatch',
        stage: 'provider_ack',
        sessionId,
        requestId: retained.input.requestId,
      });
      return true;
    }
    events.userSteering.transition(sessionId, operator, retained.input, 'accepted');
    for (const finish of pending.waiters) finish('accepted');
    this.pending.delete(event.uuid);
    return true;
  }
}
