import { expect, it, vi } from 'vitest';
import { createSymposiumShutdown } from '../symposium-shutdown.js';
it('fences synchronously, drains before closing, and shares repeated shutdown', async () => {
  const events: string[] = [];
  let release!: () => void;
  const waiting = new Promise<void>((r) => {
    release = r;
  });
  const shutdown = createSymposiumShutdown({
    fence: () => {
      events.push('fence');
    },
    drain: async () => {
      events.push('drain');
      await waiting;
    },
    close: async () => {
      events.push('close');
    },
    uncertain: () => {
      events.push('uncertain');
    },
  });
  const first = shutdown();
  expect(events).toEqual(['fence', 'drain']);
  expect(shutdown()).toBe(first);
  release();
  await first;
  expect(events).toEqual(['fence', 'drain', 'close']);
});
it('preserves uncertainty and never closes stores after partial cleanup failure', async () => {
  const close = vi.fn();
  const uncertain = vi.fn();
  const shutdown = createSymposiumShutdown({
    fence: () => {},
    drain: async () => {
      throw Error('partial');
    },
    close,
    uncertain,
  });
  await expect(shutdown()).rejects.toThrow();
  expect(uncertain).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
});
it('aborts timeout and never closes after a delayed drain resolves', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  let signal!: AbortSignal;
  const close = vi.fn();
  const uncertain = vi.fn();
  const shutdown = createSymposiumShutdown(
    {
      fence: () => {},
      drain: async (s) => {
        signal = s;
        await new Promise<void>((r) => {
          release = r;
        });
      },
      close,
      uncertain,
    },
    50,
  );
  const result = expect(shutdown()).rejects.toThrow('incomplete');
  await vi.advanceTimersByTimeAsync(50);
  await result;
  expect(signal.aborted).toBe(true);
  release();
  await Promise.resolve();
  expect(close).not.toHaveBeenCalled();
  expect(uncertain).toHaveBeenCalledOnce();
  vi.useRealTimers();
});

it('waits for independent cleanup after a sibling fails before reporting failure', async () => {
  const { settleSymposiumCleanup } = await import('../symposium-shutdown.js');
  let finish!: () => void;
  let reported = false;
  const result = settleSymposiumCleanup([
    Promise.reject(new Error('seat failed')),
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  ]).catch(() => {
    reported = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(reported).toBe(false);
  finish();
  await result;
  expect(reported).toBe(true);
});
