import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { SpawnOptions } from 'node:child_process';
import type { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { PassThrough } from 'node:stream';
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
    wrapWithSandbox: vi
      .fn<typeof SandboxManager.wrapWithSandbox>()
      .mockResolvedValue('wrapped command'),
    reset: vi.fn(async () => {}),
  };
  const spawn = vi.fn<
    (command: string, args: readonly string[], options: SpawnOptions) => EventEmitter
  >(() => {
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

it('transfers target environment over a pipe only after the OS sandbox, never through arguments or bootstrap', async () => {
  const { payload, manager, spawn } = fixture();
  const transfer = new PassThrough();
  const chunks: Buffer[] = [];
  transfer.on('data', (data) => chunks.push(data));
  spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdio: [null, null, null, transfer] });
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  });
  payload.env = { LD_PRELOAD: '/untrusted/preload.so', PATH: '/untrusted/bin', VALUE: "a'b" };
  expect(await runSandboxedWorker(payload, { manager, spawn: spawn as never })).toBe(0);
  const wrappedCommand = manager.wrapWithSandbox.mock.calls[0][0];
  expect(wrappedCommand).toContain('fd: 3');
  expect(wrappedCommand).not.toContain('/untrusted');
  expect(manager.wrapWithSandbox.mock.calls[0][4]).toMatchObject({ commandId: expect.any(String) });
  expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({
    command: payload.command,
    env: payload.env,
  });
  expect(spawn.mock.calls[0][2].env).toBe(process.env);
});

it('uses a filesystem-only OS wrapper without initializing network proxies and preserves target environment transfer', async () => {
  const { payload, manager, spawn } = fixture();
  payload.filesystemOnly = true;
  payload.env = {
    AUTH_SECRET: 'synthetic project secret',
    CUSTOM_MCP_TOKEN: 'synthetic MCP token',
  };
  const transfer = new PassThrough();
  const chunks: Buffer[] = [];
  transfer.on('data', (data) => chunks.push(data));
  spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdio: [null, null, null, transfer] });
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  });
  const wrapFilesystem = vi.fn().mockResolvedValue('filesystem-only command');
  expect(
    await runSandboxedWorker(payload, {
      manager,
      spawn: spawn as never,
      platform: 'darwin',
      wrapFilesystem,
    }),
  ).toBe(0);
  expect(manager.initialize).not.toHaveBeenCalled();
  expect(manager.wrapWithSandbox).not.toHaveBeenCalled();
  expect(wrapFilesystem).toHaveBeenCalledWith(expect.stringContaining('fd: 3'), payload.config);
  expect(spawn.mock.calls[0][1]).toEqual(['-c', 'filesystem-only command']);
  expect(JSON.parse(Buffer.concat(chunks).toString()).env).toEqual(payload.env);
});

it('rejects malformed filesystem-only mode and unsupported platforms before executing a child', async () => {
  const { payload, manager, spawn } = fixture();
  payload.filesystemOnly = 'true' as never;
  await expect(runSandboxedWorker(payload, { manager, spawn: spawn as never })).rejects.toThrow(
    /filesystem-only/,
  );
  payload.filesystemOnly = true;
  await expect(
    runSandboxedWorker(payload, { manager, spawn: spawn as never, platform: 'linux' }),
  ).rejects.toThrow(/macOS/);
  expect(manager.initialize).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});

it('rechecks filesystem-only authority after wrapper preparation and before child spawn', async () => {
  const { payload, manager, spawn } = fixture();
  payload.filesystemOnly = true;
  const wrapFilesystem = vi.fn(async () => {
    renameSync(root, root + '-old');
    mkdirSync(root);
    return 'filesystem-only command';
  });
  await expect(
    runSandboxedWorker(payload, {
      manager,
      spawn: spawn as never,
      platform: 'darwin',
      wrapFilesystem,
    }),
  ).rejects.toThrow(/Sandbox authority changed/);
  expect(spawn).not.toHaveBeenCalled();
});

it('builds runtime-only policy with installed SRT unrestricted networking and the requested filesystem fence', async () => {
  const { payload, manager, spawn } = fixture();
  payload.filesystemOnly = true;
  const secret = join(root, 'operator.json');
  await writeFile(secret, 'synthetic metadata');
  payload.config.filesystem.denyRead = [secret];
  payload.config.filesystem.denyWrite = [secret];
  expect(
    await runSandboxedWorker(payload, { manager, spawn: spawn as never, platform: 'darwin' }),
  ).toBe(0);
  const command = spawn.mock.calls[0][1][1];
  expect(command).toContain('(allow network*)');
  expect(command).not.toContain('(deny network');
  expect(command).toContain('(global-name-prefix "")');
  expect(command).toContain('(allow appleevent-send)');
  expect(command).toContain(secret);
  expect(manager.initialize).not.toHaveBeenCalled();
});
