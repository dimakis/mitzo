import { isDeepStrictEqual } from 'node:util';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { CodexSteerInputSchema, type CodexSteerInput } from '@mitzo/protocol';
import type { UserSteerResult } from './codex-steering.js';
import type { EventStore } from './event-store.js';
import { assembleReplyText, captureMessageReply } from './message-reply-context.js';
import { createLogger } from './logger.js';
const log = createLogger('sdk-user-steering');
type Outcome = 'accepted' | 'rejected' | 'uncertain' | 'unconfirmed';
const settled = (status: string): status is 'accepted' | 'rejected' | 'unconfirmed' =>
  status === 'accepted' || status === 'rejected' || status === 'unconfirmed';
type Pending = {
  input: CodexSteerInput;
  authorize(): void;
  attempted: boolean;
  rejected?: boolean;
  query?: object;
  /** Time of the stdin release whose provider echo can accept this input. */
  releasedAt?: number;
  /** This input already kept one terminal result open for its follow-up turn. */
  heldTurn?: boolean;
  waiters: Set<(status: Outcome) => void>;
};
/** Claude Code aborts the running turn for a `now` input. A `next` input folds
 * into the running turn at its next model request, or runs as an immediate
 * follow-up turn when it arrives during the final request. Verified live against
 * the bundled CLI on 17 November 2026 (claude-haiku-5-5). */
export const SDK_STEER_PRIORITY = 'next' as const;
/** Initial receipt window, echo wait after an in-window stdin release, and the
 * overall cap for the initial HTTP receipt. Silence stays `uncertain`. */
