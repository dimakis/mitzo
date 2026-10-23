import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountBinding } from '@mitzo/protocol';
import { OrdinaryLocalWorkspaceOwner } from '../ordinary-local-workspace-owner.js';
import { RepositoryWorkspaces } from '../repository-workspaces.js';

const roots: string[] = [];
const services: RepositoryWorkspaces[] = [];
afterEach(() => {
  services.splice(0).forEach((service) => service.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
const binding = {
  accountId: 'offline',
  accountLabel: 'Offline fixtures',
  provider: 'openai' as const,
  model: 'offline-model',
  profileRevision: 'profile-1',
} satisfies AccountBinding;
const runtime = {
  version: 2 as const,
  account: { accountId: 'offline', provider: 'openai' as const, profileRevision: 'profile-1' },
  harness: { implementation: 'codex' as const },
  execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'mac-1' },
};
const selection = {
  runOn: 'local' as const,
  runtime: { account: runtime.account, harness: 'codex' as const, targetId: 'mac' },
};
const signal = () => AbortSignal.timeout(30000);
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    },
  ).trim();
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'existing-repository-owner-')));
  roots.push(root);
  const repositories = ['unrelated-web', 'unrelated-library'].map((name) => {
    const path = join(root, name);
    execFileSync('git', ['init', '-q', '-b', 'main', path]);
    git(path, 'config', 'user.name', 'Offline');
    git(path, 'config', 'user.email', 'offline@example.invalid');
    writeFileSync(join(path, 'AGENTS.md'), `Instructions for ${name}\n`);
    writeFileSync(join(path, 'code.txt'), `Original ${name}\n`);
    git(path, 'add', '.');
    git(path, 'commit', '-qm', 'fixture base');
    return path;
  });
  const taskRoot = join(root, 'tasks');
  mkdirSync(taskRoot, { mode: 0o700 });
  const deps = {
    // No enrollment or configured registry. Access is always rechecked by the host owner.
    assertLocalRepositoryAccess: vi.fn(async (_path: string, _context: unknown) => {}),
    authorize: vi.fn(async () => {
      throw Error('Unexpected remote authorization');
    }),
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
  const open = () => {
    const service = new RepositoryWorkspaces(join(root, 'private'), deps);
    services.push(service);
    return service;
  };
  const reservation = (id: string, conversationId = 'same-conversation') => ({
    id,
    binding,
    conversationId,
    taskRoot,
    runtimeBinding: runtime,
    commandFingerprint: 'b'.repeat(64),
    signal: signal(),
  });
  return { root, repositories, taskRoot, deps, open, reservation };
}

it('prepares two unenrolled repositories while preserving dirty source files and instructions', async () => {
  const f = fixture();
  const service = f.open();
  writeFileSync(join(f.repositories[0], 'code.txt'), 'User edits\n');
  writeFileSync(join(f.repositories[0], '.env'), 'FIXTURE_SECRET=excluded\n');
  writeFileSync(
    join(f.repositories[0], '.mitzo.json'),
    JSON.stringify({ runtimeSymlinks: ['.env'] }),
  );
  git(f.repositories[0], 'add', 'code.txt');
  const statusBefore = git(f.repositories[0], 'status', '--porcelain=v1');
  for (const [index, path] of f.repositories.entries()) {
    const ready = await service.selectExistingLocalRepository(
      binding,
      path,
      selection,
      signal(),
      undefined,
      'HEAD',
    );
    const reservation = f.reservation(ready.id, `conversation-${index}`);
    await service.reserveHostTask(reservation);
    const claimed = await service.claimReservedHostTask(reservation);
    expect(claimed.conversationId).toBe(reservation.conversationId);
    expect(claimed.localSource?.path).toBe(path);
    expect(claimed.localSource?.selection).toBe('existing');
    expect(readFileSync(join(claimed.directory!, 'AGENTS.md'), 'utf8')).toBe(
      readFileSync(join(path, 'AGENTS.md'), 'utf8'),
    );
    expect(readFileSync(join(claimed.directory!, 'code.txt'), 'utf8')).toContain('Original');
    expect(existsSync(join(claimed.directory!, '.env'))).toBe(false);
    await new OrdinaryLocalWorkspaceOwner(service, 'repository', reservation).validate(
      claimed.directory!,
    );
  }
  expect(git(f.repositories[0], 'status', '--porcelain=v1')).toBe(statusBefore);
  expect(readFileSync(join(f.repositories[0], '.env'), 'utf8')).toContain('FIXTURE_SECRET');
  expect(f.deps.assertLocalRepositoryAccess).toHaveBeenCalled();
  expect(f.deps.authorize).not.toHaveBeenCalled();
});

