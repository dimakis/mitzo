import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  inspectLocalSource,
  exportLocalSource,
  SOURCE_GIT_IMPORTER,
} from '../symposium-source-git.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'source-git-'));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.test',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.test',
      },
    }).trim();
  git('init', '--quiet', '--template=', '--initial-branch=main');
  writeFileSync(join(repo, 'first.txt'), 'first\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'first');
  writeFileSync(join(repo, 'second.txt'), 'second\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'second');
  git('remote', 'add', 'origin', 'https://github.com/example/project.git');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const selection = {
    repositoryId: 'selected',
    targetRepository: 'example/project',
    baseBranch: 'main',
    featureBranch: 'symposium/change',
  };
  return { root, repo, git, selection, repositories: { selected: repo } };
}
it('imports selected committed history and exact publication refs into pristine Git without copying source metadata', async () => {
  const f = fixture();
  writeFileSync(join(f.repo, 'untracked-secret'), 'must not enter');
  f.git('config', 'alias.danger', '!touch should-not-run');
  const plan = await inspectLocalSource(f.repositories, f.selection);
  const exported = await exportLocalSource(f.repositories, plan);
  const target = join(f.root, 'target');
  mkdirSync(target);
  execFileSync('git', ['init', '--quiet', '--template=', '--initial-branch=main', target]);
  const bundle = join(f.root, 'source.bundle');
  writeFileSync(bundle, exported.bundle);
  const proof = JSON.parse(
    execFileSync(
      'python3',
      ['-I', '-B', '-c', SOURCE_GIT_IMPORTER, target, bundle, JSON.stringify(exported.manifest)],
      { encoding: 'utf8' },
    ),
  );
  expect(proof).toMatchObject({
    commit: plan.baseOid,
    tree: plan.treeOid,
    featureBranch: 'symposium/change',
  });
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', target, ...args], { encoding: 'utf8' }).trim();
  expect(git('rev-parse', 'HEAD')).toBe(plan.baseOid);
  expect(git('rev-list', '--count', 'HEAD')).toBe('2');
  expect(git('rev-parse', 'refs/remotes/origin/main')).toBe(plan.baseOid);
  expect(git('symbolic-ref', 'refs/remotes/origin/HEAD')).toBe('refs/remotes/origin/main');
  expect(git('config', '--get', 'remote.origin.url')).toBe(
    'https://github.com/example/project.git',
  );
  expect(readFileSync(join(target, 'first.txt'), 'utf8')).toBe('first\n');
  expect(existsSync(join(target, 'untracked-secret'))).toBe(false);
  expect(readFileSync(join(target, '.git/config'), 'utf8')).not.toContain('danger');
  expect(() =>
    execFileSync(
      'python3',
      ['-I', '-B', '-c', SOURCE_GIT_IMPORTER, target, bundle, JSON.stringify(exported.manifest)],
      { stdio: 'pipe' },
    ),
  ).toThrow();
});
it('rejects unknown repositories, changed commits, credentials, unsafe branches and nonpristine metadata', async () => {
  const f = fixture();
  await expect(
    inspectLocalSource(f.repositories, { ...f.selection, repositoryId: '../other' }),
  ).rejects.toThrow();
  await expect(
    inspectLocalSource(f.repositories, { ...f.selection, featureBranch: '../escape' }),
  ).rejects.toThrow();
  const plan = await inspectLocalSource(f.repositories, f.selection);
  await expect(
    exportLocalSource(f.repositories, { ...plan, baseOid: 'a'.repeat(40) }),
  ).rejects.toThrow();
  f.git('remote', 'set-url', 'origin', 'https://secret@github.com/example/project.git');
  await expect(inspectLocalSource(f.repositories, f.selection)).rejects.toThrow();
});
