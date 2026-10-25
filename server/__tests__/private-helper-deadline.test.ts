import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { executePrivateNativeFileHelper } from '../sandboxed-command.js';
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
let root: string;
beforeEach(async () => {
  vi.clearAllMocks();
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-private-deadline-')));
  vi.spyOn(SandboxManager, 'checkDependencies').mockReturnValue({ errors: [], warnings: [] });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
async function fixture(deadline: number) {
  const cwd = join(root, 'owned'),
    parent = join(root, 'parent');
  await mkdir(cwd);
  await mkdir(parent);
  const payload = join(cwd, 'payload');
  await writeFile(payload, 'bytes');
  const id = async (path: string) => {
    const s = await lstat(path, { bigint: true });
    return { dev: String(s.dev), ino: String(s.ino) };
  };
  const scratch = { rootPath: cwd, identity: await id(cwd) },
    anchor = { rootPath: parent, identity: await id(parent) };
  const request = {
    operation: 'CreateFile',
    file_path: join(parent, 'target'),
    rootAnchor: anchor,
    parentIdentity: anchor.identity,
    expectedAbsent: true,
    deniedRoots: [],
    payload: {
      file_path: payload,
      rootAnchor: scratch,
      parentIdentity: scratch.identity,
      identity: await id(payload),
      size: 5,
      sha256: createHash('sha256').update('bytes').digest('hex'),
    },
    identity: null,
    limit: 1,
    timeoutMs: 30000,
  };
  return {
    requestJson: JSON.stringify(request),
    cwd,
    writableRoots: [
      { path: cwd, parentAnchor: scratch },
      { path: request.file_path, parentAnchor: anchor },
    ],
    deniedRoots: [],
    signal: new AbortController().signal,
    timeoutMs: 30000,
    maxOutputBytes: 32768,
    deadline,
    assertCurrentSync() {},
    async revalidate() {},
  };
}
it('refuses an exhausted original absolute expiry before owner/setup or spawn', async () => {
  const input = await fixture(Date.now() - 1),
    owner = vi.spyOn(input, 'revalidate');
  await expect(executePrivateNativeFileHelper(input)).rejects.toThrow();
  expect(owner).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});
it('narrows the real parent timer and joins a synthetic detached child without rebasing across gates', async () => {
  const input = await fixture(Date.now() + 350);
  const originalDeadline = input.deadline;
  let child: EventEmitter;
  let joined = false;
  let checks = 0;
  input.revalidate = async function () {
    expect(this).toBe(input);
    checks++;
  };
  vi.mocked(spawn).mockImplementation(() => {
    child = Object.assign(new EventEmitter(), {
      pid: 12345678,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    return child as ReturnType<typeof spawn>;
  });
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    expect(pid).toBe(-12345678);
    expect(signal).toBe('SIGKILL');
    if (!joined) {
      joined = true;
      queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
    }
    return true;
  });
  const timer = vi.spyOn(globalThis, 'setTimeout');
  await expect(executePrivateNativeFileHelper(input)).rejects.toThrow();
  expect(kill).toHaveBeenCalledTimes(2);
  expect(joined).toBe(true);
  expect(checks).toBe(3);
  const delays = timer.mock.calls
    .map((call) => call[1])
    .filter((n): n is number => typeof n === 'number');
  expect(delays).toHaveLength(1);
  expect(delays[0]).toBeGreaterThan(0);
  expect(delays[0]).toBeLessThanOrEqual(350);
  expect(Date.now()).toBeGreaterThanOrEqual(originalDeadline);
});
it('does not replace an earlier helper deadline with a later evidence expiry', async () => {
  const input = await fixture(Date.now() + 30000);
  input.timeoutMs = 120;
  let child: EventEmitter;
  vi.mocked(spawn).mockImplementation(() => {
    child = Object.assign(new EventEmitter(), {
      pid: 12345678,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    return child as ReturnType<typeof spawn>;
  });
  let joined = false;
  vi.spyOn(process, 'kill').mockImplementation(() => {
    if (!joined) {
      joined = true;
      queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
    }
    return true;
  });
  const timer = vi.spyOn(globalThis, 'setTimeout');
  await expect(executePrivateNativeFileHelper(input)).rejects.toThrow();
  expect(timer.mock.calls[0][1]).toBeLessThanOrEqual(120);
});
it('consumes the same deadline during the full pre-spawn gate and refuses before a worker exists', async () => {
  const input = await fixture(Date.now() + 120);
  let checks = 0;
  input.revalidate = async function () {
    expect(this).toBe(input);
    if (++checks === 2) await new Promise((resolve) => setTimeout(resolve, 160));
  };
  await expect(executePrivateNativeFileHelper(input)).rejects.toThrow();
  expect(spawn).not.toHaveBeenCalled();
  expect(checks).toBe(3);
});
