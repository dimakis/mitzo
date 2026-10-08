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
import { ARTIFACT_GIT_VERIFIER_CORE } from '../symposium-artifact-git-verifier.js';
import { ARTIFACT_GIT_EXPORT } from '../symposium-artifact-git-export.js';
import { SYMPOSIUM_ARTIFACT_TARGET } from '../symposium-artifact-lease.js';
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
    git: {
      version: 1,
      commit: plan.baseOid,
      tree: plan.treeOid,
      entries: 2,
    },
  });
  expect(proof.git.committedTreeDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(proof.git.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
  const independentlyVerified = JSON.parse(
    execFileSync(
      'python3',
      [
        '-I',
        '-B',
        '-c',
        ARTIFACT_GIT_VERIFIER_CORE.replace(SYMPOSIUM_ARTIFACT_TARGET, target) +
          '\nprint(json.dumps(proof,sort_keys=True))\n',
        '.',
      ],
      { encoding: 'utf8' },
    ),
  );
  expect(proof.git).toEqual(independentlyVerified);
  const exportedInitial = JSON.parse(
    execFileSync(
      'python3',
      [
        '-I',
        '-B',
        '-c',
        ARTIFACT_GIT_EXPORT.replace(SYMPOSIUM_ARTIFACT_TARGET, target),
        '.',
        JSON.stringify({
          kind: 'successor',
          expected: proof.git,
          baseBranch: 'main',
          sourceBranch: 'symposium/change',
          sourceOid: plan.baseOid,
          maxBytes: 8 * 1024 * 1024,
        }),
      ],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    ),
  );
  expect(exportedInitial.proof).toEqual(proof.git);
  expect(exportedInitial.selection).toMatchObject({
    sourceOid: plan.baseOid,
    baseOid: plan.baseOid,
    sourceRef: 'refs/heads/symposium/change',
    baseRef: 'refs/remotes/origin/main',
  });
  expect(Buffer.from(exportedInitial.bundle, 'base64')).toHaveLength(exportedInitial.bytes);
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
it.each([
  'credential-path',
  'historical-secret',
  'submodule',
  'config-hook',
  'application_default_credentials.json',
  '.gitconfig',
  '.docker',
  '.kube',
])('rejects unsafe source history and never executes source configuration (%s)', async (mode) => {
  const f = fixture();
  if (mode === 'credential-path') {
    writeFileSync(join(f.repo, '.env'), 'DATABASE_PASSWORD=not-exportable');
    f.git('add', '.env');
    f.git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'private');
  }
  if (['application_default_credentials.json', '.gitconfig', '.docker', '.kube'].includes(mode)) {
    writeFileSync(
      join(f.repo, mode),
      '{"type":"authorized_user","refresh_token":"fixture-no-secret"}',
    );
    f.git('add', mode);
    f.git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'credential fixture');
  }
  if (mode === 'historical-secret') {
    writeFileSync(join(f.repo, 'old.txt'), '-----BEGIN PRIVATE KEY-----\nnot-for-export\n');
    f.git('add', '.');
    f.git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'secret');
    f.git('rm', 'old.txt');
    f.git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'remove');
  }
  if (mode === 'submodule') {
    f.git(
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${f.git('rev-parse', 'HEAD')},dependency`,
    );
    f.git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'gitlink');
  }
  if (mode === 'config-hook') {
    f.git('config', 'core.fsmonitor', `touch ${f.root}/executed`);
    f.git('config', 'uploadpack.packObjectsHook', `touch ${f.root}/executed`);
    f.git('config', 'filter.danger.clean', `touch ${f.root}/executed`);
    f.git('config', 'url.https://invalid.example/.insteadOf', 'https://github.com/');
  }
  f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const plan = await inspectLocalSource(f.repositories, f.selection);
  if (mode === 'config-hook') {
    await exportLocalSource(f.repositories, plan);
    expect(existsSync(join(f.root, 'executed'))).toBe(false);
  } else await expect(exportLocalSource(f.repositories, plan)).rejects.toThrow();
});

it.each(['include', 'hook', 'object', 'oversized', 'digest'])(
  'rejects altered pristine Git or bundle before materialization (%s)',
  async (mode) => {
    const f = fixture(),
      plan = await inspectLocalSource(f.repositories, f.selection),
      exported = await exportLocalSource(f.repositories, plan);
    const target = join(f.root, 'target'),
      bundle = join(f.root, 'source.bundle');
    mkdirSync(target);
    execFileSync('git', ['init', '--quiet', '--template=', '--initial-branch=main', target]);
    writeFileSync(bundle, exported.bundle);
    if (mode === 'include')
      writeFileSync(
        join(target, '.git/config'),
        readFileSync(join(target, '.git/config'), 'utf8') +
          '\n[include]\npath = /private/forbidden\n',
      );
    if (mode === 'hook') {
      mkdirSync(join(target, '.git/hooks'));
      writeFileSync(join(target, '.git/hooks/post-checkout'), 'exit 0');
    }
    if (mode === 'object')
      writeFileSync(join(target, '.git/objects/info/alternates'), '/private/forbidden');
    const manifest = { ...exported.manifest };
    if (mode === 'oversized') manifest.bundleBytes = 8388609;
    if (mode === 'digest') manifest.bundleSha256 = '0'.repeat(64);
    const config = readFileSync(join(target, '.git/config'), 'utf8');
    expect(() =>
      execFileSync(
        'python3',
        ['-I', '-B', '-c', SOURCE_GIT_IMPORTER, target, bundle, JSON.stringify(manifest)],
        { stdio: 'pipe' },
      ),
    ).toThrow();
    expect(existsSync(join(target, 'first.txt'))).toBe(false);
    expect(readFileSync(join(target, '.git/config'), 'utf8')).toBe(config);
  },
);

it.each([
  'topic/',
  'HEAD',
  'topic/.hidden',
  'topic/ends.',
  'topic/part.lock',
  'topic//part',
  'topic@{1}',
])('rejects Git-invalid selected feature before export (%s)', async (featureBranch) => {
  const f = fixture();
  await expect(
    inspectLocalSource(f.repositories, { ...f.selection, featureBranch }),
  ).rejects.toThrow();
});
