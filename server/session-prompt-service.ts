import { SessionTimerCreateSchema, SessionMessageSendSchema } from '@mitzo/protocol';
import { createLogger } from './logger.js';
import type { AuthSession } from './auth.js';
import {
  SessionPromptError,
  type SessionPromptDelivery,
  type SessionPromptStore,
} from './session-prompt-store.js';
const log = createLogger('session-prompts');

export interface SessionPromptPort {
  sessions?(auth: AuthSession): Promise<Array<{ sessionId: string; title: string }>>;
  authorized(auth: AuthSession): boolean;
  inspect(sessionId: string, auth: AuthSession): Promise<{ busy: boolean }>;
  deliver(
    delivery: SessionPromptDelivery,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<void>;
  receipt(delivery: SessionPromptDelivery): 'absent' | 'accepted' | 'uncertain';
  close(): void;
}
export function sessionPromptReceipt(delivery: SessionPromptDelivery) {
  return {
    id: delivery.id,
    commandId: delivery.commandId,
    sessionId: delivery.recipientSessionId,
    senderSessionId: delivery.senderSessionId,
    workId: delivery.workId,
    state: delivery.state,
    error: delivery.error,
  };
}

/** One durable scheduler, shared by human and agent entry points. Timers never
 * keep a model alive; the ordinary command owner admits each eventual prompt. */
export class SessionPromptService {
  private ticking?: Promise<void>;
  private clock?: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly controllers = new Map<string, AbortController>();
  private readonly inFlight = new Map<string, Promise<void>>();
  constructor(
    readonly store: SessionPromptStore,
    private readonly port: SessionPromptPort,
  ) {}
  private authorize(auth: AuthSession) {
    if (this.closed || !this.port.authorized(auth))
      throw new SessionPromptError(
        'Timer authorization expired or was revoked. Sign in and resume the timer.',
        403,
      );
  }
  list(sessionId?: string) {
    return this.store.list(sessionId);
  }
  async sessions(auth: AuthSession) {
    this.authorize(auth);
    const result = (await this.port.sessions?.(auth)) ?? [];
    this.authorize(auth);
    return result;
  }
  async create(
    raw: unknown,
    auth: AuthSession,
    createdBy: 'user' | 'agent',
    sourceSessionId: string | null,
    assertCurrent?: () => void,
  ) {
    const input = SessionTimerCreateSchema.parse(raw);
    this.authorize(auth);
    await this.port.inspect(input.sessionId, auth);
    assertCurrent?.();
    this.authorize(auth);
    return this.store.create(input, auth, createdBy, sourceSessionId);
  }
  change(id: string, raw: unknown, auth: AuthSession) {
    this.authorize(auth);
    const timer = this.store.change(id, raw, auth);
    for (const [deliveryId, controller] of this.controllers) {
      if (this.store.delivery(deliveryId).timerId !== id) continue;
      try {
        this.store.assertDeliveryCurrent(deliveryId);
      } catch {
        controller.abort();
      }
    }
    return timer;
  }
  async send(raw: unknown, auth: AuthSession, sourceSessionId: string, assertCurrent?: () => void) {
    const input = SessionMessageSendSchema.parse(raw);
    this.authorize(auth);
    await this.port.inspect(sourceSessionId, auth);
    await this.port.inspect(input.sessionId, auth);
    assertCurrent?.();
    this.authorize(auth);
    const original = this.store.message(input, auth, sourceSessionId);
    return sessionPromptReceipt(this.store.delivery(original.id));
  }
  start() {
    if (this.clock || this.closed) return;
    this.clock = setInterval(() => {
      void this.tick().catch(() => log.warn('Session prompt reconciliation is unavailable'));
    }, 5000);
    this.clock.unref();
    void this.tick().catch(() => log.warn('Session prompt reconciliation is unavailable'));
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.ticking) return this.ticking;
    this.ticking = this.run().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }
  private receipt(delivery: SessionPromptDelivery): ReturnType<SessionPromptPort['receipt']> {
    try {
      return this.port.receipt(delivery);
    } catch {
      // Unreadable evidence is uncertainty, never absence or retry authority.
      // One recipient's retained history must not stop unrelated deliveries.
      return 'uncertain';
    }
  }
  private async run() {
    // Reconcile retained uncertain delivery even after a timer has been paused.
    for (const delivery of this.store.deliveries(['dispatching', 'uncertain'])) {
      if (this.receipt(delivery) === 'accepted') this.store.finish(delivery.id, 'accepted', null);
      else if (delivery.state === 'dispatching')
        this.store.finish(
          delivery.id,
          'uncertain',
          'An earlier check was interrupted. Its original delivery must be verified.',
        );
    }
    const groups = new Map<string, SessionPromptDelivery[]>();
    for (const delivery of this.store.due()) {
      const group = groups.get(delivery.recipientSessionId) ?? [];
      group.push(delivery);
      groups.set(delivery.recipientSessionId, group);
    }
    const batches = [...groups.values()];
    for (let offset = 0; offset < batches.length && !this.closed; offset += 4)
      await Promise.allSettled(
        batches.slice(offset, offset + 4).map(async (group) => {
          for (const delivery of group) await this.process(delivery);
        }),
      );
  }
  async cancelSession(sessionId: string) {
    this.store.cancelSession(sessionId);
    const pending: Promise<void>[] = [];
    for (const [id, completion] of this.inFlight) {
      const delivery = this.store.delivery(id);
      if (delivery.recipientSessionId !== sessionId && delivery.senderSessionId !== sessionId)
        continue;
      this.controllers.get(id)?.abort();
      pending.push(completion);
    }
    await Promise.all(pending);
    let uncertain = false;
    for (const delivery of this.store.deliveries(['dispatching', 'uncertain'])) {
      if (delivery.recipientSessionId !== sessionId && delivery.senderSessionId !== sessionId)
        continue;
      const receipt = this.receipt(delivery);
      this.store.finish(
        delivery.id,
        receipt === 'accepted' ? 'accepted' : receipt === 'absent' ? 'failed' : 'uncertain',
        receipt === 'accepted'
          ? null
          : receipt === 'absent'
            ? 'Cancelled before acceptance.'
            : 'Delivery acceptance is uncertain. Reconcile its original receipt before removal.',
      );
      if (receipt === 'uncertain') uncertain = true;
    }
    if (uncertain)
      throw new SessionPromptError(
        'Delivery acceptance is uncertain. Reconcile its original receipt before removal.',
      );
  }
  private process(delivery: SessionPromptDelivery): Promise<void> {
    const completion = this.dispatch(delivery).finally(() => this.inFlight.delete(delivery.id));
    this.inFlight.set(delivery.id, completion);
    return completion;
  }
  private async dispatch(delivery: SessionPromptDelivery) {
    if (delivery.state !== 'pending') return;
    const controller = new AbortController();
    this.controllers.set(delivery.id, controller);
    let claimed = false;
    try {
      const current = () => {
        controller.signal.throwIfAborted();
        this.authorize(delivery.auth);
        this.store.assertDeliveryCurrent(delivery.id);
      };
      current();
      const { busy } = await this.port.inspect(delivery.recipientSessionId, delivery.auth);
      current();
      if (busy) return;
      claimed = this.store.claim(delivery.id);
      if (!claimed) return;
      current();
      await this.port.deliver(delivery, controller.signal, current);
      // Acceptance is retained even if a simultaneous pause/cancel won the race.
      this.store.finish(delivery.id, 'accepted', null);
    } catch (error) {
      const receipt = claimed ? this.receipt(delivery) : 'absent';
      const message =
        error instanceof SessionPromptError
          ? error.message
          : controller.signal.aborted
            ? 'Check cancelled before confirmed acceptance.'
            : 'The session could not accept this prompt. Open the session and check its status before resuming.';
      this.store.finish(
        delivery.id,
        receipt === 'accepted' ? 'accepted' : receipt === 'uncertain' ? 'uncertain' : 'failed',
        receipt === 'accepted' ? null : message,
      );
    } finally {
      this.controllers.delete(delivery.id);
    }
  }
  close() {
    this.closed = true;
    if (this.clock) clearInterval(this.clock);
    this.clock = undefined;
    for (const controller of this.controllers.values()) controller.abort();
    this.port.close();
  }
  async drain() {
    this.close();
    await this.ticking;
  }
}