it('reattaches the original conversation and dirty owned worktree after owner restart', async () => {
  const f = fixture();
  const service = f.open();
  const ready = await service.selectExistingLocalRepository(
    binding,
    f.repositories[0],
    selection,
    signal(),
    undefined,
    'HEAD',
  );
  const reservation = f.reservation(ready.id);
  await service.reserveHostTask(reservation);
  const claimed = await service.claimReservedHostTask(reservation);
  writeFileSync(join(claimed.directory!, 'code.txt'), 'Unfinished task\n');
  service.close();
  services.splice(services.indexOf(service), 1);
  const resumedService = f.open();
  const owner = new OrdinaryLocalWorkspaceOwner(resumedService, 'repository', reservation);
  await owner.revalidate(signal());
  const resumed = await owner.claim(signal());
  expect(resumed.directory).toBe(claimed.directory);
  expect(resumed.conversationId).toBe('same-conversation');
  expect(readFileSync(join(resumed.directory!, 'code.txt'), 'utf8')).toBe('Unfinished task\n');
  await expect(
    resumedService.reserveHostTask({ ...reservation, conversationId: 'other-conversation' }),
  ).rejects.toThrow();
  await expect(
    resumedService.claimReservedHostTask({ ...reservation, conversationId: 'other-conversation' }),
  ).rejects.toThrow();
});

it('rechecks host access before capture, reservation and retained claim, and fails closed without it', async () => {
  const f = fixture();
  const service = f.open();
  f.deps.assertLocalRepositoryAccess.mockRejectedValueOnce(Error('Access denied'));
  await expect(
    service.selectExistingLocalRepository(
      binding,
      f.repositories[0],
      selection,
      signal(),
      undefined,
      'HEAD',
    ),
  ).rejects.toThrow('Access denied');
  expect(f.deps.ordinaryPreparation.capture).not.toHaveBeenCalled();
  const ready = await service.selectExistingLocalRepository(
    binding,
    f.repositories[0],
    selection,
    signal(),
    undefined,
    'HEAD',
  );
  const reservation = f.reservation(ready.id);
  f.deps.assertLocalRepositoryAccess.mockRejectedValueOnce(Error('Access revoked'));
  await expect(service.reserveHostTask(reservation)).rejects.toThrow('Access revoked');
  expect(existsSync(join(f.taskRoot, `repo-${ready.id}`))).toBe(false);
  await service.reserveHostTask(reservation);
  const claimed = await service.claimReservedHostTask(reservation);
  f.deps.assertLocalRepositoryAccess.mockRejectedValueOnce(Error('Access revoked'));
  await expect(service.claimReservedHostTask(reservation)).rejects.toThrow('Access revoked');
  expect(existsSync(claimed.directory!)).toBe(true);
  const noAuthority = new RepositoryWorkspaces(join(f.root, 'no-authority'), {
    authorize: f.deps.authorize,
    ordinaryPreparation: f.deps.ordinaryPreparation,
  });
  services.push(noAuthority);
  await expect(
    noAuthority.selectExistingLocalRepository(
      binding,
      f.repositories[0],
      selection,
      signal(),
      undefined,
      'HEAD',
    ),
  ).rejects.toThrow();
});

it('rejects replaced source identity and selection reuse for a different path', async () => {
  const f = fixture();
  const service = f.open();
  const ready = await service.selectExistingLocalRepository(
    binding,
    f.repositories[0],
    selection,
    signal(),
    undefined,
    'HEAD',
  );
  await expect(
    service.selectExistingLocalRepository(
      binding,
      f.repositories[1],
      selection,
      signal(),
      ready.id,
      'HEAD',
    ),
  ).rejects.toThrow();
  renameSync(f.repositories[0], `${f.repositories[0]}-preserved`);
  mkdirSync(f.repositories[0]);
  await expect(service.reserveHostTask(f.reservation(ready.id))).rejects.toThrow();
  expect(existsSync(`${f.repositories[0]}-preserved`)).toBe(true);
});

it('keeps configured identity without bypassing access, and permits a separate location override', async () => {
  const f = fixture();
  const service = new RepositoryWorkspaces(join(f.root, 'configured'), {
    ...f.deps,
    localRepositories: () => ({ known: f.repositories[0] }),
  });
  services.push(service);
  const ready = await service.selectExistingLocalRepository(
    binding,
    f.repositories[0],
    selection,
    signal(),
    undefined,
    'HEAD',
  );
  expect(service.get(ready.id).localSource?.repositoryId).toBe('known');
  const override = await service.selectExistingLocalRepository(
    binding,
    f.repositories[1],
    selection,
    signal(),
    undefined,
    'HEAD',
  );
  expect(service.get(override.id).localSource?.path).toBe(f.repositories[1]);
  expect(override.id).not.toBe(ready.id);
  f.deps.assertLocalRepositoryAccess.mockRejectedValueOnce(Error('Access denied'));
  await expect(
    service.selectExistingLocalRepository(
      binding,
      f.repositories[0],
      selection,
      signal(),
      undefined,
      'HEAD',
    ),
  ).rejects.toThrow('Access denied');
  await expect(
    service.selectExistingLocalRepository(
      binding,
      f.repositories[0],
      { ...selection, runOn: 'openshell' },
      signal(),
      undefined,
      'HEAD',
    ),
  ).rejects.toThrow('Mac host');
});

