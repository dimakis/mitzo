import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from '../codex-app-server-client.js';
afterEach(() => vi.useRealTimers());
function child() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
}
async function renewed() {
  vi.useFakeTimers();
  const original = child(),
    replacement = child(),
    create = vi.fn(() => replacement);
  const client = new CodexAppServerClient(original, { environmentLaunch: { create } });
  original.emit('exit', 78);
  await vi.advanceTimersByTimeAsync(10000);
  expect(create).toHaveBeenCalledOnce();
  return { original, replacement, client };
}
it('does not confirm a live replacement from the original retired transport close', async () => {
  const f = await renewed();
  f.original.emit('close', 78, null);
  const pending = f.client.closeAndConfirm(20);
  await vi.advanceTimersByTimeAsync(20);
  await expect(pending).resolves.toEqual({ state: 'uncertain', resource: 'owned-process' });
  expect(f.replacement.kill).toHaveBeenCalledOnce();
  f.replacement.emit('close', 0, 'SIGTERM');
  await expect(f.client.closeAndConfirm(20)).resolves.toEqual({
    state: 'confirmed',
    resource: 'owned-process',
    code: 0,
    signal: 'SIGTERM',
  });
});
it('retains uncertainty while any captured retired transport still has open stdio', async () => {
  const f = await renewed();
  f.replacement.emit('close', 0, 'SIGTERM');
  const pending = f.client.closeAndConfirm(20);
  await vi.advanceTimersByTimeAsync(20);
  await expect(pending).resolves.toEqual({ state: 'uncertain', resource: 'owned-process' });
  expect(f.replacement.kill).not.toHaveBeenCalled();
  f.original.emit('close', 78, null);
  await expect(f.client.closeAndConfirm(20)).resolves.toEqual({
    state: 'confirmed',
    resource: 'owned-process',
    code: 0,
    signal: 'SIGTERM',
  });
});
