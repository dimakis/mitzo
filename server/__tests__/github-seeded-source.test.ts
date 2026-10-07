import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { projectSeededChange } from '../github-seeded-source.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mitzo-seed-publication-'));
  roots.push(root);
  const upstream = join(root, 'upstream');
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'commit.gpgsign',
        GIT_CONFIG_VALUE_0: 'false',
      },
    }).trim();
  git('init', '-q', '-b', 'main', upstream);
  git('-C', upstream, 'config', 'user.name', 'Fixture');
  git('-C', upstream, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(upstream, 'note.txt'), 'old\n');
  await writeFile(join(upstream, 'upstream-only.txt'), 'preserve\n');
  git('-C', upstream, 'add', '.');
  git('-C', upstream, 'commit', '-qm', 'upstream');
  const baseOid = git('-C', upstream, 'rev-parse', 'HEAD');
  const seed = join(root, 'seed');
  git('init', '-q', '-b', 'task', seed);
  git('-C', seed, 'config', 'user.name', 'Fixture');
  git('-C', seed, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(seed, 'note.txt'), 'old\n');
  git('-C', seed, 'add', '.');
  git('-C', seed, 'commit', '-qm', 'seed');
  const seedOid = git('-C', seed, 'rev-parse', 'HEAD');
  const seedTreeOid = git('-C', seed, 'rev-parse', 'HEAD^{tree}');
  await writeFile(join(seed, 'note.txt'), 'new\n');
  git('-C', seed, 'commit', '-qam', 'change');
  const sourceOid = git('-C', seed, 'rev-parse', 'HEAD');
  const patch = execFileSync('git', [
    '-C',
    seed,
    'diff',
    '--binary',
    '--full-index',
    seedOid,
    sourceOid,
  ]);
  const runHost = async (command: string, args: readonly string[], signal: AbortSignal) => {
    const actual = [...args];
    const url = actual.indexOf('https://github.com/example/repo.git');
    if (url >= 0) actual[url] = upstream;
    return {
      stdout: execFileSync(command, actual, {
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
        signal,
      }),
      stderr: '',
    };
  };
  return { root, git, upstream, baseOid, sourceOid, seedTreeOid, patch, runHost };
}
it('projects only the task delta, preserving upstream-only files and original seed history', async () => {
  const f = await fixture();
  const before = f.git('-C', f.upstream, 'rev-parse', 'HEAD');
  const input = {
    repository: 'example/repo',
    baseBranch: 'main',
    sourceBranch: 'task',
    originalSourceOid: f.sourceOid,
    seedTreeOid: f.seedTreeOid,
    patch: f.patch,
    signal: new AbortController().signal,
  };
  const first = await projectSeededChange(f.runHost, input);
  const second = await projectSeededChange(f.runHost, { ...input, baseOid: first.baseOid });
  expect(second.sourceOid).toBe(first.sourceOid);
  expect(first.sourceOid).not.toBe(f.sourceOid);
  const output = join(f.root, 'output');
  f.git('clone', '-q', f.upstream, output);
  const bundle = join(f.root, 'change.bundle');
  await writeFile(bundle, first.bundle);
  f.git('-C', output, 'fetch', bundle, 'task:task');
  expect(f.git('-C', output, 'show', 'task:note.txt')).toBe('new');
  expect(f.git('-C', output, 'show', 'task:upstream-only.txt')).toBe('preserve');
  expect(f.git('-C', output, 'rev-list', '--count', 'main..task')).toBe('1');
  expect(f.git('-C', f.upstream, 'rev-parse', 'HEAD')).toBe(before);
});
it('rejects a conflicting patch instead of replacing upstream content', async () => {
  const f = await fixture();
  await writeFile(join(f.upstream, 'note.txt'), 'different\n');
  f.git('-C', f.upstream, 'commit', '-qam', 'concurrent');
  await expect(
    projectSeededChange(f.runHost, {
      repository: 'example/repo',
      baseBranch: 'main',
      sourceBranch: 'task',
      originalSourceOid: f.sourceOid,
      seedTreeOid: f.seedTreeOid,
      patch: f.patch,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
});