it('supports an offline edit, check, build and local PR preparation on the owned branch', async () => {
  const f = fixture();
  const source = f.repositories[0];
  writeFileSync(join(source, 'app.mjs'), 'export const result = 1;\n');
  git(source, 'add', 'app.mjs');
  git(source, 'commit', '-qm', 'fixture program');
  const service = f.open();
  const ready = await service.selectExistingLocalRepository(
    binding,
    source,
    selection,
    signal(),
    undefined,
    'HEAD',
  );
  const reservation = f.reservation(ready.id);
  await service.reserveHostTask(reservation);
  const claimed = await service.claimReservedHostTask(reservation);
  const cwd = claimed.directory!;
  writeFileSync(join(cwd, 'app.mjs'), 'export const result = 2;\n');
  execFileSync(process.execPath, ['--check', 'app.mjs'], { cwd });
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { result } from './app.mjs'; import { writeFileSync } from 'node:fs'; if (result !== 2) process.exit(1); writeFileSync('build.txt', String(result));",
    ],
    { cwd },
  );
  expect(readFileSync(join(cwd, 'build.txt'), 'utf8')).toBe('2');
  git(cwd, 'diff', '--check');
  git(cwd, 'add', 'app.mjs');
  git(cwd, 'commit', '-qm', 'feat: fixture change ready for review');
  expect(git(cwd, 'branch', '--show-current')).toBe(ready.featureBranch);
  expect(git(cwd, 'diff', `${ready.baseOid}..HEAD`, '--', 'app.mjs')).toContain('result = 2');
  expect(readFileSync(join(source, 'app.mjs'), 'utf8')).toBe('export const result = 1;\n');
  await new OrdinaryLocalWorkspaceOwner(service, 'repository', reservation).revalidate(signal());
  expect(service.getForConversation('same-conversation')?.directory).toBe(cwd);
});

it('uses the local HEAD by default without invoking a repository remote helper', async () => {
  const f = fixture();
  const source = f.repositories[0];
  const marker = join(f.root, 'remote-executed');
  const helper = join(f.root, 'remote-helper');
  writeFileSync(helper, `#!/bin/sh\nprintf invoked > '${marker}'\nexit 7\n`);
  chmodSync(helper, 0o700);
  git(source, 'config', 'protocol.ext.allow', 'always');
  git(source, 'remote', 'add', 'origin', `ext::${helper}`);
  const ready = await f.open().selectExistingLocalRepository(binding, source, selection, signal());
  expect(ready.baseOid).toBe(git(source, 'rev-parse', 'HEAD'));
  expect(existsSync(marker)).toBe(false);
});

it('materializes an arbitrary repository without executing checkout hooks or Git filters', async () => {
  const f = fixture();
  const source = f.repositories[0];
  writeFileSync(join(source, '.gitattributes'), '*.txt filter=untrusted\n');
  git(source, 'add', '.gitattributes');
  git(source, 'commit', '-qm', 'fixture attributes');
  const hookMarker = join(f.root, 'hook-executed');
  const filterMarker = join(f.root, 'filter-executed');
  const helper = join(f.root, 'filter-helper');
  writeFileSync(helper, `#!/bin/sh\nprintf invoked > '${filterMarker}'\ncat\n`);
  chmodSync(helper, 0o700);
  git(source, 'config', 'filter.untrusted.smudge', helper);
  git(source, 'config', 'filter.untrusted.clean', helper);
  git(source, 'config', 'filter.untrusted.required', 'true');
  const hook = join(source, '.git', 'hooks', 'post-checkout');
  writeFileSync(hook, `#!/bin/sh\nprintf invoked > '${hookMarker}'\n`);
  chmodSync(hook, 0o700);
  const service = f.open();
  const ready = await service.selectExistingLocalRepository(
    binding,
    source,
    selection,
    signal(),
    undefined,
    'HEAD',
  );
  const reservation = f.reservation(ready.id);
  await service.reserveHostTask(reservation);
  const claimed = await service.claimReservedHostTask(reservation);
  expect(existsSync(hookMarker)).toBe(false);
  expect(existsSync(filterMarker)).toBe(false);
  expect(readFileSync(join(claimed.directory!, 'code.txt'), 'utf8')).toContain('Original');
});
