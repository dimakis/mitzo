import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

export type ToolGuardPhase = 'approval' | 'execution' | 'cleanup';
export interface ToolGuardPolicy {
  executionMs: number;
  approvalMs: number;
  cleanupMs: number;
}
export const DEFAULT_TOOL_GUARD_POLICY: Readonly<ToolGuardPolicy> = Object.freeze({
  executionMs: 180_000,
  // Let the permission owner's 120-second expiry settle before this watchdog.
  approvalMs: 125_000,
  cleanupMs: 10_000,
});
export class ToolGuardTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  readonly effectStatus = 'unknown';
  constructor(readonly phase: ToolGuardPhase) {
    super(`Tool ${phase} deadline exceeded; inspect the original operation before retrying`);
    this.name = 'ToolGuardTimeoutError';
  }
}
interface GuardScope {
  signal: AbortSignal;
  assertCurrent(): void;
  enter(phase: ToolGuardPhase): () => void;
}
const currentGuard = new AsyncLocalStorage<GuardScope>();

/** A late callback can observe its own retirement, never borrow another call's authority. */
export function assertToolGuardCurrent(): void {
  currentGuard.getStore()?.assertCurrent();
}

/** Exclude human wait from execution time; each phase retains its cumulative budget. */
export async function withToolGuardPhase<T>(
  phase: ToolGuardPhase,
  work: () => T | Promise<T>,
): Promise<T> {
  const restore = currentGuard.getStore()?.enter(phase);
  try {
    return await work();
  } finally {
    restore?.();
  }
}

/** Cleanup still runs after cancellation, with a fresh bounded lifetime. Original
 * executor/authority fences remain in force; this grants no execution permission. */
export function runBoundedToolCleanup<T>(
  work: () => T | Promise<T>,
  timeoutMs = 10_000,
): Promise<T> {
  return currentGuard.exit(() =>
    runGuardedTool(
      {
        signal: new AbortController().signal,
        policy: { executionMs: timeoutMs, approvalMs: timeoutMs, cleanupMs: timeoutMs },
      },
      () => withToolGuardPhase('cleanup', work),
    ),
  );
}

export interface ToolGuardObservation {
  phase: ToolGuardPhase;
  outcome: 'completed' | 'failed' | 'cancelled' | 'timeout';
  elapsedMs: Readonly<Record<ToolGuardPhase, number>>;
}

/** Bounds the caller's wait even for noncooperative adapters. This does not prove
 * that an external effect stopped: timeout/cancellation must retain its original
 * uncertainty fence. Executors still own process termination and reconciliation.
 * Nested adapters share the original budget and cannot enlarge it.
 */
export async function runGuardedTool<T>(
  options: {
    signal: AbortSignal;
    policy?: Readonly<ToolGuardPolicy>;
    onSettled?: (observation: ToolGuardObservation) => void;
    onLateSettlement?: (outcome: 'fulfilled' | 'rejected') => void;
  },
  execute: (signal: AbortSignal) => T | Promise<T>,
): Promise<T> {
  options.signal.throwIfAborted();
  const parent = currentGuard.getStore();
  if (parent) {
    parent.assertCurrent();
    return execute(AbortSignal.any([options.signal, parent.signal]));
  }
  const policy = { ...(options.policy ?? DEFAULT_TOOL_GUARD_POLICY) };
  if (Object.values(policy).some((value) => !Number.isFinite(value) || value <= 0))
    throw new Error('Invalid tool guard policy');
  const controller = new AbortController();
  // Original cancellation remains live through result delivery and later owner
  // retirement, even after this guard removes its own event listener.
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let phase: ToolGuardPhase = 'execution';
  let started = performance.now();
  const elapsed = { approval: 0, execution: 0, cleanup: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let retirement: unknown;
  const account = () => {
    const now = performance.now();
    elapsed[phase] += Math.max(0, now - started);
    started = now;
  };
  return new Promise<T>((resolve, reject) => {
    const finish = (
      outcome: ToolGuardObservation['outcome'],
      value: T | undefined,
      error?: unknown,
    ) => {
      if (closed) return;
      account();
      closed = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      if (outcome === 'timeout' || outcome === 'cancelled') {
        retirement = error;
        controller.abort(error);
      }
      try {
        options.onSettled?.({ phase, outcome, elapsedMs: Object.freeze({ ...elapsed }) });
      } catch {
        /* Telemetry cannot replace the original outcome. */
      }
      if (outcome === 'completed') resolve(value as T);
      else reject(error);
    };
    const arm = () => {
      clearTimeout(timer);
      const budget = policy[`${phase}Ms`];
      timer = setTimeout(
        () => finish('timeout', undefined, new ToolGuardTimeoutError(phase)),
        Math.max(0, budget - elapsed[phase]),
      );
      timer.unref?.();
    };
    const assertCurrent = () => {
      if (closed) throw retirement ?? new Error('Tool callback already settled');
      controller.signal.throwIfAborted();
      options.signal.throwIfAborted();
    };
    const scope: GuardScope = {
      signal,
      assertCurrent,
      enter(next) {
        assertCurrent();
        account();
        const previous = phase;
        phase = next;
        arm();
        return () => {
          if (closed) return;
          account();
          phase = previous;
          arm();
        };
      },
    };
    const onAbort = () => finish('cancelled', undefined, options.signal.reason);
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) {
      onAbort();
      return;
    }
    arm();
    const late = (outcome: 'fulfilled' | 'rejected') => {
      try {
        options.onLateSettlement?.(outcome);
      } catch {
        /* Optional telemetry. */
      }
    };
    try {
      Promise.resolve(currentGuard.run(scope, () => execute(signal))).then(
        (value) => (closed ? late('fulfilled') : finish('completed', value)),
        (error: unknown) => (closed ? late('rejected') : finish('failed', undefined, error)),
      );
    } catch (error) {
      finish('failed', undefined, error);
    }
  });
}
