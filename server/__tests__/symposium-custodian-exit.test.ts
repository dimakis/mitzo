import { afterEach, expect, it, vi } from 'vitest';
import { waitOriginalControllerExit } from '../symposium-custodian-exit.js';
afterEach(() => vi.useRealTimers());
it('keeps a hung canonical app child alive and refuses a confirmed exit without force', async () => {
  vi.useFakeTimers();
  const child = { exitCode: null, signalCode: null, kill: vi.fn(() => true) };
  const result = waitOriginalControllerExit(child, new Promise<void>(() => {}), true);
  const assertion = expect(result).rejects.toThrow(/uncertain/i);
  await vi.advanceTimersByTimeAsync(5000);
  await assertion;
  expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
});
it('accepts a graceful canonical exit and cancels the deadline', async () => {
  vi.useFakeTimers();
  const child = { exitCode: null, signalCode: null, kill: vi.fn(() => true) };
  await waitOriginalControllerExit(child, Promise.resolve(), true);
  await vi.advanceTimersByTimeAsync(6000);
  expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
});
it('preserves the existing noncanonical shutdown behavior', async () => {
  vi.useFakeTimers();
  let resolveExit!: () => void;
  const exited = new Promise<void>((r) => {
    resolveExit = r;
  });
  const child = {
    exitCode: null,
    signalCode: null,
    kill: vi.fn((signal: string) => {
      if (signal === 'SIGKILL') resolveExit();
      return true;
    }),
  };
  const result = waitOriginalControllerExit(child, exited, false);
  await vi.advanceTimersByTimeAsync(5000);
  await result;
  expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
});
