import './fixtures/offline-user-home.js';
import { afterEach, expect, it, vi } from 'vitest';
// Recovery/ownership fixtures do not require a nested OS sandbox. The native
// allocation suite exercises this same consumer through the real boundary.
vi.mock('../sdk-secondary-repository-filesystem.js', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdir } = await import('node:fs/promises');
  const { validatePath } = await import('../sandbox-authority.js');
  const run = promisify(execFile);
  return {
    sdkSecondaryRepositoryFilesystem: () => ({
      mkdir: async (path: string) => {
        await mkdir(path, { recursive: true });
      },
      git: (args: string[], env: Record<string, string>, scratch?: string) => {
        if (scratch) validatePath(scratch);
        return run('git', args, { env, encoding: 'utf8' });
      },
    }),
  };
});
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import { SessionRegistry, buildPermissionHandler, resolvePending } from '@mitzo/harness';
import {
  SDK_REPOSITORY_INSTRUCTIONS,
  sdkRepositoryPreparationApproval,
} from '../sdk-local-repository-tools.js';
import { REPOSITORY_TASK_CLONE_HINT } from '../sdk-worktree-routing.js';
import { executeTaskOperation } from '../task-execution-operation.js';
import { TaskExecutionStore } from '../task-execution-store.js';
import {
  prepareSdkSecondaryRepository,
  restoreSdkSecondaryRepositories,
  sdkSecondaryRepositoryTask,
  retainSdkSecondaryRepositoryTask,
} from '../sdk-secondary-repository.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).trim();
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sdk-secondary-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  execFileSync('git', ['init', '--template=', '-b', 'main', source]);
  git(source, 'config', 'user.name', 'Offline');
  git(source, 'config', 'user.email', 'offline@example.invalid');
  await writeFile(join(source, 'code.txt'), 'original');
  git(source, 'add', 'code.txt');
  git(source, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'initial');
  const store = new EventStore(':memory:');
  store.upsertSession({ sessionId: 'conversation' });
  cleanups.push(() => store.close());
  const signal = new AbortController().signal;
  return {
    source,
    store,
    signal,
    options: {
      sourcePath: source,
      workspaceDirectory: root,
      conversationId: 'conversation',
      wtId: 'sdk-session',
      base: { kind: 'ref' as const, ref: 'HEAD' },
      events: store,
      signal,
      assertCurrent: async () => {},
    },
  };
}
it('materializes through the canonical scratch root when the temporary directory is an alias', async () => {
  const f = await fixture();
  const physical = join(f.options.workspaceDirectory, 'physical-temp');
  const alias = join(f.options.workspaceDirectory, 'temp-alias');
  await mkdir(physical);
  await symlink(physical, alias);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = alias;
  try {
    const task = await prepareSdkSecondaryRepository(f.options);
    expect(git(task.directory, 'show', 'HEAD:code.txt')).toBe('original');
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
});
it('prepares, edits, commits and reopens an isolated repository without changing the primary or source work', async () => {
  const f = await fixture();
  const sourceHead = git(f.source, 'rev-parse', 'HEAD');
  await writeFile(join(f.source, 'code.txt'), 'staged source');
  git(f.source, 'add', 'code.txt');
  await writeFile(join(f.source, 'untracked.txt'), 'preserve');
  const sourceStatus = git(f.source, 'status', '--porcelain');
  const task = await prepareSdkSecondaryRepository(f.options);
  expect(task.state).toBe('active');
  expect(task.directory).not.toBe(f.source);
  expect(git(task.directory, 'rev-parse', 'HEAD')).toBe(sourceHead);
  await writeFile(join(task.directory, 'code.txt'), 'implemented');
  const claim = await sdkSecondaryRepositoryTask(f.store, 'conversation', task.directory);
  expect(claim).toBeDefined();
  // Exercise the actual TaskExecution -> native executor -> retained SDK task
  // claim -> trusted Git path advertised to Claude for linked-worktree commits.
  const registry = new SessionRegistry();
  cleanups.push(() => registry.dispose());
  registry.register('sdk', {
    sessionId: 'conversation',
    cwd: f.options.workspaceDirectory,
    mode: 'auto',
    abortController: new AbortController(),
    sessionAllowList: new Set(),
    transport: {
      isOpen: () => true,
      send: (event) => {
        if (event.type === 'permission_request' && typeof event.permId === 'string') {
          const permId = event.permId;
          queueMicrotask(() => resolvePending(permId, 'once'));
        }
      },
    },
  });
  const session = registry.get('sdk')!;
  session.worktreePaths.set(task.repoName, { path: task.directory, wtId: 'sdk-session' });
  await retainSdkSecondaryRepositoryTask(session, f.store, 'conversation', task.directory);
  const executions = new TaskExecutionStore(':memory:');
  cleanups.push(() => executions.close());
  const grant = executions.approve('offline', 'conversation', 'authorization', {
    title: 'Offline code work',
    network: 'none',
    repositories: [],
    expiresAt: Date.now() + 60000,
    members: [{ sessionId: 'conversation', fingerprint: 'offline', roots: [session.cwd!] }],
  });
  const result = await executeTaskOperation({
    input: {
      operation: 'commit',
      grantId: grant.id,
      requestId: 'offline-commit',
      cwd: task.directory,
      files: ['code.txt'],
      message: 'test: implementation',
    },
    grant,
    sessionId: 'conversation',
    session,
    registry,
    clientId: 'sdk',
    call: { turnId: 'offline-turn', callId: 'offline-call' },
    store: executions,
    signal: f.signal,
    assertGrant: () => grant,
    assertRuntimeCurrent: async () => {},
  });
  expect(result.isError, result.content).toBe(false);
  const committed = git(task.directory, 'rev-parse', 'HEAD');
  expect(committed).not.toBe(sourceHead);
  expect(git(f.source, 'rev-parse', 'HEAD')).toBe(sourceHead);
  expect(git(f.source, 'status', '--porcelain')).toBe(sourceStatus);
  await writeFile(join(task.directory, 'dirty.txt'), 'unfinished task work');
  expect(await prepareSdkSecondaryRepository(f.options)).toMatchObject({
    directory: task.directory,
  });
  const reopened = await restoreSdkSecondaryRepositories(
    f.store,
    'conversation',
    f.signal,
    async () => {},
  );
  expect([...reopened.values()].map((value) => value.path)).toEqual([task.directory]);
  expect(git(task.directory, 'rev-parse', 'HEAD')).toBe(committed);
  expect(git(task.directory, 'status', '--porcelain')).toContain('?? dirty.txt');
  expect(await sdkSecondaryRepositoryTask(f.store, 'foreign', task.directory)).toBeUndefined();
});
it('never executes source Git transport configuration while acquiring the default base', async () => {
  const f = await fixture();
  const marker = join(f.options.workspaceDirectory, 'controller-executed.txt');
  const helper = join(f.source, 'hostile-ssh');
  await writeFile(helper, `#!/bin/sh\nprintf unsafe > '${marker}'\nexit 1\n`, { mode: 0o700 });
  git(f.source, 'config', 'remote.origin.url', 'ssh://git@example.invalid/repository');
  git(f.source, 'config', 'core.sshCommand', helper);
  await expect(
    prepareSdkSecondaryRepository({ ...f.options, base: { kind: 'default' } }),
  ).rejects.toThrow();
  expect(existsSync(marker)).toBe(false);
});
it('refuses revoked owners before allocation and changed or missing retained tasks without recreation', async () => {
  const f = await fixture();
  await expect(
    prepareSdkSecondaryRepository({
      ...f.options,
      assertCurrent: async () => {
        throw Error('revoked');
      },
    }),
  ).rejects.toThrow('revoked');
  expect(git(f.source, 'worktree', 'list', '--porcelain')).not.toContain('sdk-session');
  const task = await prepareSdkSecondaryRepository(f.options);
  git(task.directory, 'switch', '-c', 'other-branch');
  await expect(prepareSdkSecondaryRepository(f.options)).rejects.toThrow();
  git(task.directory, 'switch', task.branch);
  await rm(task.directory, { recursive: true });
  await expect(prepareSdkSecondaryRepository(f.options)).rejects.toThrow();
});
it.each(['.claude', 'repository-tasks', 'swapped before Git'] as const)(
  'refuses a %s link without writing outside the workspace',
  async (link) => {
    const f = await fixture();
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'sdk-secondary-outside-')));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    const claude = join(f.options.workspaceDirectory, '.claude');
    const taskRoot = join(claude, 'repository-tasks');
    if (link === '.claude') await symlink(outside, claude);
    if (link === 'repository-tasks') {
      await mkdir(claude);
      await symlink(outside, taskRoot);
    }
    let swapped = false;
    await expect(
      prepareSdkSecondaryRepository({
        ...f.options,
        // The sandboxed agent may replace a checked ancestor at any later await.
        assertCurrent: async () => {
          if (link !== 'swapped before Git' || swapped || !existsSync(taskRoot)) return;
          swapped = true;
          await rename(taskRoot, join(claude, 'checked-task-root'));
          await symlink(outside, taskRoot);
        },
      }),
    ).rejects.toThrow(/physical/);
    expect(link !== 'swapped before Git' || swapped).toBe(true);
    expect(await readdir(outside)).toEqual([]);
    expect(git(f.source, 'branch', '--list', 'mitzo/*')).toBe('');
    expect(git(f.source, 'worktree', 'list', '--porcelain')).not.toContain('claude-');
  },
);
const restore = (f: Awaited<ReturnType<typeof fixture>>) =>
  restoreSdkSecondaryRepositories(f.store, 'conversation', f.signal, async () => {});
