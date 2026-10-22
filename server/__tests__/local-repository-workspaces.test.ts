import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepositoryWorkspaces } from '../repository-workspaces.js';
import type { AccountBinding } from '@mitzo/protocol';
import { OrdinaryLocalWorkspaceOwner } from '../ordinary-local-workspace-owner.js';

const roots: string[] = [];
const owners: RepositoryWorkspaces[] = [];
afterEach(() => {
  owners.splice(0).forEach((owner) => owner.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
const binding = {
  accountId: 'work',
  accountLabel: 'Work',
  provider: 'openai' as const,
  model: 'offline-model',
  profileRevision: 'routing-1',
} satisfies AccountBinding;
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'local-repo-')));
  roots.push(root);
  const repo = join(root, 'existing');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-C', cwd, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      },
    ).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.name', 'Offline');
  git(repo, 'config', 'user.email', 'offline@example.invalid');
  writeFileSync(join(repo, 'code.txt'), 'original');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  writeFileSync(join(repo, 'uncommitted.txt'), 'keep local changes');
  const taskRoot = join(root, 'tasks');
  mkdirSync(taskRoot);
  const runtime = {
    version: 2 as const,
    account: { accountId: 'work', provider: 'openai' as const, profileRevision: 'routing-1' },
    harness: { implementation: 'responses' as const },
    execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'mac-1' },
  };
  const authorize = vi.fn(async () => {
    throw Error('Local repositories must not use GitHub');
  });
  const inspect = vi.fn(),
    prepare = vi.fn();
  const deps = {
    authorize,
    inspect,
    prepare,
    localRepositories: () => ({ primary: repo }),
    ordinaryPreparation: {
      capture: vi.fn(async () => ({
        version: 1 as const,
        originalBinding: binding,
        runtimeBinding: runtime,
        credentialDigest: 'a'.repeat(64),
      })),
      assert: vi.fn(async () => {}),
    },
  };
  const reopen = () => {
    const service = new RepositoryWorkspaces(join(root, 'private'), deps);
    owners.push(service);
    return service;
  };
  return { root, repo, git, taskRoot, deps, runtime, reopen };
}

it('uses an existing local repository without GitHub or import, and resumes the same dirty worktree after restart', async () => {
  const f = await fixture();
  const service = f.reopen();
  const ready = await service.selectLocalRepository(
    binding,
    'primary',
    {
      runOn: 'local',
      runtime: { account: f.runtime.account, harness: 'responses', targetId: 'mac' },
    },
    AbortSignal.timeout(10000),
  );
  expect(ready).toMatchObject({ state: 'ready', ordinaryRuntime: f.runtime });
  const reservation = {
    id: ready.id,
    binding,
    conversationId: 'session-local',
    taskRoot: f.taskRoot,
    runtimeBinding: f.runtime,
    commandFingerprint: 'b'.repeat(64),
    signal: AbortSignal.timeout(10000),
  };
  await service.reserveHostTask(reservation);
  const claimed = await service.claimReservedHostTask(reservation);
  await new OrdinaryLocalWorkspaceOwner(service, 'repository', reservation).validate(
    claimed.directory!,
  );
  expect(f.git(claimed.directory!, 'rev-parse', '--git-common-dir')).not.toBe('.git');
  expect(f.git(claimed.directory!, 'branch', '--show-current')).toBe(ready.featureBranch);
  writeFileSync(join(claimed.directory!, 'code.txt'), 'unfinished session work');
  service.close();
  owners.splice(owners.indexOf(service), 1);
  const resumed = await f.reopen().claimReservedHostTask(reservation);
  expect(resumed.directory).toBe(claimed.directory);
  expect(f.git(resumed.directory!, 'diff')).toContain('unfinished session work');
  expect(f.git(f.repo, 'status', '--short')).toContain('uncommitted.txt');
  expect(f.deps.authorize).not.toHaveBeenCalled();
  expect(f.deps.inspect).not.toHaveBeenCalled();
  expect(f.deps.prepare).not.toHaveBeenCalled();
});

