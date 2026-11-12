import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { observePrivateHelperBoundary } from './fixtures/private-helper-boundary-diagnostics.js';
import { executePrivateNativeFileHelper } from '../sandboxed-command.js';
const diagnostics = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
const cleanup = vi.hoisted(() => ({ failure: undefined as unknown, attempted: 0 }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
      await actual.rm(...args);
      if (basename(String(args[0])).startsWith('mitzo-shell-')) {
        cleanup.attempted++;
        if (cleanup.failure !== undefined) throw cleanup.failure;
      }
    }),
  };
});
vi.mock('../logger.js', () => ({ createLogger: () => diagnostics }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
let root: string;
beforeEach(async () => {
  vi.clearAllMocks();
  cleanup.failure = undefined;
  cleanup.attempted = 0;
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
  expect(checks).toBe(2);
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
    if (++checks === 1) await new Promise((resolve) => setTimeout(resolve, 160));
  };
  await expect(executePrivateNativeFileHelper(input)).rejects.toThrow();
  expect(spawn).not.toHaveBeenCalled();
  expect(checks).toBe(2);
});

it.each(['current', 'expired', 'revoked', 'scope-revoked'] as const)(
  'joins an exit-zero worker and preserves the post-worker %s owner gate',
  async (mode) => {
    let now = Date.now();
    const input = await fixture(now + 30_000);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let checks = 0;
    let joined = false;
    input.assertCurrentSync = function () {
      expect(this).toBe(input);
      if (joined && mode === 'scope-revoked') throw Error('Original scope revoked');
    };
    input.revalidate = async function () {
      expect(this).toBe(input);
      checks++;
      // Account for a slow but valid physical proof without rebasing the30s
      // helper window. A duplicate setup proof would exhaust it.
      now += 10_000;
      if (joined) {
        if (mode === 'expired') now = input.deadline + 1;
        if (mode === 'revoked') throw Error('synthetic owner revoked');
      }
    };
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        pid: 12345678,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      setImmediate(() => {
        child.stdout.end('synthetic bounded output');
        child.stderr.end();
        joined = true;
        child.emit('close', 0, null);
      });
      return child as unknown as ReturnType<typeof spawn>;
    });
    const rows: unknown[] = [];
    const running = observePrivateHelperBoundary(input, executePrivateNativeFileHelper, rows);
    if (mode === 'current') await expect(running).resolves.toBeDefined();
    else await expect(running).rejects.toThrow('Private native file helper unavailable');
    expect(checks).toBe(mode === 'scope-revoked' ? 1 : 2);
    expect(joined).toBe(true);
    const report = rows[0] as {
      remainingMs: number;
      gates: Array<{ kind: string; status: string }>;
    };
    expect(report.gates.filter((gate) => gate.kind === 'async').map((gate) => gate.status)).toEqual(
      mode === 'scope-revoked'
        ? ['returned']
        : ['returned', mode === 'revoked' ? 'rejected' : 'returned'],
    );
    expect(report.remainingMs > 0).toBe(mode !== 'expired');
  },
);

