import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadGithubSeedBaselines, selectGithubSeedBaseline } from '../github-seed-baselines.js';
let root = '';
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
it('resolves only a controller-configured seed tree to its verified source repository', async () => {
  root = await mkdtemp(join(tmpdir(), 'mitzo-seed-binding-'));
  const source = join(root, 'source'),
    seed = join(root, 'mgmt');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        cwd,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { encoding: 'utf8' },
    ).trim();
  for (const path of [source, seed]) {
    await mkdir(path);
    git(path, 'init', '-q');
    await writeFile(join(path, 'note.txt'), 'base\n');
    git(path, 'add', '.');
    git(path, 'commit', '-qm', 'seed');
  }
  git(source, 'remote', 'add', 'origin', 'https://github.com/example/repo.git');
  const baseline = join(root, 'baseline.json');
  await writeFile(
    baseline,
    JSON.stringify({ source, startingCommit: git(source, 'rev-parse', 'HEAD') }),
  );
  const bindings = await loadGithubSeedBaselines([baseline], new AbortController().signal);
  expect(selectGithubSeedBaseline(bindings, git(seed, 'rev-parse', 'HEAD^{tree}'))).toMatchObject({
    repository: 'example/repo',
  });
  expect(() => selectGithubSeedBaseline(bindings, '0'.repeat(40))).toThrow();
  const binding = bindings[0]!;
  expect(() =>
    selectGithubSeedBaseline(
      [binding, { ...binding, repository: 'other/repo' }],
      binding.seedTreeOid,
    ),
  ).toThrow();
});
it('ignores an unused seed source when resolving a different verified tree', async () => {
  root = await mkdtemp(join(tmpdir(), 'mitzo-seed-unused-'));
  const prepared = join(root, 'mgmt');
  await mkdir(prepared);
  execFileSync('git', ['-C', prepared, 'init', '-q']);
  await writeFile(join(prepared, 'note.txt'), 'unrelated\n');
  execFileSync('git', ['-C', prepared, 'add', '.']);
  execFileSync('git', [
    '-C',
    prepared,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'seed',
  ]);
  const path = join(root, 'baseline.json');
  await writeFile(
    path,
    JSON.stringify({ source: '/missing-unused-source', startingCommit: 'a'.repeat(40) }),
  );
  expect(
    await loadGithubSeedBaselines([path], new AbortController().signal, '0'.repeat(40)),
  ).toEqual([]);
});
it('keeps explicitly configured baselines when a supported static seed has no sibling baseline', async () => {
  const { configuredGithubSeedBaselinePaths } = await import('../github-seed-baselines.js');
  root = await mkdtemp(join(tmpdir(), 'mitzo-seed-static-'));
  await mkdir(join(root, 'mgmt'));
  expect(
    configuredGithubSeedBaselinePaths(
      join(root, 'mgmt'),
      JSON.stringify(['/srv/retained/baseline.json']),
    ),
  ).toEqual(['/srv/retained/baseline.json']);
});
it('uses the combined loader limit for 32 retained baselines plus the automatic seed', async () => {
  const { configuredGithubSeedBaselinePaths, MAX_GITHUB_SEED_BASELINES } =
    await import('../github-seed-baselines.js');
  root = await mkdtemp(join(tmpdir(), 'mitzo-seed-configured-'));
  await mkdir(join(root, 'mgmt'));
  await writeFile(join(root, 'baseline.json'), '{}');
  const retained = Array.from({ length: 32 }, (_, i) => `/srv/seed-${i}/baseline.json`);
  const paths = configuredGithubSeedBaselinePaths(join(root, 'mgmt'), JSON.stringify(retained));
  expect(paths).toHaveLength(33);
  expect(paths.length).toBeLessThanOrEqual(MAX_GITHUB_SEED_BASELINES);
  expect(() =>
    configuredGithubSeedBaselinePaths(undefined, JSON.stringify(['relative.json'])),
  ).toThrow();
});
