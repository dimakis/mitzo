import { expect, it, vi } from 'vitest';
import {
  CAPACITY_REATTACH_READY_TIMEOUT_MS,
  retryCapacityAfterReattachment,
  waitForReattachedCodexRuntime,
} from '../codex-capacity-reattachment.js';
const target = { recoveryId: 'recovery', sourceCommandId: 'source' };
it('waits for explicitly verified readiness after restart without starting continuation early', async () => {
  const retry = vi.fn(async () => 'queued' as const);
  let ready!: () => void;
  const operation = retryCapacityAfterReattachment(target, {
    read: () => ({ id: 'recovery', sourceCommandId: 'source', revision: 1 }),
    reattach: () =>
      new Promise((resolve) => {
        ready = () => resolve('ready');
      }),
    retry,
  });
  expect(retry).not.toHaveBeenCalled();
  ready();
  expect(await operation).toBe('queued');
  expect(retry).toHaveBeenCalledOnce();
});
it('does not reattach a stale requested recovery or dispatch after Stop wins during startup', async () => {
  const reattach = vi.fn(async () => 'ready' as const);
  const retry = vi.fn(async () => 'queued' as const);
  await expect(
    retryCapacityAfterReattachment(target, { read: () => undefined, reattach, retry }),
  ).rejects.toThrow('changed');
  expect(reattach).not.toHaveBeenCalled();
  const read = vi
    .fn()
    .mockReturnValueOnce({ id: 'recovery', sourceCommandId: 'source', revision: 1 })
    .mockReturnValueOnce({ id: 'recovery', sourceCommandId: 'source', revision: 2 });
  await expect(retryCapacityAfterReattachment(target, { read, reattach, retry })).rejects.toThrow(
    'changed',
  );
  expect(retry).not.toHaveBeenCalled();
});
it('keeps unavailable readiness separate from a dispatch', async () => {
  const retry = vi.fn(async () => 'queued' as const);
  expect(
    await retryCapacityAfterReattachment(target, {
      read: () => ({ id: 'recovery', sourceCommandId: 'source', revision: 1 }),
      reattach: async () => 'unavailable',
      retry,
    }),
  ).toBe('unavailable');
  expect(retry).not.toHaveBeenCalled();
});

it('reaches manual continuation when runtime registers while the chat lifetime stays open', async () => {
  vi.useFakeTimers();
  let closeSession!: () => void;
  const lifetime = new Promise<void>((resolve) => {
    closeSession = resolve;
  });
  let registered!: () => void;
  const readiness = new Promise<boolean>((resolve) => {
    registered = () => resolve(true);
  });
  const retry = vi.fn(async () => 'queued' as const);
  const waitForRuntime = vi.fn(async () => readiness);
  try {
    const operation = retryCapacityAfterReattachment(target, {
      read: () => ({ id: 'recovery', sourceCommandId: 'source', revision: 1 }),
      reattach: async () =>
        (await waitForReattachedCodexRuntime(lifetime, waitForRuntime)) ? 'ready' : 'unavailable',
      retry,
    });
    expect(retry).not.toHaveBeenCalled();
    registered();
    await vi.advanceTimersByTimeAsync(0);
    expect(retry).toHaveBeenCalledOnce();
    expect(await operation).toBe('queued');
  } finally {
    closeSession();
    vi.useRealTimers();
  }
});

it.each(['closed', 'failed'] as const)(
  'returns unavailable when startup %s before readiness, cancelling the readiness wait',
  async (kind) => {
    let signal!: AbortSignal;
    const lifetime =
      kind === 'closed' ? Promise.resolve() : Promise.reject(new Error('private startup detail'));
    expect(
      await waitForReattachedCodexRuntime(lifetime, async (value) => {
        signal = value;
        return new Promise<boolean>(() => {});
      }),
    ).toBe(false);
    expect(signal.aborted).toBe(true);
  },
);
it('returns unavailable at the bounded runtime-readiness deadline while the session remains open', async () => {
  vi.useFakeTimers();
  try {
    let signal!: AbortSignal;
    const operation = waitForReattachedCodexRuntime(new Promise<void>(() => {}), async (value) => {
      signal = value;
      return new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), CAPACITY_REATTACH_READY_TIMEOUT_MS),
      );
    });
    expect(CAPACITY_REATTACH_READY_TIMEOUT_MS).toBeLessThan(15_000);
    await vi.advanceTimersByTimeAsync(CAPACITY_REATTACH_READY_TIMEOUT_MS);
    expect(await operation).toBe(false);
    expect(signal.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
