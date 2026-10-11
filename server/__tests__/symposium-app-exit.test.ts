import { afterEach, expect, it, vi } from 'vitest';
import { finishAppShutdown } from '../symposium-app-exit.js';
import { waitOriginalControllerExit } from '../symposium-custodian-exit.js';
import { SHUTDOWN_GRACE_MS } from '../constants.js';
import { once } from 'node:events';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('lets the original canonical parent observe app exit after cleanup, within its existing deadline', async () => {
  vi.useFakeTimers();
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const events: string[] = [];
  const child = {
    exitCode: null as number | null,
    signalCode: null,
    kill: vi.fn(() => {
      // The child handles its signal after the parent starts its deadline.
      setTimeout(() => {
        void finishAppShutdown(
          true,
          async () => {
            events.push('cleanup');
            await new Promise<void>((resolve) => setTimeout(resolve, 250));
            events.push('cleaned');
          },
          () => {
            child.exitCode = 0;
            events.push('exit');
            resolveExit();
          },
        );
      }, 25);
      return true;
    }),
  };
  const result = waitOriginalControllerExit(child, exited, true).then(
    () => ({ exited: true }),
    (error: unknown) => ({ exited: false, error }),
  );
  await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS + 300);
  expect(await result).toEqual({ exited: true });
  expect(events).toEqual(['cleanup', 'cleaned', 'exit']);
  expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
  expect(vi.getTimerCount()).toBe(0);
});

it('observes graceful exit from an actual isolated app fixture without a provider or forced signal', async () => {
  const { fork } = await import('node:child_process');
  const child = fork(new URL('./fixtures/symposium-app-exit-child.mjs', import.meta.url), [], {
    execArgv: ['--import', 'tsx'],
    env: { PATH: process.env.PATH, NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const exited = once(child, 'exit').then(() => {});
  const kill = vi.spyOn(child, 'kill');
  try {
    await once(child, 'message', { signal: AbortSignal.timeout(5000) });
    await waitOriginalControllerExit(child, exited, true);
    expect(child.exitCode).toBe(0);
    expect(kill.mock.calls).toEqual([['SIGTERM']]);
  } finally {
    // Sole test-created process; no canonical service or native owner is used.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
}, 10_000);

it('keeps standalone app grace after all cleanup settles', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  const exit = vi.fn();
  const finished = finishAppShutdown(false, () => cleanup, exit);
  await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS + 1);
  expect(exit).not.toHaveBeenCalled();
  release();
  await finished;
  await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS - 1);
  expect(exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(exit).toHaveBeenCalledOnce();
});

it('does not schedule a successful app exit after cleanup fails', async () => {
  vi.useFakeTimers();
  const exit = vi.fn();
  await expect(
    finishAppShutdown(
      true,
      async () => {
        throw Error('cleanup failed');
      },
      exit,
    ),
  ).rejects.toThrow('cleanup failed');
  await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS + 1);
  expect(exit).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
