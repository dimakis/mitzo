import { executeSandboxedCommand } from './sandboxed-command.js';
import { readOnlyGitExecutable } from './read-only-git.js';
import { createSdkRepositoryDirectory } from './sdk-repository-directory.js';
import { createLogger } from './logger.js';
import { join } from 'node:path';
import type { SafeLocalWorktreeFilesystem } from './worktree.js';

const log = createLogger('sdk-secondary-repository-filesystem');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Fixed descriptor-relative mkdir and kernel-bounded Git subprocesses keep
 * ancestor swaps from redirecting allocation outside approved roots. */
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
  const fail = (kind: 'mkdir' | 'git', cause: unknown): never => {
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
  const run = async (
    command: string,
    scratch?: string,
  ): Promise<{ stdout: string; stderr: string }> => {
    await options.assertCurrent();
    options.signal.throwIfAborted();
    const result = await executeSandboxedCommand({
      command,
      cwd: join(options.workspaceDirectory, '.claude'),
      writableRoots: [join(options.workspaceDirectory, '.claude'), ...(scratch ? [scratch] : [])],
      additionalWritePaths: metadata,
      deniedRoots: [],
      env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin' },
      signal: options.signal,
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
      privateOutput: 'separate',
      beforeSpawnAsync: options.assertCurrent,
    }).catch((cause: unknown) => fail('git', cause));
    if (result.isError || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
      return fail(
        'git',
        new Error(result.stderr || result.content || 'Sandbox returned incomplete output'),
      );
    }
    await options.assertCurrent();
    options.signal.throwIfAborted();
    return { stdout: result.stdout, stderr: result.stderr };
  };
  const mkdir = async (root: string, path: string) => {
    await options.assertCurrent();
    await createSdkRepositoryDirectory(root, path, options.signal).catch((cause: unknown) =>
      fail('mkdir', cause),
    );
    await options.assertCurrent();
  };
  return {
    mkdir: async (path) => {
      await mkdir(options.workspaceDirectory, path);
    },
    git: async (args, environment, scratch) => {
      if (args.includes('worktree') && args.includes('add')) {
        // Only this fixed mkdir command may create the shared parent namespaces.
        // Git itself receives just this task's administration, ref and reflog;
        // retargeting checkout at the source config/objects/other refs is denied.
        const parents = [
          join(options.commonDirectory, 'worktrees'),
          join(options.commonDirectory, 'refs', 'heads', 'mitzo'),
          join(options.commonDirectory, 'logs', 'refs', 'heads', 'mitzo'),
        ];
        for (const path of parents) await mkdir(options.commonDirectory, path);
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
        scratch,
      );
    },
  };
}
