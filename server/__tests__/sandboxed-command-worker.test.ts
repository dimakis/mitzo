import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { AuthoritySnapshot } from '../sandbox-authority.js';
import { runSandboxedWorker, type SandboxWorkerPayload } from '../sandboxed-command-worker.js';

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-worker-test-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(root + '-old', { recursive: true, force: true });
});

function fixture() {
  const authority = new AuthoritySnapshot();
  authority.capture(root);
  const payload: SandboxWorkerPayload = {
    cwd: root,
    command: 'true',
    authority: JSON.parse(JSON.stringify(authority.serialize())),
    config: {
      filesystem: { denyRead: [], allowRead: [], allowWrite: [root], denyWrite: [] },
      network: { allowedDomains: [], deniedDomains: [] },
    },
  };
  const manager = {
    checkDependencies: vi.fn(() => ({ errors: [], warnings: [] })),
    initialize: vi.fn(async () => {}),
    wrapWithSandbox: vi.fn(async () => 'wrapped command'),
    reset: vi.fn(async () => {}),
  };
  const spawn = vi.fn(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  });
  return { payload, manager, spawn };
}

it('rejects replacement during SRT initialization before constructing the sandbox', async () => {
  const { payload, manager, spawn } = fixture();
  let finish!: () => void;
  manager.initialize.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const result = runSandboxedWorker(payload, { manager, spawn: spawn as never });
  renameSync(root, root + '-old');
  mkdirSync(root);
  finish();
  await expect(result).rejects.toThrow(/Sandbox authority changed/);
  expect(manager.wrapWithSandbox).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect(manager.reset).toHaveBeenCalledOnce();
});

it('revalidates Git authority after asynchronous sandbox construction before inner spawn', async () => {
  const { payload, manager, spawn } = fixture();
  const marker = join(root, '.git');
  await writeFile(marker, 'gitdir: /original');
  const authority = new AuthoritySnapshot();
  authority.capture(root);
  authority.capture(marker, true);
  payload.authority = JSON.parse(JSON.stringify(authority.serialize()));
  let finish!: (command: string) => void;
  manager.wrapWithSandbox.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const result = runSandboxedWorker(payload, { manager, spawn: spawn as never });
  await vi.waitFor(() => expect(manager.wrapWithSandbox).toHaveBeenCalled());
  writeFileSync(marker, 'gitdir: /replacement');
  finish('wrapped command');
  await expect(result).rejects.toThrow(/Sandbox authority changed/);
  expect(spawn).not.toHaveBeenCalled();
  expect(manager.reset).toHaveBeenCalledOnce();
});

it('spawns the wrapped command in the worker process group only after validation', async () => {
  const { payload, manager, spawn } = fixture();
  expect(await runSandboxedWorker(payload, { manager, spawn: spawn as never })).toBe(0);
  expect(spawn).toHaveBeenCalledWith(
    '/bin/sh',
    ['-c', 'wrapped command'],
    expect.objectContaining({ cwd: root, detached: false, stdio: 'inherit' }),
  );
  expect(manager.reset).toHaveBeenCalledOnce();
});