it('shares only configured runtime directories with the local worktree', async () => {
  const f = await fixture();
  mkdirSync(join(f.repo, 'node_modules'));
  mkdirSync(join(f.repo, 'unshared'));
  writeFileSync(join(f.repo, '.mitzo.json'), JSON.stringify({ runtimeSymlinks: ['node_modules'] }));
  const service = f.reopen();
  const ready = await service.selectLocalRepository(
    binding,
    'primary',
    {
      runOn: 'local',
      runtime: { account: f.runtime.account, harness: 'responses', targetId: 'mac' },
    },
    AbortSignal.timeout(10000),
  );
  const reservation = {
    id: ready.id,
    binding,
    conversationId: 'runtime-directories',
    taskRoot: f.taskRoot,
    runtimeBinding: f.runtime,
    commandFingerprint: 'b'.repeat(64),
    signal: AbortSignal.timeout(10000),
  };
  await service.reserveHostTask(reservation);
  const claimed = await service.claimReservedHostTask(reservation);
  expect(readlinkSync(join(claimed.directory!, 'node_modules'))).toBe(join(f.repo, 'node_modules'));
  expect(() => readlinkSync(join(claimed.directory!, 'unshared'))).toThrow();
  await new OrdinaryLocalWorkspaceOwner(service, 'repository', reservation).validate(
    claimed.directory!,
  );
});

it('refuses arbitrary paths, sandbox targets and a changed configured repository', async () => {
  const f = await fixture();
  const service = f.reopen();
  const selection = {
    runOn: 'local' as const,
    runtime: { account: f.runtime.account, harness: 'responses' as const, targetId: 'mac' },
  };
  await expect(
    service.selectLocalRepository(binding, f.repo, selection, AbortSignal.timeout(10000)),
  ).rejects.toThrow();
  await expect(
    service.selectLocalRepository(
      binding,
      'primary',
      { ...selection, runOn: 'openshell' },
      AbortSignal.timeout(10000),
    ),
  ).rejects.toThrow();
  const ready = await service.selectLocalRepository(
    binding,
    'primary',
    selection,
    AbortSignal.timeout(10000),
  );
  f.deps.localRepositories = () => ({ primary: join(f.root, 'replacement') });
  await expect(
    service.reserveHostTask({
      id: ready.id,
      binding,
      conversationId: 'session-local',
      taskRoot: f.taskRoot,
      runtimeBinding: f.runtime,
      commandFingerprint: 'b'.repeat(64),
      signal: AbortSignal.timeout(10000),
    }),
  ).rejects.toThrow();
});

it('fetches latest upstream main instead of stale local main, while preserving an explicit agent ref', async () => {
  const f = await fixture();
  const upstream = join(f.root, 'upstream.git');
  execFileSync('git', ['clone', '-q', '--bare', f.repo, upstream]);
  f.git(f.repo, 'remote', 'add', 'origin', upstream);
  f.git(f.repo, 'fetch', '-q', 'origin');
  const previous = f.git(f.repo, 'rev-parse', 'main');
  const publisher = join(f.root, 'publisher');
  execFileSync('git', ['clone', '-q', upstream, publisher]);
  f.git(publisher, 'config', 'user.name', 'Offline');
  f.git(publisher, 'config', 'user.email', 'offline@example.invalid');
  writeFileSync(join(publisher, 'new.txt'), 'latest main');
  f.git(publisher, 'add', '.');
  f.git(publisher, 'commit', '-qm', 'upstream advanced');
  f.git(publisher, 'push', '-q', 'origin', 'main');
  const latest = f.git(publisher, 'rev-parse', 'HEAD');
  const selection = {
    runOn: 'local' as const,
    runtime: { account: f.runtime.account, harness: 'responses' as const, targetId: 'mac' },
  };
  const service = f.reopen();
  const ready = await service.selectLocalRepository(
    binding,
    'primary',
    selection,
    AbortSignal.timeout(10000),
  );
  expect(ready.baseOid).toBe(latest);
  expect(f.git(f.repo, 'rev-parse', 'main')).toBe(previous);
  expect(f.git(f.repo, 'status', '--short')).toContain('uncommitted.txt');
  const explicit = await service.selectLocalRepository(
    binding,
    'primary',
    selection,
    AbortSignal.timeout(10000),
    undefined,
    previous,
  );
  expect(explicit.baseOid).toBe(previous);
});
