import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { observeOrdinarySdkProcessClose } from '../ordinary-local-vertex-sdk-process.js';
import type { ProtectedSdkProcess } from '../credential-sdk-boundary.js';
it('waits for observed close even after exit rather than assuming SDK shutdown', async () => {
  const process = new EventEmitter();
  const observed = observeOrdinarySdkProcessClose(process as unknown as ProtectedSdkProcess);
  let settled = false;
  const wait = observed.wait(new AbortController().signal, 100).then(() => {
    settled = true;
  });
  process.emit('exit', 0, null);
  await Promise.resolve();
  expect(settled).toBe(false);
  process.emit('close', 0, null);
  await wait;
  expect(settled).toBe(true);
  await expect(observed.wait(new AbortController().signal, 10)).resolves.toBeUndefined();
});
it('refuses missing close or cancellation without killing the original process or assuming it died', async () => {
  const process = Object.assign(new EventEmitter(), { kill: vi.fn() });
  const observed = observeOrdinarySdkProcessClose(process as unknown as ProtectedSdkProcess);
  await expect(observed.wait(new AbortController().signal, 5)).rejects.toThrow(
    'Original SDK process closure unavailable',
  );
  expect(process.kill).not.toHaveBeenCalled();
  const controller = new AbortController();
  const wait = observed.wait(controller.signal, 100);
  controller.abort();
  await expect(wait).rejects.toThrow();
  expect(process.kill).not.toHaveBeenCalled();
});
