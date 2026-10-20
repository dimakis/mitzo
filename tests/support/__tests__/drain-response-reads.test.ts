import { expect, it, vi } from 'vitest';
import { drainResponseReads } from '../drain-response-reads';

it('keeps the owner open for a body read queued while an earlier read settles', async () => {
  let first!: () => void;
  let last!: () => void;
  const reads: Promise<void>[] = [];
  const later = new Promise<void>((resolve) => {
    last = resolve;
  });
  reads.push(
    new Promise<void>((resolve) => {
      first = resolve;
    }).then(() => {
      reads.push(later);
    }),
  );
  const close = vi.fn();
  const finish = drainResponseReads(reads).then(close);
  first();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(reads).toHaveLength(2);
  expect(close).not.toHaveBeenCalled();
  last();
  await finish;
  expect(close).toHaveBeenCalledOnce();
});

it('preserves an observer rejection instead of turning it into successful teardown', async () => {
  const failure = new Error('Original body read failed');
  await expect(drainResponseReads([Promise.reject(failure)])).rejects.toBe(failure);
});
