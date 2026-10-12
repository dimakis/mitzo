import { expect, it, vi } from 'vitest';
import { StagingOwnedCleanup } from '../staging-feature-cleanup.js';

it('keeps the original cleanup capability before query initialization and invokes it once', async () => {
  const owned = new StagingOwnedCleanup();
  const close = vi.fn(async () => {});
  owned.retain(close);
  await owned.confirm(1000);
  await owned.confirm(1000);
  expect(close).toHaveBeenCalledOnce();
  expect(() => owned.retain(async () => {})).toThrow('sealed');
});
it('retains a pending original acknowledgment after a finite deadline without retry or inferred proof', async () => {
  vi.useFakeTimers();
  try {
    let ack!: () => void;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          ack = resolve;
        }),
    );
    const owned = new StagingOwnedCleanup();
    owned.retain(close);
    const result = owned.confirm(1000);
    const failed = expect(result).rejects.toThrow('unconfirmed');
    await vi.advanceTimersByTimeAsync(1000);
    await failed;
    expect(owned.confirmed).toBe(false);
    ack();
    await owned.confirm(1000);
    expect(owned.confirmed).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
it('does not lose another original handle when a cleanup callback throws synchronously', async () => {
  const owned = new StagingOwnedCleanup();
  const second = vi.fn(async () => {});
  owned.retain(() => {
    throw new Error('private');
  });
  owned.retain(second);
  await expect(owned.confirm(1000)).rejects.toThrow('unconfirmed');
  expect(second).toHaveBeenCalledOnce();
  expect(owned.confirmed).toBe(false);
});
it('refuses an empty capability set and excessive cleanup budgets', async () => {
  const owned = new StagingOwnedCleanup();
  await expect(owned.confirm(1000)).rejects.toThrow('unconfirmed');
  await expect(owned.confirm(6000)).rejects.toThrow('budget');
});
