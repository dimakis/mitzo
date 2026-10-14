import { expect, it, vi } from 'vitest';
import { AppliedEventAcks } from '../applied-event-acks.js';

it('batches contiguous sequences with independent single-flight sessions', async () => {
  const releases: Array<(applied: boolean) => void> = [];
  const post = vi.fn<(sessionId: string, sequences: number[]) => Promise<boolean>>(
    () => new Promise<boolean>((resolve) => releases.push(resolve)),
  );
  const resync = vi.fn();
  const acks = new AppliedEventAcks({ post, resync });
  for (let seq = 1; seq <= 120; seq++) acks.enqueue('a', seq);
  acks.enqueue('b', 7);
  await Promise.resolve();
  expect(post.mock.calls).toEqual([
    ['a', Array.from({ length: 50 }, (_, i) => i + 1)],
    ['b', [7]],
  ]);
  releases[0](true);
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(3));
  expect(post.mock.calls[2]).toEqual(['a', Array.from({ length: 50 }, (_, i) => i + 51)]);
  releases[2](true);
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(4));
  expect(post.mock.calls[3]).toEqual(['a', Array.from({ length: 20 }, (_, i) => i + 101)]);
  releases[1](true);
  releases[3](true);
  expect(resync).not.toHaveBeenCalled();
});

it('reconnects after a rejected batch and ignores responses from a reset generation', async () => {
  const releases: Array<(applied: boolean) => void> = [];
  const post = vi.fn<(sessionId: string, sequences: number[]) => Promise<boolean>>(
    () => new Promise<boolean>((resolve) => releases.push(resolve)),
  );
  const resync = vi.fn();
  const acks = new AppliedEventAcks({ post, resync });
  acks.enqueue('a', 1);
  await Promise.resolve();
  acks.reset();
  acks.enqueue('a', 2);
  await Promise.resolve();
  releases[0](false);
  await Promise.resolve();
  expect(resync).not.toHaveBeenCalled();
  releases[1](false);
  await vi.waitFor(() => expect(resync).toHaveBeenCalledOnce());
});

it('bounds outstanding work and recovers instead of skipping applied sequences', async () => {
  const post = vi.fn<(sessionId: string, sequences: number[]) => Promise<boolean>>(
    () => new Promise<boolean>(() => {}),
  );
  const resync = vi.fn();
  const acks = new AppliedEventAcks({ post, resync });
  for (let seq = 1; seq <= 501; seq++) acks.enqueue('a', seq);
  expect(resync).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(post).not.toHaveBeenCalled();
});

it('lets an authoritative snapshot supersede stale event acknowledgements', async () => {
  let release!: (applied: boolean) => void;
  const post = vi.fn<(sessionId: string, sequences: number[]) => Promise<boolean>>(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
  );
  const resync = vi.fn();
  const acks = new AppliedEventAcks({ post, resync });
  acks.enqueue('a', 1);
  acks.enqueue('a', 2);
  await Promise.resolve();
  acks.enqueue('a', 3);
  acks.supersede('a', 5);
  release(false);
  await Promise.resolve();
  await Promise.resolve();
  expect(resync).not.toHaveBeenCalled();
  expect(post).toHaveBeenCalledOnce();
  acks.enqueue('a', 6);
  await Promise.resolve();
  expect(post.mock.calls[1]).toEqual(['a', [6]]);
});