export const RECEIPT_ECHO_WAIT_MS = 1500;
export const RECEIPT_MAX_WAIT_MS = 4000;
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
      ordinaryCommandId?(): string | undefined;
      push(input: SDKUserMessage): void;
    },
  ) {}
  async steer(raw: CodexSteerInput, authorize: () => void): Promise<UserSteerResult> {
    const input = CodexSteerInputSchema.parse(raw);
    authorize();
    this.owner.assertCurrent();
    const { events, sessionId, operator } = this.owner;
    const previous = events.userSteering.read(sessionId, operator, input);
    if (previous) return { status: this.settledStatus(input, previous) };
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
    if (!reserved.created) return { status: this.settledStatus(input, retained) };
    const pending: Pending = { input, authorize, attempted: false, waiters: new Set() };
    const message: SDKUserMessage = {
      type: 'user',
      uuid: retained.uuid as SDKUserMessage['uuid'],
      parent_tool_use_id: null,
      priority: SDK_STEER_PRIORITY,
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
  /** A retained receipt that no live pending entry owns can never receive its
   * provider echo (its turn ended, its query closed, or the server restarted), so
   * it settles to a terminal outcome instead of staying uncertain forever. This
   * never dispatches again and never claims acceptance. */
  private settledStatus(
    input: CodexSteerInput,
    receipt: { uuid: string; status: string },
  ): 'accepted' | 'rejected' | 'unconfirmed' | 'uncertain' {
    if (settled(receipt.status)) return receipt.status;
    if (this.pending.has(receipt.uuid)) return 'uncertain';
    const { events, sessionId, operator } = this.owner;
    const status = events.userSteering.settleOrphaned(sessionId, operator, input);
    if (status && settled(status)) {
      log.warn('SDK correction settled without a live owner', {
        code: 'sdk_correction_orphan_settled',
        stage: 'receipt_settlement',
        sessionId,
        requestId: input.requestId,
        outcome: status,
      });
      return status;
    }
    return 'uncertain';
  }

  /** Let the initial HTTP action report a prompt native ACK. The deadline only
   * ends this wait; it never dispatches again or interprets silence as refusal. */
  waitForReceipt(input: CodexSteerInput): Promise<UserSteerResult> {
    const { events, sessionId, operator } = this.owner;
    const receipt = events.userSteering.read(sessionId, operator, input);
    if (!receipt) return Promise.resolve({ status: 'uncertain' });
    const status = this.settledStatus(input, receipt);
    if (status !== 'uncertain') return Promise.resolve({ status });
    const pending = this.pending.get(receipt.uuid);
    if (!pending) return Promise.resolve({ status: 'uncertain' });
    // Pre-stdin admission checks can take about a second before release, and the
    // provider echo follows it (longer with screenshots). A release inside the
    // initial window earns a full echo wait from that release, within a cap, so a
    // prompt ACK is not reported as unconfirmed. Later silence stays `uncertain`.
    const started = Date.now();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (status: Outcome) => {
        clearTimeout(timer);
        pending.waiters.delete(finish);
        resolve({ status });
      };
      const expire = () => {
        const now = Date.now();
        const deadline =
          pending.releasedAt === undefined
            ? now
            : Math.min(started + RECEIPT_MAX_WAIT_MS, pending.releasedAt + RECEIPT_ECHO_WAIT_MS);
        if (now >= deadline) finish('uncertain');
        else timer = setTimeout(expire, deadline - now);
      };
      pending.waiters.add(finish);
      timer = setTimeout(expire, RECEIPT_ECHO_WAIT_MS);
    });
  }
  beforeInput(
    message: SDKUserMessage,
    queryAvailable: boolean,
    query?: object,
  ): boolean | undefined {
    const pending = this.inputs.get(message);
    if (!pending) return;
    // A result may win while this input awaits asynchronous account checks.
    // Its positive pre-stdin refusal must survive that late queue drain.
    if (pending.rejected) return false;
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
    pending.releasedAt = Date.now();
    pending.query = query;
    log.info('SDK correction released to provider stdin', {
      code: 'sdk_correction_submitted',
      stage: 'stdin',
      sessionId,
      requestId: pending.input.requestId,
      targetCommandId: pending.input.targetCommandId,
    });
    return true;
  }
  /** A correction released to stdin during the final model request is echoed by
   * the follow-up turn that the CLI starts right after this result. Claim that
   * result once so the same command can own the follow-up turn. */
  holdTurnForLateEcho(query: object): string | undefined {
    const target = this.owner.ordinaryCommandId
      ? this.owner.ordinaryCommandId()
      : this.owner.activeCommandId();
    for (const pending of this.pending.values()) {
      if (
        pending.attempted &&
        !pending.heldTurn &&
        pending.query === query &&
        pending.input.targetCommandId === target
      ) {
        pending.heldTurn = true;
        return pending.input.requestId;
      }
    }
    return undefined;
  }
  /** True while a held correction still awaits its provider echo. */
  awaitingLateEcho(query: object): boolean {
    for (const pending of this.pending.values())
      if (pending.heldTurn && pending.attempted && pending.query === query) return true;
    return false;
  }
  observe(
    event: Readonly<Record<string, unknown>>,
    query?: object,
    queryAvailable = true,
  ): boolean {
    if (event.type === 'result' && query && queryAvailable) {
      const target = this.owner.ordinaryCommandId
        ? this.owner.ordinaryCommandId()
        : this.owner.activeCommandId();
      const { events, sessionId, operator } = this.owner;
      for (const [uuid, pending] of this.pending) {
        if (pending.input.targetCommandId !== target) continue;
        if (pending.attempted) {
          // Stdin release without its exact echo proves neither acceptance nor
          // rejection, and the turn that could echo it is over. Retire the receipt
          // to its terminal unconfirmed state (never replayed, never "accepted") so
          // the operator can decide, instead of leaving it uncertain forever.
          events.userSteering.transition(sessionId, operator, pending.input, 'unconfirmed');
          log.warn('SDK correction outcome unconfirmed at turn completion', {
            code: 'sdk_correction_ack_unconfirmed',
            stage: 'turn_completion',
            sessionId,
            requestId: pending.input.requestId,
            targetCommandId: target,
          });
          for (const finish of pending.waiters) finish('unconfirmed');
        } else {
          events.userSteering.transition(sessionId, operator, pending.input, 'rejected');
          pending.rejected = true;
          for (const finish of pending.waiters) finish('rejected');
          log.warn('SDK correction refused because its turn finished before stdin', {
            code: 'sdk_correction_turn_finished',
            stage: 'turn_completion',
            sessionId,
            requestId: pending.input.requestId,
            targetCommandId: target,
          });
        }
        this.pending.delete(uuid);
      }
    }
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
    log.info('SDK correction acknowledged by provider', {
      code: 'sdk_correction_accepted',
      stage: 'provider_ack',
      sessionId,
      requestId: retained.input.requestId,
      followUpTurn: pending.heldTurn === true,
    });
    for (const finish of pending.waiters) finish('accepted');
    this.pending.delete(event.uuid);
    return true;
  }
}
