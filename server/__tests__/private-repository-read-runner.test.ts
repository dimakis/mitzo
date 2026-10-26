import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { executePrivateRepositoryObservation } from '../sandboxed-command.js';
import { privateRepositoryObservationCommand } from '../native-file-operation.js';
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());
it.skipIf(process.platform !== 'darwin')(
  'launches only the fixed repository reader in Seatbelt with all network denied and fresh owner checks',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-private-read-runner-')));
    try {
      const requestJson = JSON.stringify({
        operation: 'CaptureRepositoryObservation',
        repositoryPlan: {
          version: 'repository-read-v1',
          mode: 'orientation',
          sourcePath: root,
          readableRoots: ['/'],
          deniedRoots: [],
          excludedNames: [],
        },
        identity: null,
        file_path: root,
        limit: 1,
        timeoutMs: 1000,
      });
      const options = {
        requestJson,
        command: privateRepositoryObservationCommand(requestJson),
        cwd: root,
        writableRoots: [root],
        deniedRoots: [],
        env: { PATH: '/usr/bin:/bin' },
        signal: new AbortController().signal,
        timeoutMs: 1000,
        privateOutput: 'separate' as const,
        beforeSpawnAsync: vi.fn(async () => {}),
        beforeSpawn: vi.fn(() => {}),
      };
      vi.spyOn(SandboxManager, 'checkDependencies').mockReturnValue({ errors: [], warnings: [] });
      vi.mocked(spawn).mockImplementation((command, args, childOptions) => {
        expect(options.beforeSpawnAsync).toHaveBeenCalledOnce();
        expect(options.beforeSpawn).toHaveBeenCalledOnce();
        expect(command).toBe('/bin/sh');
        expect(args?.[0]).toBe('-c');
        const wrapped = args![1];
        expect(wrapped).toContain('/usr/bin/sandbox-exec');
        expect(wrapped).toContain('(deny default (with message ');
        expect(wrapped).not.toContain('(allow network');
        expect(wrapped).not.toContain('(allow system-socket (socket-domain AF_UNIX))');
        expect(childOptions?.env?.PATH).toBeDefined();
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        });
        queueMicrotask(() => child.emit('close', 0, null));
        return child as unknown as ReturnType<typeof spawn>;
      });
      expect(await executePrivateRepositoryObservation(options)).toMatchObject({ isError: false });
      expect(spawn).toHaveBeenCalledOnce();
      await expect(
        executePrivateRepositoryObservation({ ...options, command: 'ls' }),
      ).rejects.toThrow();
      await expect(
        executePrivateRepositoryObservation({ ...options, networkAccess: 'approved-command' }),
      ).rejects.toThrow();
      await expect(
        executePrivateRepositoryObservation({ ...options, writableRoots: [root, '/'] }),
      ).rejects.toThrow();
      expect(spawn).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
