import { executeSandboxedCommand } from './sandboxed-command.js';
import { readOnlyGitExecutable } from './read-only-git.js';
import { createLogger } from './logger.js';
import { join } from 'node:path';
import type { SafeLocalWorktreeFilesystem } from './worktree.js';

const log = createLogger('sdk-secondary-repository-filesystem');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** These commands are controller-owned, not agent shell input. The kernel write
 * boundary remains in force throughout mkdir and every Git subprocess, including
 * checkout. An ancestor swap cannot redirect their writes outside approved roots. */
export function sdkSecondaryRepositoryFilesystem(options: {
  workspaceDirectory: string;
  commonDirectory: string;
  taskName: string;
  conversationId: string;
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
}): SafeLocalWorktreeFilesystem {
  if (!/^claude-[A-Za-z0-9-]+$/.test(options.taskName))
    throw new Error('Invalid Claude repository allocation identity');
  const branch = join('refs', 'heads', 'mitzo', options.taskName);
  const ref = join(options.commonDirectory, branch);
  const reflog = join(options.commonDirectory, 'logs', branch);
  const metadata = [
    join(options.commonDirectory, 'worktrees', options.taskName),
    ref,
    ref + '.lock',
    reflog,
    reflog + '.lock',
  ];
  const run = async (
    command: string,
    kind: 'mkdir' | 'git',
    scratch?: string,
    additionalWritePaths = metadata,
  ): Promise<{ stdout: string; stderr: string }> => {
    const fail = (cause: unknown): never => {
      const code = 'SDK_REPOSITORY_FILESYSTEM_FAILED';
      log.warn('Claude repository filesystem operation failed', {
        code,
        stage: kind,
        conversationId: options.conversationId,
      });
      throw Object.assign(
        new Error('Claude repository preparation failed inside its enforced filesystem boundary', {
          cause,
        }),
        { code },
      );
    };
    await options.assertCurrent();
    options.signal.throwIfAborted();
    const result = await executeSandboxedCommand({
      command,
      cwd: options.workspaceDirectory,
      writableRoots: [options.workspaceDirectory, ...(scratch ? [scratch] : [])],
      additionalWritePaths,
      deniedRoots: [],
      env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin' },
      signal: options.signal,
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
      privateOutput: 'separate',
      beforeSpawnAsync: options.assertCurrent,
    }).catch(fail);
    if (result.isError || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
      return fail(
        new Error(result.stderr || result.content || 'Sandbox returned incomplete output'),
      );
    }
    await options.assertCurrent();
    options.signal.throwIfAborted();
    return { stdout: result.stdout, stderr: result.stderr };
  };
  const mkdirCommand = (paths: string[]) =>
    [
      process.execPath,
      '-e',
      "for (const path of process.argv.slice(1)) require('node:fs').mkdirSync(path, { recursive: true, mode: 0o700 })",
      ...paths,
    ]
      .map(quote)
      .join(' ');
  return {
    mkdir: async (path) => {
      await run(mkdirCommand([path]), 'mkdir', undefined, []);
    },
    git: async (args, environment, scratch) => {
      if (args.includes('worktree') && args.includes('add')) {
        // Only this fixed mkdir command may create the shared parent namespaces.
        // Git itself receives just this task's administration, ref and reflog;
        // retargeting checkout at the source config/objects/other refs is denied.
        const parents = [
          join(options.commonDirectory, 'worktrees'),
          join(options.commonDirectory, 'refs', 'heads'),
          join(options.commonDirectory, 'logs'),
        ];
        await run(
          mkdirCommand([
            parents[0],
            join(parents[1], 'mitzo'),
            join(parents[2], 'refs', 'heads', 'mitzo'),
          ]),
          'mkdir',
          undefined,
          parents,
        );
      }
      return run(
        [
          '/usr/bin/env',
          ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
          readOnlyGitExecutable(),
          ...args,
        ]
          .map(quote)
          .join(' '),
        'git',
        scratch,
      );
    },
  };
}
