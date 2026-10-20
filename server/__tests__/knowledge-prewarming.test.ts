import { afterEach, expect, it, vi } from 'vitest';
import { startKnowledgePrewarming } from '../knowledge-prewarming.js';

afterEach(() => vi.useRealTimers());
it('prewarms immediately and periodically without overlapping conversions', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const prewarm = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const host = startKnowledgePrewarming({ prewarm }, { intervalMs: 100, onError: vi.fn() })!;
  expect(prewarm).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(300);
  expect(prewarm).toHaveBeenCalledOnce();
  finish();
  await vi.advanceTimersByTimeAsync(100);
  expect(prewarm).toHaveBeenCalledTimes(2);
  finish();
  await host.close();
  await vi.advanceTimersByTimeAsync(500);
  expect(prewarm).toHaveBeenCalledTimes(2);
});
it('aborts work on shutdown and retries failures without changing chat admission', async () => {
  vi.useFakeTimers();
  const failure = Error('publisher unavailable');
  const onError = vi.fn();
  let selectedSignal!: AbortSignal;
  const prewarm = vi
    .fn<(signal: AbortSignal) => Promise<void>>()
    .mockRejectedValueOnce(failure)
    .mockImplementation((signal) => {
      selectedSignal = signal;
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    });
  const host = startKnowledgePrewarming({ prewarm }, { intervalMs: 100, onError })!;
  await vi.advanceTimersByTimeAsync(100);
  expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
  expect(prewarm).toHaveBeenCalledTimes(2);
  await host.close();
  expect(selectedSignal.aborted).toBe(true);
  expect(onError).toHaveBeenCalledOnce();
});
it('does nothing for an unenrolled host', () => {
  expect(startKnowledgePrewarming(undefined, { onError: vi.fn() })).toBeUndefined();
});
