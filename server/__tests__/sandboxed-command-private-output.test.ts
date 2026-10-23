import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { executeSandboxedCommand } from '../sandboxed-command.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
let root: string;
let cwd: string;
beforeEach(async () => {
  vi.clearAllMocks();
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-private-output-')));
  cwd = join(root, 'scratch');
  await mkdir(cwd);
  vi.spyOn(SandboxManager, 'checkDependencies').mockReturnValue({ errors: [], warnings: [] });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
function child(stdout: string, stderr: string, code = 0) {
  vi.mocked(spawn).mockImplementation(() => {
    const process = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    queueMicrotask(() => {
      process.stdout.write(stdout);
      process.stderr.write(stderr);
      process.emit('close', code, null);
    });
    return process as unknown as ReturnType<typeof spawn>;
  });
}
function run(extra: Partial<Parameters<typeof executeSandboxedCommand>[0]> = {}) {
  return executeSandboxedCommand({
    command: '/usr/bin/printf fixed',
    cwd,
    writableRoots: [cwd],
    deniedRoots: [join(root, 'denied')],
    signal: new AbortController().signal,
    env: {},
    ...extra,
  });
}
it('separates bounded structured stdout from interpreter warnings only for the private transport', async () => {
  child('{"is_error":false,"content":"ok"}\n', 'synthetic interpreter warning\n');
  const output = await run({ privateOutput: 'separate' });
  expect(output).toEqual({
    content: '',
    isError: false,
    stdout: '{"is_error":false,"content":"ok"}\n',
    stderr: 'synthetic interpreter warning\n',
  });
});
it('preserves the existing merged result shape and ordering by default', async () => {
  child('out', 'err');
  expect(await run()).toEqual({ content: 'outerr', isError: false });
});
it('counts both streams against the same output cap and never returns overflowing chunks', async () => {
  child('1234', '5678');
  expect(await run({ privateOutput: 'separate', maxOutputBytes: 6 })).toEqual({
    content: 'Command output limit exceeded',
    isError: true,
    stdout: '1234',
    stderr: '',
  });
});
it('retains actual process failure independently of structured stdout', async () => {
  child('{"is_error":false,"content":"ok"}', 'warning', 1);
  expect(await run({ privateOutput: 'separate' })).toMatchObject({ isError: true });
});
it('refuses an invalid private transport before any worker is spawned', async () => {
  child('unexpected', '');
  await expect(run({ privateOutput: 'invalid' as 'separate' })).rejects.toThrow();
  expect(spawn).not.toHaveBeenCalled();
});
