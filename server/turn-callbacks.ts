import { SessionRuntimeError } from './session-runtime-error.js';
import { assertToolGuardCurrent } from '@mitzo/harness';
import { toolFailure } from '@mitzo/protocol';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from './logger.js';
const log = createLogger('turn-callbacks');
export type TurnCallbackRunner = <T>(operation: () => Promise<T>) => Promise<T>;
const effectOwners = new AsyncLocalStorage<() => void>();
/** A fresh effect check in an original callback cannot borrow a later turn. */
export function assertTurnCallbackEffects(): void {
  assertToolGuardCurrent();
  effectOwners.getStore()?.();
}
const outcomes = new WeakMap<object, 'settled' | 'unknown'>();
/** Original trusted callback results only: JSON, spreads and database copies cannot carry this receipt. */
export function retainCallbackOutcome<T extends object>(
  result: T,
  outcome: 'settled' | 'unknown',
): T {
  outcomes.set(result, outcome);
  return result;
}
export function callbackOutcome(result: unknown): 'settled' | 'unknown' {
  if (result && typeof result === 'object') {
    const retained = outcomes.get(result);
    if (retained) return retained;
    if (
      ('isError' in result && result.isError === true) ||
      ('is_error' in result && result.is_error === true)
    )
      return 'unknown';
  }
  return 'settled';
}
export function retainedCallbackOutcome(result: object) {
  return outcomes.get(result);
}
export function copyCallbackOutcome<T extends object>(source: object, target: T): T {
  const retained = outcomes.get(source);
  return retained ? retainCallbackOutcome(target, retained) : target;
}

/** A reviewed read-only adapter may settle a returned failure. Cancellation and
 * any explicit original-owner uncertainty are retained; exceptions are untouched. */
export async function retainReadOnlyCallbackOutcome<T extends object | undefined>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  const result = await operation();
  if (result && !signal.aborted && !outcomes.has(result)) retainCallbackOutcome(result, 'settled');
  return result;
}

/** Top-level assistant text is the agent's follow-up to earlier tool results. Sub-agent
 * messages, thinking and tool-only messages explain nothing to the operator. */
export function observeAssistantFollowUp(
  event: Readonly<Record<string, unknown>>,
  c: TurnCallbacks,
) {
  if (event.type !== 'assistant' || event.parent_tool_use_id) return;
  const content = (event.message as { content?: unknown } | undefined)?.content;
  if (
    Array.isArray(content) &&
    content.some(
      (block) =>
        block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0,
    )
  )
    c.explainUncertainOutcomes();
}

/** Surface a settled turn's uncertain tool effects on its terminal result, the
 * same notice the Codex route shows. A provider failure keeps its own message. */
export function withUncertainOutcomeNotice<T extends object>(
  result: T,
  callbacks: TurnCallbacks,
): T {
  if (!callbacks.uncertainOutcomes || 'provider_failure' in result) return result;
  log.warn('SDK turn completed with uncertain tool outcomes', {
    code: 'sdk_uncertain_tool_outcomes',
    stage: 'turn_settlement',
    uncertainOutcomes: callbacks.uncertainOutcomes,
  });
  return {
    ...result,
    tool_failure_notice: true,
    tool_failure: toolFailure('internal_failure', 'execution', 'unknown'),
  };
}

/** Original in-memory callbacks only. A reconstructed owner cannot manufacture
 * settlement, replay a tool, or treat a missing durable result as success. */
export class TurnCallbacks {
  /** `retainUnknownOutcomes` (SDK owners): the provider emits its result only
   * after every tool result reached the model, so an unknown outcome or failure
   * that finished before seal is retained as uncertain evidence for the result
   * notice instead of failing the turn. Anything settling after seal still fails. */
  constructor(private readonly options: { retainUnknownOutcomes?: boolean } = {}) {}
  private pending = new Set<Promise<unknown>>();
  private sealed = false;
  private failure?: { cause: unknown };
  private uncertain = 0;
  get size() {
    return this.pending.size;
  }
  /** Callbacks whose effects the model saw as failed or unknown in this turn. */
  get uncertainOutcomes() {
    return this.uncertain;
  }
  get needsSettlement() {
    return this.pending.size > 0 || !!this.failure;
  }
  /** The model wrote visible text after seeing the outcomes counted so far, so
   * those outcomes are followed up. Like the Codex route, only an outcome that
   * settles later, or that the turn never follows up, reaches the result notice. */
  explainUncertainOutcomes() {
    this.uncertain = 0;
  }
  track<T>(
    operation: () => Promise<T>,
    knownCancellation?: (error: unknown) => boolean,
  ): Promise<T> {
    if (this.sealed) return Promise.reject(new SessionRuntimeError('turn_completed'));
    // Register before invoking application code, including synchronous terminal notifications.
    let resolve!: (result: T | PromiseLike<T>) => void;
    let reject!: (cause: unknown) => void;
    const work = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const observation = work.then(
      (result) => {
        this.pending.delete(observation);
        if (callbackOutcome(result) !== 'unknown') return;
        if (this.sealed) this.failure ??= { cause: new SessionRuntimeError('callbacks_failed') };
        else if (this.options.retainUnknownOutcomes) this.uncertain++;
      },
      (cause: unknown) => {
        this.pending.delete(observation);
        if (knownCancellation?.(cause)) return;
        if (!this.sealed && this.options.retainUnknownOutcomes) this.uncertain++;
        else this.failure ??= { cause };
      },
    );
    this.pending.add(observation);
    try {
      resolve(
        effectOwners.run(() => {
          if (this.sealed) throw new SessionRuntimeError('turn_completed');
        }, operation),
      );
    } catch (cause) {
      reject(cause);
    }
    return work;
  }
  seal() {
    this.sealed = true;
  }
  async settle(signal: AbortSignal, timeoutMs = 15_000): Promise<void> {
    this.seal();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    try {
      signal.throwIfAborted();
      await Promise.race([
        Promise.all([...this.pending]),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(() => reject(new SessionRuntimeError('callbacks_pending')), timeoutMs);
          timer.unref?.();
          if (signal.aborted) onAbort();
        }),
      ]);
      signal.throwIfAborted();
      if (this.failure)
        throw new SessionRuntimeError('callbacks_failed', { cause: this.failure.cause });
      // Let the original transport finish its response fences/write. They can
      // still revoke this owner; settling a callback cannot revive it.
      await new Promise<void>((resolve) => setImmediate(resolve));
      signal.throwIfAborted();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
}
