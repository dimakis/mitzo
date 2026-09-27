import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ARTIFACT_GIT_VERIFIER } from '../symposium-artifact-git-verifier.js';
import { ARTIFACT_GIT_EXPORT } from '../symposium-artifact-git-export.js';
import { SYMPOSIUM_ARTIFACT_TARGET } from '../symposium-artifact-lease.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sealed-git-export-'));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString();
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'remote.origin.url', 'https://github.com/example/repo.git');
  writeFileSync(join(root, 'base.txt'), 'BASE');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git('checkout', '-qb', 'feature');
  writeFileSync(join(root, 'feature.txt'), 'FEATURE');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'feature');
  const python = (code: string, args: string[]) =>
    JSON.parse(
      execFileSync(
        'python3',
        [
          '-I',
          '-c',
          code.replace(`root='${SYMPOSIUM_ARTIFACT_TARGET}'`, `root=${JSON.stringify(root)}`),
          '.',
          ...args,
        ],
        { stdio: 'pipe' },
      ).toString(),
    );
  const proof = python(ARTIFACT_GIT_VERIFIER, []);
  const run = (input: Record<string, unknown>) =>
    python(ARTIFACT_GIT_EXPORT, [
      JSON.stringify({ baseBranch: 'main', expected: proof, ...input }),
    ]);
  return { root, git, proof, run };
}
it('inspects the sealed branch and exports a bounded reconstructable bundle', () => {
  const f = fixture();
  expect(f.run({ kind: 'inspect' }).inspection).toMatchObject({
    sourceBranch: 'feature',
    sourceOid: f.proof.commit,
    defaultBranch: 'main',
    originUrl: 'https://github.com/example/repo.git',
    commitsAhead: 1,
    changedFiles: ['feature.txt'],
    status: 'clean',
    symlinkFree: true,
  });
  const exported = f.run({
    kind: 'bundle',
    sourceBranch: 'feature',
    sourceOid: f.proof.commit,
    maxBytes: 1048576,
  });
  const bundle = Buffer.from(exported.bundle, 'base64');
  expect(bundle.length).toBe(exported.bytes);
  const path = join(f.root, '.git', 'test-export.bundle');
  writeFileSync(path, bundle);
  try {
    expect(
      execFileSync('git', ['bundle', 'verify', path], { cwd: f.root, stdio: 'pipe' }).toString(),
    ).toContain('refs/heads/feature');
    expect(
      execFileSync('git', ['bundle', 'list-heads', path], { stdio: 'pipe' }).toString(),
    ).toContain(f.proof.commit);
  } finally {
    rmSync(path);
  }
});
it('rejects a bundle byte overflow and a different selected branch or commit', () => {
  const f = fixture();
  expect(() =>
    f.run({ kind: 'bundle', sourceBranch: 'feature', sourceOid: f.proof.commit, maxBytes: 16 }),
  ).toThrow();
  expect(() =>
    f.run({ kind: 'bundle', sourceBranch: 'other', sourceOid: f.proof.commit, maxBytes: 1048576 }),
  ).toThrow();
  expect(() =>
    f.run({
      kind: 'bundle',
      sourceBranch: 'feature',
      sourceOid: 'a'.repeat(40),
      maxBytes: 1048576,
    }),
  ).toThrow();
});
it('does not emit credential-bearing origin metadata or export dirty contents', () => {
  const f = fixture();
  f.git('config', 'remote.origin.url', 'https://example:synthetic-secret@github.com/example/repo');
  expect(() => f.run({ kind: 'inspect' })).toThrow();
  f.git('config', 'remote.origin.url', 'https://github.com/example/repo');
  writeFileSync(join(f.root, 'feature.txt'), 'dirty');
  expect(() =>
    f.run({
      kind: 'bundle',
      sourceBranch: 'feature',
      sourceOid: f.proof.commit,
      maxBytes: 1048576,
    }),
  ).toThrow();
});
