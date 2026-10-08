import type { Worker, MessagePort, WorkerOptions } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createOwnedEvidenceCollector } from '../symposium-owned-evidence-async.js';
const selection = {
  providerInstances: [{ name: 'work', id: 'original', type: 'openai', profileName: 'openai' }],
  allowedRoles: ['coder'],
  allowedAccountProviders: ['openai'],
  artifactVolume: { driver: 'podman', name: 'original' },
};
function fixture(spawn: NonNullable<Parameters<typeof createOwnedEvidenceCollector>[4]>) {
  const custody = {
    verifyCustodyAsync: vi.fn(async () => {}),
    verifyOwnedNativeHostAsync: vi.fn(async () => {}),
    verifyGatewayDriverConfigAsync: vi.fn(async () => {}),
  };
  return {
    custody,
    collect: createOwnedEvidenceCollector(
      { cli: '/no-cli', gateway: 'original', workspace: 'original' } as never,
      'https://original.invalid',
      {} as never,
      custody,
      spawn,
    ),
  };
}
it('refuses a request lost during initial custody await before spawning any worker', async () => {
  const spawn = vi.fn();
  const f = fixture(spawn);
  let current = true;
  f.custody.verifyCustodyAsync.mockImplementationOnce(async () => {
    current = false;
  });
  await expect(
    f.collect(selection, () => {
      if (!current) throw Error('revoked');
    }),
  ).rejects.toThrow('revoked');
  expect(spawn).not.toHaveBeenCalled();
});
it('permanently vetoes favorable candidate after authority loss around an actual custody RPC', async () => {
  let current = true;
  let reply: unknown;
  const spawn = vi.fn((_source: string, options: WorkerOptions) => {
    const worker = new EventEmitter();
    const port = (options.workerData as { custodyPort: MessagePort }).custodyPort;
    port.once('message', (value: unknown) => {
      reply = value;
      current = true;
      worker.emit('message', { candidate: { synthetic: true } });
      worker.emit('exit', 0);
    });
    setImmediate(() => port.postMessage({ method: 'native', args: [{ original: true }] }));
    return worker as Worker;
  });
  const f = fixture(spawn);
  f.custody.verifyOwnedNativeHostAsync.mockImplementationOnce(async () => {
    current = false;
  });
  await expect(
    f.collect(selection, () => {
      if (!current) throw Error('revoked');
    }),
  ).rejects.toThrow('retained custody');
  expect(reply).toEqual({ ok: false });
  expect(spawn).toHaveBeenCalledOnce();
  expect(f.custody.verifyCustodyAsync).toHaveBeenCalledOnce();
});
