import { expect, it, vi } from 'vitest';
import { singleFlightReconciliation } from '../single-flight-reconciliation.js';

it('skips ticks while reconciliation is pending and admits the next tick after success', async () => {
  let finish!: () => void;
  const work = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const failed = vi.fn();
  const tick = singleFlightReconciliation(work, failed);
  tick();
  tick();
  tick();
  expect(work).toHaveBeenCalledOnce();
  finish();
  await Promise.resolve();
  await Promise.resolve();
  tick();
  expect(work).toHaveBeenCalledTimes(2);
  finish();
  expect(failed).not.toHaveBeenCalled();
});

it('reports failure and releases the slot for a later recovery tick', async () => {
  let fail!: (reason: unknown) => void;
  const work = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        fail = reject;
      }),
  );
  const failed = vi.fn();
  const tick = singleFlightReconciliation(work, failed);
  tick();
  const error = Error('gateway unavailable');
  fail(error);
  await Promise.resolve();
  await Promise.resolve();
  expect(failed).toHaveBeenCalledWith(error);
  tick();
  expect(work).toHaveBeenCalledTimes(2);
  fail(error);
  await Promise.resolve();
  await Promise.resolve();
});

it('handles synchronous failure and reentrant ticks without queueing extra work', async () => {
  const failed = vi.fn();
  const work = vi.fn(() => {
    tick();
    throw Error('synchronous failure');
  });
  const tick = singleFlightReconciliation(work, failed);
  tick();
  expect(work).toHaveBeenCalledOnce();
  expect(failed).toHaveBeenCalledOnce();
  tick();
  expect(work).toHaveBeenCalledTimes(2);
  await Promise.resolve();
});
