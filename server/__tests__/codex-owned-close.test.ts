import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { CodexAppServerClient } from '../codex-app-server-client.js';
vi.mock('../application-version.js', () => ({ applicationVersion: 'offline-test' }));
function child() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
}
it('confirms only the original child close event, after normal owned shutdown', async () => {
  const original = child();
  const client = new CodexAppServerClient(original);
  const closed = client.closeAndConfirm(100);
  expect(original.kill).toHaveBeenCalledOnce();
  original.emit('exit', 0);
  let settled = false;
  void closed.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  original.emit('close', 0, null);
  await expect(closed).resolves.toEqual({
    state: 'confirmed',
    resource: 'owned-process',
    code: 0,
    signal: null,
  });
  await expect(client.closeAndConfirm(100)).resolves.toEqual({
    state: 'confirmed',
    resource: 'owned-process',
    code: 0,
    signal: null,
  });
  expect(original.kill).toHaveBeenCalledOnce();
});
it('timeout retains uncertainty without another signal or discovered PID control', async () => {
  const original = child();
  const client = new CodexAppServerClient(original);
  await expect(client.closeAndConfirm(1)).resolves.toEqual({
    state: 'uncertain',
    resource: 'owned-process',
  });
  expect(original.kill).toHaveBeenCalledOnce();
  original.emit('close', null, 'SIGTERM');
  await expect(client.closeAndConfirm(100)).resolves.toEqual({
    state: 'confirmed',
    resource: 'owned-process',
    code: null,
    signal: 'SIGTERM',
  });
});
it('a preexisting original close is retained, while a transport error alone is not proof', async () => {
  const original = child();
  const client = new CodexAppServerClient(original);
  original.emit('error', new Error('private diagnostic'));
  await expect(client.closeAndConfirm(1)).resolves.toMatchObject({ state: 'uncertain' });
  original.emit('close', 1, null);
  await expect(client.closeAndConfirm(100)).resolves.toMatchObject({ state: 'confirmed', code: 1 });
});
