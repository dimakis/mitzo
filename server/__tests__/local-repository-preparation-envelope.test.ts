import { afterEach, expect, it, vi } from 'vitest';
import { withLocalRepositoryPreparationEnvelope } from '../local-repository-preparation-operation.js';

afterEach(() => vi.useRealTimers());
it('mints one fixed absolute envelope before context capture and joins cleanup after expiry', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const parent = new AbortController();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signal!: AbortSignal,
    done = false,
    closed = false;
  const pending = withLocalRepositoryPreparationEnvelope(parent.signal, async (envelope) => {
    expect(Object.isFrozen(envelope)).toBe(true);
    signal = envelope.signal;
    expect(envelope.deadline).toBe(301000);
    expect(envelope.stageDeadline()).toBe(31000);
    try {
      await held;
      envelope.assertCurrentSync();
      return 'must not return';
    } finally {
      closed = true;
    }
  }).finally(() => {
    done = true;
  });
  const outcome = expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(300000);
  expect(signal.aborted).toBe(true);
  expect(done).toBe(false);
  expect(closed).toBe(false);
  release();
  await outcome;
  expect(closed).toBe(true);
  expect(done).toBe(true);
});
it('narrows the last stage to the original remaining deadline without renewing it', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  await withLocalRepositoryPreparationEnvelope(new AbortController().signal, async (envelope) => {
    await vi.advanceTimersByTimeAsync(295000);
    expect(envelope.deadline).toBe(301000);
    expect(envelope.stageDeadline()).toBe(301000);
  });
  expect(vi.getTimerCount()).toBe(0);
});
it('joins actual pending action cleanup after original Stop and never returns success', async () => {
  const parent = new AbortController();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let done = false;
  const pending = withLocalRepositoryPreparationEnvelope(parent.signal, async (envelope) => {
    await held;
    expect(envelope.signal.aborted).toBe(true);
    return 'must not return';
  }).finally(() => {
    done = true;
  });
  const outcome = expect(pending).rejects.toThrow('synthetic Stop');
  parent.abort(Error('synthetic Stop'));
  await Promise.resolve();
  expect(done).toBe(false);
  release();
  await outcome;
});
it('rejects already-cancelled entry before invoking genuine context capture', async () => {
  const parent = new AbortController();
  parent.abort(Error('synthetic closed owner'));
  const capture = vi.fn(async () => 'must not run');
  await expect(withLocalRepositoryPreparationEnvelope(parent.signal, capture)).rejects.toThrow(
    'synthetic closed owner',
  );
  expect(capture).not.toHaveBeenCalled();
});
