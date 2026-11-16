import './fixtures/offline-user-home.js';
import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import { SessionRegistry, resolvePending } from '@mitzo/harness';
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
