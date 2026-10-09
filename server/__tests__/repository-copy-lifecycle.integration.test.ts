import { execFileSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountBinding } from '@mitzo/protocol';
import { afterEach, expect, it } from 'vitest';
import {
  inspectGithubRepositorySource,
  prepareGithubRepositorySource,
  type GithubRepositoryCommand,
} from '../github-repository-source.js';
import { exportHostGithubBundle, inspectHostGithubRepository } from '../github-host-source.js';
import { RepositoryWorkspaces, repositorySourceDigest } from '../repository-workspaces.js';
import { executeTrustedGitCommit } from '../trusted-native-operation.js';

const roots: string[] = [];
const services = new Set<RepositoryWorkspaces>();
afterEach(async () => {
  for (const service of services) service.close();
  services.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const gitEnv = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};
const git = (directory: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-C', directory, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    { encoding: 'utf8', env: gitEnv },
  ).trim();

it('publishes native commits from a copied task after source release and controller restart', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-copy-lifecycle-')));
  roots.push(root);
  const upstream = join(root, 'upstream');
  execFileSync('git', ['init', '-q', '--template=', '-b', 'main', upstream], { env: gitEnv });
  git(upstream, 'config', 'user.name', 'Offline fixture');
  git(upstream, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(upstream, 'file.txt'), 'baseline\n');
  await writeFile(join(upstream, 'run.sh'), '#!/bin/sh\necho baseline\n');
  await chmod(join(upstream, 'run.sh'), 0o755);
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-qm', 'baseline');
  const baseOid = git(upstream, 'rev-parse', 'HEAD');
  // External metadata is mocked; every acquisition and Git operation runs locally.
  const run: GithubRepositoryCommand = async (command, args, signal) => {
    signal.throwIfAborted();
    if (command === 'gh')
      return {
        stdout: JSON.stringify(
          args.at(-1)!.endsWith('/branches/main')
            ? { name: 'main', commit: { sha: baseOid } }
            : { full_name: 'example/repo', default_branch: 'main', size: 1, archived: false },
        ),
        stderr: '',
      };
    if (command !== 'git') throw new Error('Unexpected external command');
    const local = args.map((arg) =>
      args[0] === 'clone' && arg === 'https://github.com/example/repo.git' ? upstream : arg,
    );
    return {
      stdout: execFileSync('git', ['-c', 'commit.gpgsign=false', ...local], {
        encoding: 'utf8',
        env: gitEnv,
      }),
      stderr: '',
    };
  };
  const binding = {
    accountId: 'offline-fixture',
    provider: 'openai',
    model: 'fixture-no-model-calls',
    profileRevision: 'v1',
  } as AccountBinding;
  const authorize = async () => ({ revision: 1, allowedBaseBranches: ['main'] });
  const privateRoot = join(root, 'private');
  const service = new RepositoryWorkspaces(privateRoot, {
    authorize,
    inspect: (repository, signal) => inspectGithubRepositorySource(repository, signal, run),
    prepare: (preview, directory, branch, signal) =>
      prepareGithubRepositorySource(preview, directory, branch, signal, run),
  });
  services.add(service);
  const signal = new AbortController().signal;
  const taskRoot = join(root, 'tasks');
  await mkdir(taskRoot);
  const preview = await service.preview(binding, 'github', 'example/repo', signal);
  await service.prepare(preview.id, binding, signal);
  // Exercise the real platform's clone-preferred copier through the controller claim.
  const claimed = await service.claim(preview.id, binding, 'conversation', taskRoot, false);
  const task = claimed.directory!;
  const frozenDigest = service.get(preview.id).sourceDigest;
  await writeFile(join(task, 'file.txt'), 'first native change\n');
  await executeTrustedGitCommit(
    task,
    ['file.txt'],
    'first native change',
    signal,
    undefined,
    undefined,
    undefined,
    await service.validateHostTask('conversation', task),
  );
  const firstOid = git(task, 'rev-parse', 'HEAD');
  expect(firstOid).not.toBe(baseOid);
  expect(await repositorySourceDigest(claimed.seed)).toBe(frozenDigest);
  expect(git(claimed.seed, 'rev-parse', 'HEAD')).toBe(baseOid);

  // Keep an uncommitted edit across release/restart, then commit it with the restored claim.
  const binary = Buffer.from([0, 255, 1, 128, 10]);
  await writeFile(join(task, 'payload.bin'), binary);
  await writeFile(join(task, 'run.sh'), '#!/bin/sh\necho resumed\n');
  await service.releaseSource(preview.id, binding, 'conversation');
  await expect(access(claimed.seed)).rejects.toMatchObject({ code: 'ENOENT' });
  service.close();
  services.delete(service);
  const restored = new RepositoryWorkspaces(privateRoot, { authorize });
  services.add(restored);
  expect(restored.getForConversation('conversation')).toMatchObject({
    directory: task,
    sourceReleased: true,
    taskIdentity: claimed.taskIdentity,
  });
  expect(restored.getForConversation('conversation')).not.toHaveProperty('seed');
  const resumed = await restored.claim(preview.id, binding, 'conversation', taskRoot, false);
  expect(resumed.directory).toBe(task);
  expect(git(task, 'rev-parse', 'HEAD')).toBe(firstOid);
  expect(await readFile(join(task, 'payload.bin'))).toEqual(binary);
  await executeTrustedGitCommit(
    task,
    ['payload.bin', 'run.sh'],
    'resumed native change',
    signal,
    undefined,
    undefined,
    undefined,
    await restored.validateHostTask('conversation', task),
  );

  const source = {
    workspace: task,
    repositoryPath: task,
    gitStorageRoots: [],
    baseBranch: 'main',
    signal,
    privateDirectory: join(root, 'publication'),
  };
  const inspection = await inspectHostGithubRepository(source);
  expect(inspection).toMatchObject({
    sourceBranch: preview.featureBranch,
    commitsAhead: 2,
    changedFiles: ['file.txt', 'payload.bin', 'run.sh'],
    originUrl: 'https://github.com/example/repo.git',
    status: '',
  });
  if (!inspection.sourceBranch) throw new Error('Prepared task has no publication branch');
  const bundlePath = join(root, 'task.bundle');
  await writeFile(
    bundlePath,
    await exportHostGithubBundle({
      ...source,
      sourceBranch: inspection.sourceBranch,
      sourceOid: inspection.sourceOid,
      maxBytes: 1024 * 1024,
    }),
  );
  // A nonempty bundle is insufficient: verify and consume it from only the baseline history.
  const recipient = join(root, 'recipient');
  git(root, 'clone', '--quiet', '--no-hardlinks', '--template=', upstream, recipient);
  git(recipient, 'bundle', 'verify', bundlePath);
  git(recipient, 'fetch', '--quiet', bundlePath, `${preview.featureBranch}:published`);
  expect(git(recipient, 'rev-parse', 'published')).toBe(inspection.sourceOid);
  expect(git(recipient, 'rev-list', '--count', 'main..published')).toBe('2');
  git(recipient, 'checkout', '--quiet', 'published');
  expect(await readFile(join(recipient, 'file.txt'), 'utf8')).toBe('first native change\n');
  expect(await readFile(join(recipient, 'payload.bin'))).toEqual(binary);
  expect(git(recipient, 'ls-tree', 'HEAD', 'run.sh')).toMatch(/^100755 blob /);
  expect(await readFile(join(upstream, 'file.txt'), 'utf8')).toBe('baseline\n');
  expect(git(upstream, 'rev-parse', 'HEAD')).toBe(baseOid);
});