it.each(['retry', 'restore'] as const)(
  'completes a materialized allocation interrupted before its ownership record on %s',
  async (recovery) => {
    const f = await fixture();
    let interrupted = false;
    await expect(
      prepareSdkSecondaryRepository({
        ...f.options,
        assertCurrent: async () => {
          const materialized = f.store
            .getEventsOfType('conversation', 'sdk_secondary_allocation')
            .some((event) => event.payload.stage === 'materialized');
          if (!materialized || interrupted) return;
          interrupted = true;
          throw Error('cancelled after allocation');
        },
      }),
    ).rejects.toThrow('cancelled after allocation');
    expect(f.store.getSessionWorktreeRecords('conversation')).toEqual([]);
    const reopened =
      recovery === 'retry' ? await prepareSdkSecondaryRepository(f.options) : undefined;
    const restored = await restore(f);
    const [entry] = [...restored.values()];
    expect(entry.path).toMatch(/\.claude\/repository-tasks\/claude-/);
    if (reopened) expect(reopened.directory).toBe(entry.path);
    expect(git(entry.path, 'rev-parse', 'HEAD')).toBe(git(f.source, 'rev-parse', 'HEAD'));
    expect(await sdkSecondaryRepositoryTask(f.store, 'conversation', entry.path)).toBeDefined();
    expect(await prepareSdkSecondaryRepository(f.options)).toMatchObject({ directory: entry.path });
  },
);
it('preserves a partially materialized allocation and reports it precisely on retry', async () => {
  const f = await fixture();
  const tasks = join(f.options.workspaceDirectory, '.claude', 'repository-tasks');
  let interrupted = false;
  await expect(
    prepareSdkSecondaryRepository({
      ...f.options,
      assertCurrent: async () => {
        // Git created the worktree but checkout has not completed.
        if (interrupted || !existsSync(tasks) || (await readdir(tasks)).length === 0) return;
        interrupted = true;
        throw Error('cancelled during materialization');
      },
    }),
  ).rejects.toThrow('cancelled during materialization');
  const [name] = await readdir(tasks);
  await expect(prepareSdkSecondaryRepository(f.options)).rejects.toThrow(
    new RegExp(`preserved at ${join(tasks, name)}.*mitzo/${name}`),
  );
  expect(existsSync(join(tasks, name, '.git'))).toBe(true);
  expect(git(f.source, 'branch', '--list', `mitzo/${name}`)).toContain(name);
  expect(await restore(f)).toEqual(new Map());
});
it('requires a fresh approval for every source repository even after an Always answer', async () => {
  const registry = new SessionRegistry();
  cleanups.push(() => registry.dispose());
  const prompts: unknown[] = [];
  registry.register('approvals', {
    sessionId: 'conversation',
    cwd: '/offline/original',
    mode: 'auto',
    abortController: new AbortController(),
    sessionAllowList: new Set(),
    transport: {
      isOpen: () => true,
      send: (event) => {
        if (event.type === 'permission_request' && typeof event.permId === 'string') {
          prompts.push(event.toolInput);
          const permId = event.permId;
          queueMicrotask(() => resolvePending(permId, 'always'));
        }
      },
    },
  });
  const approve = (path: string, toolUseID: string) =>
    buildPermissionHandler('approvals', registry)(
      'mcp__mitzo-connections__PrepareLocalRepository',
      { path },
      sdkRepositoryPreparationApproval({
        path,
        cwd: '/offline/original',
        signal: new AbortController().signal,
        toolUseID,
      }),
    );
  expect(await approve('/offline/repository-a', 'prepare-a')).toMatchObject({ behavior: 'allow' });
  expect(await approve('/offline/repository-b', 'prepare-b')).toMatchObject({ behavior: 'allow' });
  expect(prompts.map((input) => JSON.parse(String(input)))).toEqual([
    { path: '/offline/repository-a' },
    { path: '/offline/repository-b' },
  ]);
  expect(registry.get('approvals')!.sessionAllowList.size).toBe(0);
});

it('guides Claude to native GitHub work in a workspace clone and keeps linked storage on the trusted commit route', () => {
  const clone = 'gh repo clone OWNER/REPO .repository-tasks/<name>';
  expect(SDK_REPOSITORY_INSTRUCTIONS).toContain(clone);
  expect(REPOSITORY_TASK_CLONE_HINT).toContain(clone);
  expect(SDK_REPOSITORY_INSTRUCTIONS).toContain('TaskExecution operation commit');
  expect(SDK_REPOSITORY_INSTRUCTIONS).toContain('command approval is not publication consent');
  expect(SDK_REPOSITORY_INSTRUCTIONS).not.toContain('accepts existing local sources');
});
