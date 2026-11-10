import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { spawn } from 'node:child_process';
import { executeSandboxedCommand } from '../sandboxed-command.js';
import type { SandboxWorkerPayload } from '../sandboxed-command-worker.js';
import { callbackOutcome } from '../turn-callbacks.js';

const terminationLog = vi.hoisted(() => vi.fn());
vi.mock('../logger.js', () => ({
  createLogger: (name: string) => ({
    info: name === 'sandboxed-command' ? terminationLog : vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

it.each([
  [1, null, 'settled'],
  [128, null, 'settled'],
  [129, null, 'unknown'],
  [137, null, 'unknown'],
  [255, null, 'unknown'],
  [null, 'SIGKILL', 'unknown'],
] as const)(
  'retains process termination facts for exit %s, signal %s',
  async (code, signal, outcome) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-command-outcome-')));
    vi.spyOn(SandboxManager, 'checkDependencies').mockReturnValue({ errors: [], warnings: [] });
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      setImmediate(() => child.emit('close', code, signal));
      return child as unknown as ReturnType<typeof spawn>;
    });
    try {
      const result = await executeSandboxedCommand({
        command: 'exit 1',
        cwd: root,
        writableRoots: [root],
        deniedRoots: [],
        env: { PATH: '/usr/bin:/bin' },
        signal: new AbortController().signal,
      });
      expect(result.isError).toBe(true);
      expect(callbackOutcome(result)).toBe(outcome);
      expect(terminationLog).toHaveBeenLastCalledWith('Sandbox command terminated', {
        exitCode: code,
        exitSignal: signal,
        effectOutcome: outcome,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([undefined, 'loopback', 'approved-command'] as const)(
  'passes only server-approved networking to the isolated worker (%s)',
  async (networkAccess) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-command-network-')));
    const cwd = join(root, 'workspace');
    await mkdir(cwd);
    let payload: SandboxWorkerPayload | undefined;
    let childEnvironment: NodeJS.ProcessEnv | undefined;
    vi.spyOn(SandboxManager, 'checkDependencies').mockReturnValue({ errors: [], warnings: [] });
    vi.mocked(spawn).mockImplementation((_command, args, options) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      childEnvironment = options?.env;
      void readFile(args![args!.length - 1], 'utf8').then((bytes) => {
        payload = JSON.parse(bytes);
        child.emit('close', 0, null);
      });
      return child as unknown as ReturnType<typeof spawn>;
    });
    try {
      expect(
        await executeSandboxedCommand({
          command: 'npm install',
          cwd,
          writableRoots: [cwd],
          deniedRoots: [join(root, 'credentials')],
          env: { PATH: '/usr/bin:/bin', OPENAI_API_KEY: 'synthetic-secret' },
          networkAccess,
          signal: new AbortController().signal,
        }),
      ).toEqual({ content: '', isError: false });
      expect(payload?.networkAccess).toBe(networkAccess);
      expect(payload?.config.network.allowedDomains).toEqual(
        networkAccess === 'loopback' ? ['localhost', '127.0.0.1', '[::1]'] : [],
      );
      expect(payload?.config.network.deniedDomains).toContain('169.254.169.254');
      expect(payload?.config.network.allowAllUnixSockets).toBe(false);
      expect(payload?.config.network.allowLocalBinding).toBe(networkAccess !== undefined);
      expect(payload?.config.filesystem.allowWrite).toContain(cwd);
      expect(payload?.filesystemOnly).toBeUndefined();
      expect(childEnvironment?.OPENAI_API_KEY).toBeUndefined();
      expect(JSON.stringify(payload)).not.toContain('synthetic-secret');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
