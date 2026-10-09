import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalRepositorySelection,
  inspectGithubRepositorySource,
  prepareGithubRepositorySource,
} from '../github-repository-source.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-repository-source-')));
  roots.push(root);
  const source = join(root, 'upstream');
  const git = (directory: string, ...args: string[]) =>
    execFileSync('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null', ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', source]);
  git(source, 'config', 'user.name', 'Test');
  git(source, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(source, 'file.txt'), 'original\n');
  await writeFile(join(source, '.gitattributes'), '*.txt filter=untrusted');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'base');
  const oid = git(source, 'rev-parse', 'HEAD');
  const run = vi.fn(async (command: string, args: readonly string[]) => {
    if (command === 'gh') {
      const endpoint = args.at(-1)!;
      return {
        stdout: JSON.stringify(
          endpoint.endsWith('/branches/main')
            ? { name: 'main', commit: { sha: oid } }
            : { full_name: 'example/repo', default_branch: 'main', size: 1, archived: false },
        ),
        stderr: '',
      };
    }
    const actual = args.map((value) =>
      args[0] === 'clone' && value === 'https://github.com/example/repo.git' ? source : value,
    );
    return {
      stdout: execFileSync(command, actual, {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      }),
      stderr: '',
    };
  });
  const signal = new AbortController().signal;
  return { root, source, oid, git, run, signal };
}

it('accepts GitHub names and canonical URLs and refuses credentials and other hosts', () => {
  expect(canonicalRepositorySelection('Example/Repo')).toBe('example/repo');
  expect(canonicalRepositorySelection('https://github.com/Example/Repo.git')).toBe('example/repo');
  for (const value of [
    'https://token@github.com/example/repo',
    'https://evil.test/example/repo',
    'file:///tmp/repo',
    '--upload-pack=evil',
    'example/../repo',
    'https://github.com/example/repo?token=secret',
  ]) {
    expect(() => canonicalRepositorySelection(value)).toThrow();
  }
});

it('previews the canonical default branch and exact remote commit without cloning', async () => {
  const f = await fixture();
  expect(await inspectGithubRepositorySource('Example/Repo', f.signal, f.run)).toMatchObject({
    repository: 'example/repo',
    baseBranch: 'main',
    baseOid: f.oid,
  });
  expect(f.run.mock.calls.every(([command]) => command === 'gh')).toBe(true);
});

it('creates an independent feature checkout pinned to the preview without executing repository code', async () => {
  const f = await fixture();
  const preview = await inspectGithubRepositorySource('example/repo', f.signal, f.run);
  const target = join(f.root, 'task');
  const result = await prepareGithubRepositorySource(
    preview,
    target,
    'mitzo/task-123',
    f.signal,
    f.run,
  );
  expect(result).toMatchObject({ ...preview, directory: target, featureBranch: 'mitzo/task-123' });
  expect(await readFile(join(target, 'file.txt'), 'utf8')).toBe('original\n');
  expect(f.git(target, 'symbolic-ref', '--short', 'HEAD')).toBe('mitzo/task-123');
  expect(f.git(target, 'rev-parse', 'HEAD')).toBe(f.oid);
  expect(f.git(target, 'rev-parse', 'origin/main')).toBe(f.oid);
  expect(f.git(target, 'remote', 'get-url', 'origin')).toBe('https://github.com/example/repo.git');
  expect(await readFile(join(target, '.git/objects/info/alternates'), 'utf8').catch(() => '')).toBe(
    '',
  );
  await writeFile(join(target, 'file.txt'), 'task change\n');
  expect(await readFile(join(f.source, 'file.txt'), 'utf8')).toBe('original\n');
});

it('refuses a moved starting commit and cleans only its own preparation directory', async () => {
  const f = await fixture();
  const preview = await inspectGithubRepositorySource('example/repo', f.signal, f.run);
  await writeFile(join(f.source, 'file.txt'), 'upstream change\n');
  f.git(f.source, 'commit', '-qam', 'advance');
  const target = join(f.root, 'task');
  await expect(
    prepareGithubRepositorySource(preview, target, 'mitzo/task-123', f.signal, f.run),
  ).rejects.toThrow('Starting commit changed');
  await expect(access(target)).rejects.toThrow();
  expect(await readFile(join(f.source, 'file.txt'), 'utf8')).toBe('upstream change\n');
});

it('preserves an existing destination rather than overwriting it', async () => {
  const f = await fixture();
  const preview = await inspectGithubRepositorySource('example/repo', f.signal, f.run);
  await expect(
    prepareGithubRepositorySource(preview, f.source, 'mitzo/task-123', f.signal, f.run),
  ).rejects.toThrow();
  expect(await readFile(join(f.source, 'file.txt'), 'utf8')).toBe('original\n');
});