it.each(['expired', 'revoked', 'execution', 'execution-and-revocation'] as const)(
  'retains the original %s failure and a sanitized helper-stage diagnostic',
  async (mode) => {
    let now = Date.now();
    const input = await fixture(now + 30_000);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const executionFailure = Error('synthetic private worker details');
    const ownerFailure = Error('synthetic private account details');
    let joined = false;
    let checks = 0;
    input.revalidate = async () => {
      checks++;
      if (!joined) return;
      if (mode === 'expired') now = input.deadline + 1;
      else if (mode !== 'execution') throw ownerFailure;
    };
    vi.mocked(spawn).mockImplementation(() => {
      if (mode === 'execution' || mode === 'execution-and-revocation') {
        joined = true;
        throw executionFailure;
      }
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      setImmediate(() => {
        joined = true;
        child.emit('close', 0, null);
      });
      return child as unknown as ReturnType<typeof spawn>;
    });
    let failure: unknown;
    try {
      await executePrivateNativeFileHelper(input);
    } catch (error) {
      failure = error;
    }
    expect(checks).toBe(2);
    expect(failure).toMatchObject({
      message: 'Private native file helper unavailable',
      code: 'private_native_file_helper_unavailable',
      stage: mode === 'execution' ? 'execution' : 'post_result',
      cause:
        mode === 'expired'
          ? { code: 'private_helper_deadline_exceeded' }
          : mode === 'revoked'
            ? ownerFailure
            : executionFailure,
    });
    if (mode === 'execution-and-revocation')
      expect(failure).toHaveProperty('postResultCause', ownerFailure);
    expect(diagnostics.warn).toHaveBeenLastCalledWith('Private native file helper failed', {
      code: 'private_native_file_helper_unavailable',
      stage: mode === 'execution' ? 'execution' : 'post_result',
      operation: 'CreateFile',
      deadlineExceeded: mode === 'expired',
    });
    expect(JSON.stringify(diagnostics.warn.mock.calls)).not.toContain('synthetic private');
  },
);

it('retains and reports a rejected asynchronous synchronous-owner callback', async () => {
  const input = await fixture(Date.now() + 30_000);
  const original = Error('synthetic private async-owner failure');
  input.assertCurrentSync = async () => {
    throw original;
  };
  await expect(executePrivateNativeFileHelper(input)).rejects.toMatchObject({ cause: original });
  expect(spawn).not.toHaveBeenCalled();
  expect(diagnostics.warn).toHaveBeenCalledWith('Private helper synchronous owner rejected', {
    code: 'private_helper_async_owner_rejected',
    stage: 'synchronous_owner',
  });
  expect(JSON.stringify(diagnostics.warn.mock.calls)).not.toContain('synthetic private');
});

it.each(['execution', 'execution-and-revocation', 'cleanup-only', 'undefined', 'frozen'] as const)(
  'retains %s causes through runner cleanup and still refreshes the original owner',
  async (mode) => {
    const input = await fixture(Date.now() + 30_000);
    const original =
      mode === 'undefined'
        ? undefined
        : mode === 'frozen'
          ? Object.freeze(Error('synthetic private execution details'))
          : Error('synthetic private execution details');
    const cleanupFailure = Error('synthetic private cleanup details');
    const ownerFailure = Error('synthetic private revocation details');
    cleanup.failure = cleanupFailure;
    let checks = 0;
    input.revalidate = async () => {
      if (++checks === 2 && mode === 'execution-and-revocation') throw ownerFailure;
    };
    vi.mocked(spawn).mockImplementation(() => {
      if (mode !== 'cleanup-only') throw original;
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      setImmediate(() => child.emit('close', 0, null));
      return child as unknown as ReturnType<typeof spawn>;
    });
    let failure: unknown;
    try {
      await executePrivateNativeFileHelper(input);
    } catch (error) {
      failure = error;
    }
    expect(cleanup.attempted).toBe(1);
    expect(checks).toBe(2);
    expect(failure).toMatchObject({
      code: 'private_native_file_helper_unavailable',
      cause: {
        code: 'operation_finalization_failed',
        cause: mode === 'cleanup-only' ? cleanupFailure : original,
        errors: mode === 'cleanup-only' ? [cleanupFailure] : [original, cleanupFailure],
      },
    });
    if (mode === 'execution-and-revocation')
      expect(failure).toHaveProperty('postResultCause', ownerFailure);
    expect(diagnostics.warn).toHaveBeenCalledWith('Operation finalization failed', {
      code: 'operation_finalization_failed',
      stage: 'sandbox_command',
      operationFailed: mode !== 'cleanup-only',
      failureCount: 1,
    });
    expect(JSON.stringify(diagnostics.warn.mock.calls)).not.toContain('synthetic private');
  },
);
