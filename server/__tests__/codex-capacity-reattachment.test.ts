import { expect, it, vi } from 'vitest';
import { retryCapacityAfterReattachment } from '../codex-capacity-reattachment.js';
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
