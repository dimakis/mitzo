import { expect, it } from 'vitest';
import { observePrivateHelperBoundary } from './fixtures/private-helper-boundary-diagnostics.js';

it('preserves the original owner receiver while attributing post-worker expiry', async () => {
  let now = 100;
  const calls: string[] = [];
  const input = {
    timeoutMs: 30,
    deadline: 200,
    signal: new AbortController().signal,
    assertCurrentSync() {
      expect(this).toBe(input);
      calls.push('sync');
    },
    async revalidate() {
      expect(this).toBe(input);
      calls.push('async');
      now += 5;
    },
  };
  const originalSync = input.assertCurrentSync;
  const originalAsync = input.revalidate;
  const rows: unknown[] = [];
  await expect(
    observePrivateHelperBoundary(
      input,
      async (same) => {
        expect(same).toBe(input);
        same.assertCurrentSync();
        await same.revalidate();
        now += 30;
        await same.revalidate();
        if (now >= 130) throw Error('Private native file helper unavailable');
      },
      rows,
      () => now,
    ),
  ).rejects.toThrow('Private native file helper unavailable');
  expect(calls).toEqual(['sync', 'async', 'async']);
  expect(input.assertCurrentSync).toBe(originalSync);
  expect(input.revalidate).toBe(originalAsync);
  expect(rows).toMatchObject([
    {
      timeoutMs: 30,
      elapsedMs: 40,
      remainingMs: -10,
      status: 'rejected',
      gates: [
        { kind: 'sync', remainingMs: 30, status: 'returned' },
        { kind: 'async', remainingMs: 25, status: 'returned' },
        { kind: 'async', remainingMs: -10, status: 'returned' },
      ],
    },
  ]);
  expect(JSON.stringify(rows)).not.toContain('Private native file helper unavailable');
});

it('retains a failing owner error and restores callbacks after rejection', async () => {
  const failure = Error('/private/secret owner changed');
  const input = {
    timeoutMs: 30,
    signal: new AbortController().signal,
    assertCurrentSync() {
      throw failure;
    },
    async revalidate() {},
  };
  const original = input.assertCurrentSync;
  const rows: unknown[] = [];
  await expect(
    observePrivateHelperBoundary(
      input,
      async (same) => same.assertCurrentSync(),
      rows,
      () => 100,
    ),
  ).rejects.toBe(failure);
  expect(input.assertCurrentSync).toBe(original);
  expect(rows).toMatchObject([
    { status: 'rejected', gates: [{ kind: 'sync', status: 'rejected' }] },
  ]);
  expect(JSON.stringify(rows)).not.toContain('/private/secret');
});
