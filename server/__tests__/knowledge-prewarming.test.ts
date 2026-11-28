import { afterEach, expect, it, vi } from 'vitest';
import { startKnowledgePrewarming } from '../knowledge-prewarming.js';
import { KnowledgePublicationUnavailableError } from '../knowledge-publication-bridge.js';

const fakeLog = () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() });
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
  const host = startKnowledgePrewarming({ prewarm }, { intervalMs: 100, log: fakeLog() })!;
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
  const log = fakeLog();
  let selectedSignal!: AbortSignal;
  const prewarm = vi
    .fn<(signal: AbortSignal) => Promise<void>>()
    .mockRejectedValueOnce(Error('publisher unavailable'))
    .mockImplementation((signal) => {
      selectedSignal = signal;
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    });
  const host = startKnowledgePrewarming({ prewarm }, { intervalMs: 100, log })!;
  await vi.advanceTimersByTimeAsync(100);
  expect(log.warn).toHaveBeenCalledOnce();
  expect(prewarm).toHaveBeenCalledTimes(2);
  await host.close();
  expect(selectedSignal.aborted).toBe(true);
  expect(log.warn).toHaveBeenCalledOnce();
  expect(log.debug).not.toHaveBeenCalled();
});
it('reports the failing stage once per distinct failure, counts repeats quietly and logs recovery', async () => {
  vi.useFakeTimers();
  const log = fakeLog();
  const missing = () =>
    new KnowledgePublicationUnavailableError({ stage: 'http_status', status: 404 });
  const prewarm = vi
    .fn<(signal: AbortSignal) => Promise<void>>()
    .mockRejectedValueOnce(missing())
    .mockRejectedValueOnce(missing())
    .mockRejectedValueOnce(missing())
    .mockRejectedValueOnce(
      new KnowledgePublicationUnavailableError({ stage: 'http_status', status: 503 }),
    )
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(missing());
  const host = startKnowledgePrewarming({ prewarm }, { intervalMs: 100, log })!;
  await vi.advanceTimersByTimeAsync(0);
  expect(log.warn).toHaveBeenCalledExactlyOnceWith(
    'Knowledge conversion prewarming unavailable; commands retain fresh admission',
    expect.objectContaining({
      stage: 'http_status',
      code: 'http_error',
      status: 404,
      consecutiveFailures: 1,
    }),
  );
  await vi.advanceTimersByTimeAsync(200);
  expect(log.warn).toHaveBeenCalledOnce();
  expect(log.debug).toHaveBeenCalledTimes(2);
  expect(log.debug).toHaveBeenLastCalledWith(
    'Knowledge conversion prewarming still unavailable',
    expect.objectContaining({ stage: 'http_status', status: 404, consecutiveFailures: 3 }),
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(log.warn).toHaveBeenCalledTimes(2);
  expect(log.warn).toHaveBeenLastCalledWith(
    'Knowledge conversion prewarming unavailable; commands retain fresh admission',
    expect.objectContaining({ status: 503, consecutiveFailures: 4 }),
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(log.info).toHaveBeenCalledExactlyOnceWith('Knowledge conversion prewarming recovered', {
    consecutiveFailures: 4,
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(log.info).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(100);
  // A failure after recovery is new and is reported again at warn level.
  expect(log.warn).toHaveBeenCalledTimes(3);
  expect(log.warn).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({ status: 404, consecutiveFailures: 1 }),
  );
  await host.close();
});
it('keeps the loop alive when the diagnostic sink throws', async () => {
  vi.useFakeTimers();
  const log = fakeLog();
  log.warn.mockImplementation(() => {
    throw Error('logger unavailable');
  });
  const prewarm = vi.fn().mockRejectedValue(Error('publisher unavailable'));
  const host = startKnowledgePrewarming({ prewarm }, { intervalMs: 100, log })!;
  await vi.advanceTimersByTimeAsync(100);
  expect(prewarm).toHaveBeenCalledTimes(2);
  await host.close();
});
it('does nothing for an unenrolled host', () => {
  expect(startKnowledgePrewarming(undefined, { log: fakeLog() })).toBeUndefined();
});
