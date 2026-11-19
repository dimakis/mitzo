import { describe, expect, it, vi } from 'vitest';
import { AuthorityProofCache } from '../authority-proof-cache.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AuthorityProofCache', () => {
  it('shares one in-flight proof between concurrent callers', async () => {
    const cache = new AuthorityProofCache(5_000, () => 0);
    const gate = deferred();
    const prove = vi.fn(() => gate.promise);
    const callers = Array.from({ length: 12 }, () => cache.run('effect:c1', prove));
    gate.resolve();
    await Promise.all(callers);
    expect(prove).toHaveBeenCalledTimes(1);
  });

  it('reuses a successful proof inside the window and proves again after it', async () => {
    let now = 0;
    const cache = new AuthorityProofCache(5_000, () => now);
    const prove = vi.fn(async () => {});
    await cache.run('effect:c1', prove);
    now = 4_999;
    await cache.run('effect:c1', prove);
    expect(prove).toHaveBeenCalledTimes(1);
    now = 5_000;
    await cache.run('effect:c1', prove);
    expect(prove).toHaveBeenCalledTimes(2);
  });

  it('measures the window from the start of the proof, not its completion', async () => {
    let now = 0;
    const cache = new AuthorityProofCache(5_000, () => now);
    const gate = deferred();
    const prove = vi.fn(() => gate.promise);
    const first = cache.run('effect:c1', prove);
    now = 4_000; // slow proof under load
    gate.resolve();
    await first;
    now = 5_001;
    await cache.run(
      'effect:c1',
      vi.fn(async () => {}),
    );
    expect(prove).toHaveBeenCalledTimes(1);
    const again = vi.fn(async () => {});
    await cache.run('effect:c1', again);
    expect(again).toHaveBeenCalledTimes(0); // reused the proof started at 5_001
  });

  it('never caches a failure: every waiter is refused and the next caller proves again', async () => {
    const cache = new AuthorityProofCache(5_000, () => 0);
    const gate = deferred();
    const failing = vi.fn(() => gate.promise);
    const waiters = [cache.run('effect:c1', failing), cache.run('effect:c1', failing)];
    gate.reject(new Error('Workspace unavailable'));
    for (const waiter of waiters) await expect(waiter).rejects.toThrow('Workspace unavailable');
    expect(failing).toHaveBeenCalledTimes(1);

    const refused = vi.fn(async () => {
      throw new Error('Credential revoked');
    });
    await expect(cache.run('effect:c1', refused)).rejects.toThrow('Credential revoked');
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('refuses a synchronous throw from the proof without retaining it', async () => {
    const cache = new AuthorityProofCache(5_000, () => 0);
    await expect(
      cache.run('effect:c1', () => {
        throw new Error('Owner changed');
      }),
    ).rejects.toThrow('Owner changed');
    const prove = vi.fn(async () => {});
    await cache.run('effect:c1', prove);
    expect(prove).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a proof across commands or between effect and idle authority', async () => {
    const cache = new AuthorityProofCache(5_000, () => 0);
    const prove = vi.fn(async () => {});
    await cache.run('effect:c1', prove);
    await cache.run('effect:c2', prove);
    await cache.run('idle:c2', prove);
    expect(prove).toHaveBeenCalledTimes(3);
  });

  it('forgets a retained proof when invalidated', async () => {
    const cache = new AuthorityProofCache(5_000, () => 0);
    const prove = vi.fn(async () => {});
    await cache.run('effect:c1', prove);
    cache.invalidate();
    await cache.run('effect:c1', prove);
    expect(prove).toHaveBeenCalledTimes(2);
  });
});
