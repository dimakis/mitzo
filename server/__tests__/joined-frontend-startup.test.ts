import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';

const pending = vi.hoisted(() => ({
  transformRequest: vi.fn(),
  waitForRequestsIdle: vi.fn(),
  close: vi.fn(async () => {}),
}));
vi.mock('vite', () => ({
  createServer: async () => ({
    ...pending,
    middlewares: (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));
vi.mock('node:http', () => ({
  createServer: () => ({
    once: () => {},
    listen: (_port: number, _host: string, done: () => void) => done(),
    address: () => ({ port: 43123 }),
    close: (done: () => void) => done(),
  }),
}));
vi.mock('@vitejs/plugin-react', () => ({ default: () => ({}) }));
vi.mock('@playwright/test', () => ({ chromium: {} }));
import { createJoinedFrontend } from '../../tests/integration/telos-s9/integrated-candidate/joined-browser-target';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.clearAllMocks();
});

it('withholds the browser target until the entry and lazy chat graph are transformed and idle', async () => {
  let releaseTransforms!: () => void;
  let releaseIdle!: () => void;
  const transforms = new Promise<void>((resolve) => {
    releaseTransforms = resolve;
  });
  const idle = new Promise<void>((resolve) => {
    releaseIdle = resolve;
  });
  pending.transformRequest.mockReturnValue(transforms);
  pending.waitForRequestsIdle.mockReturnValue(idle);
  let returned = false;
  const started = createJoinedFrontend(express(), '/private/tmp/joined-startup-unit').then(
    (target) => {
      cleanup.push(() => target.close());
      returned = true;
      return target;
    },
  );
  await vi.waitFor(() => expect(pending.transformRequest).toHaveBeenCalledTimes(2));
  expect(pending.transformRequest.mock.calls.map(([url]) => url)).toEqual([
    '/src/main.tsx',
    '/src/components/ResponsiveChatView.tsx',
  ]);
  expect(returned).toBe(false);
  expect(pending.waitForRequestsIdle).not.toHaveBeenCalled();
  releaseTransforms();
  await vi.waitFor(() => expect(pending.waitForRequestsIdle).toHaveBeenCalledOnce());
  expect(returned).toBe(false);
  releaseIdle();
  await started;
  expect(returned).toBe(true);
});

it('rejects a startup transform error instead of returning a superficially ready target', async () => {
  pending.transformRequest.mockRejectedValue(Error('chat transform failed'));
  pending.waitForRequestsIdle.mockResolvedValue(undefined);
  const started = createJoinedFrontend(express(), '/private/tmp/joined-startup-unit');
  // Retain cleanup even if the uncorrected implementation unexpectedly opens a listener.
  void started.then(
    (target) => cleanup.push(() => target.close()),
    () => {},
  );
  await expect(started).rejects.toThrow('chat transform failed');
});
