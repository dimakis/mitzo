import { afterEach, expect, it, vi } from 'vitest';
import {
  assertToolGuardCurrent,
  runGuardedTool,
  ToolGuardTimeoutError,
  withToolGuardPhase,
} from '../src/tool-guard.js';

afterEach(() => vi.useRealTimers());
const policy = { executionMs: 100, approvalMs: 1000, cleanupMs: 20 };

it('returns the original result and preserves a synchronous executor failure', async () => {
  const result = { content: 'ok', isError: false };
  const signal = new AbortController().signal;
  expect(await runGuardedTool({ signal, policy }, async () => result)).toBe(result);
  const error = new Error('executor failure');
  await expect(
    runGuardedTool({ signal, policy }, () => {
      throw error;
    }),
  ).rejects.toBe(error);
});

it('bounds an executor that ignores abort and fences its late continuation', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  let executionSignal!: AbortSignal;
  let lateError: unknown;
  const late = vi.fn();
  const work = runGuardedTool(
    { signal: new AbortController().signal, policy, onLateSettlement: late },
    async (signal) => {
      executionSignal = signal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        assertToolGuardCurrent();
      } catch (error) {
        lateError = error;
        throw error;
      }
      return 'late';
    },
  );
  const failed = expect(work).rejects.toMatchObject({ code: 'ETIMEDOUT', phase: 'execution' });
  await vi.advanceTimersByTimeAsync(100);
  await failed;
  expect(executionSignal.aborted).toBe(true);
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(lateError).toBeInstanceOf(ToolGuardTimeoutError);
  expect(late).toHaveBeenCalledExactlyOnceWith('rejected');
});

it('does not spend execution time while waiting for human approval', async () => {
  vi.useFakeTimers();
  let approve!: () => void;
  const work = runGuardedTool({ signal: new AbortController().signal, policy }, async () => {
    await withToolGuardPhase(
      'approval',
      () =>
        new Promise<void>((resolve) => {
          approve = resolve;
        }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 90));
    return 'done';
  });
  await vi.advanceTimersByTimeAsync(900);
  approve();
  await vi.advanceTimersByTimeAsync(90);
  await expect(work).resolves.toBe('done');
});

it('bounds approval and cleanup independently', async () => {
  vi.useFakeTimers();
  for (const [phase, budget] of [
    ['approval', 1000],
    ['cleanup', 20],
  ] as const) {
    const work = runGuardedTool({ signal: new AbortController().signal, policy }, () =>
      withToolGuardPhase(phase, () => new Promise(() => {})),
    );
    const failed = expect(work).rejects.toMatchObject({ code: 'ETIMEDOUT', phase });
    await vi.advanceTimersByTimeAsync(budget);
    await failed;
  }
});

it('shares the original deadline across nested adapters without enlarging it', async () => {
  vi.useFakeTimers();
  const signal = new AbortController().signal;
  const work = runGuardedTool({ signal, policy }, () =>
    runGuardedTool(
      { signal, policy: { ...policy, executionMs: 10000 } },
      () => new Promise(() => {}),
    ),
  );
  const failed = expect(work).rejects.toBeInstanceOf(ToolGuardTimeoutError);
  await vi.advanceTimersByTimeAsync(100);
  await failed;
});

it('cancels promptly without a cooperative executor and observes late rejection', async () => {
  const abort = new AbortController();
  const reason = new DOMException('Stopped', 'AbortError');
  let reject!: (error: Error) => void;
  const late = vi.fn();
  const work = runGuardedTool(
    { signal: abort.signal, policy, onLateSettlement: late },
    () =>
      new Promise((_resolve, no) => {
        reject = no;
      }),
  );
  const failed = expect(work).rejects.toBe(reason);
  abort.abort(reason);
  await failed;
  reject(new Error('late failure'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(late).toHaveBeenCalledExactlyOnceWith('rejected');
});

it('never invokes an executor after cancellation and isolates separate calls', async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  abort.abort();
  const execute = vi.fn();
  await expect(runGuardedTool({ signal: abort.signal, policy }, execute)).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
  const hanging = runGuardedTool(
    { signal: new AbortController().signal, policy },
    () => new Promise(() => {}),
  );
  const failed = expect(hanging).rejects.toBeInstanceOf(ToolGuardTimeoutError);
  await expect(
    runGuardedTool({ signal: new AbortController().signal, policy }, async () => 'other chat'),
  ).resolves.toBe('other chat');
  await vi.advanceTimersByTimeAsync(100);
  await failed;
});

it('telemetry failure cannot replace a settled result or revive an executor', async () => {
  const result = {};
  await expect(
    runGuardedTool(
      {
        signal: new AbortController().signal,
        policy,
        onSettled: () => {
          throw Error('telemetry');
        },
      },
      async () => result,
    ),
  ).resolves.toBe(result);
});
