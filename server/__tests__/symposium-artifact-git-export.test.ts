import { ARTIFACT_GIT_SUCCESSOR_IMPORT } from '../symposium-artifact-git-successor-import.js';
import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ARTIFACT_GIT_VERIFIER } from '../symposium-artifact-git-verifier.js';
import {
  ARTIFACT_GIT_EXPORT,
  ARTIFACT_INSPECTION_MAX_OUTPUT_BYTES,
} from '../symposium-artifact-git-export.js';
import { SYMPOSIUM_ARTIFACT_TARGET } from '../symposium-artifact-lease.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(populate?: (root: string) => void) {
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
  populate?.(root);
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
        { stdio: 'pipe', maxBuffer: ARTIFACT_INSPECTION_MAX_OUTPUT_BYTES },
      ).toString(),
    );
  const proof = python(ARTIFACT_GIT_VERIFIER, []);
  const run = (input: Record<string, unknown>) =>
    python(ARTIFACT_GIT_EXPORT, [
      JSON.stringify({ baseBranch: 'main', expected: proof, ...input }),
    ]);
  return {
    root,
    git,
    proof,
    run,
    refreshProof: () => Object.assign(proof, python(ARTIFACT_GIT_VERIFIER, [])),
  };
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
it('exports selected successor refs without prerequisites into a fresh repository', () => {
  const f = fixture();
  f.git('branch', 'unselected-history');
  const exported = f.run({
    kind: 'successor',
    sourceBranch: 'feature',
    sourceOid: f.proof.commit,
    maxBytes: 1048576,
  });
  const child = mkdtempSync(join(tmpdir(), 'successor-git-export-'));
  roots.push(child);
  execFileSync('git', ['init', '-q', child]);
  const bundle = join(child, 'parent.bundle');
  writeFileSync(bundle, Buffer.from(exported.bundle, 'base64'));
  execFileSync('git', ['bundle', 'verify', bundle], { cwd: child, stdio: 'pipe' });
  const refs = execFileSync('git', ['bundle', 'list-heads', bundle], { stdio: 'pipe' }).toString();
  expect(refs.trim().split('\n').sort()).toEqual(
    [
      `${f.proof.commit} refs/heads/feature`,
      `${f.git('rev-parse', 'refs/remotes/origin/main').trim()} refs/remotes/origin/main`,
    ].sort(),
  );
  expect(exported.selection).toEqual({
    sourceRef: 'refs/heads/feature',
    sourceOid: f.proof.commit,
    baseRef: 'refs/remotes/origin/main',
    baseOid: f.git('rev-parse', 'refs/remotes/origin/main').trim(),
    defaultBranch: 'main',
    originUrl: 'https://github.com/example/repo.git',
  });
});
it('rejects a missing successor base ref', () => {
  const f = fixture();
  f.git('update-ref', '-d', 'refs/remotes/origin/main');
  expect(() =>
    f.run({
      kind: 'successor',
      sourceBranch: 'feature',
      sourceOid: f.proof.commit,
      maxBytes: 1048576,
    }),
  ).toThrow();
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

it('transports a real Git inspection with long Unicode paths and JSON expansion', () => {
  const paths = Array.from(
    { length: 499 },
    (_, i) => `${'é'.repeat(60)}/${'é'.repeat(60)}/${i}${'é'.repeat(60)}`,
  );
  const f = fixture((root) => {
    mkdirSync(join(root, 'é'.repeat(60), 'é'.repeat(60)), { recursive: true });
    for (const path of paths) writeFileSync(join(root, path), 'x');
  });
  const result = f.run({ kind: 'inspect' });
  expect(result.inspection.changedFiles).toHaveLength(500);
  expect(result.inspection.changedFiles).toContain(paths[498]);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(128 * 1024);
}, 60_000);

it('includes paths changed then deleted or reverted across every exported commit', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'temporary.txt'), 'temporary');
  writeFileSync(join(f.root, 'base.txt'), 'changed then reverted');
  f.git('add', '.');
  f.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'intermediate');
  rmSync(join(f.root, 'temporary.txt'));
  writeFileSync(join(f.root, 'base.txt'), 'BASE');
  f.git('add', '.');
  f.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'restore');
  f.refreshProof();
  expect(f.run({ kind: 'inspect' }).inspection.changedFiles).toEqual([
    'base.txt',
    'feature.txt',
    'temporary.txt',
  ]);
});

it('bounds historical path bytes even when the final sealed tree is small', () => {
  const f = fixture();
  const dir = join(f.root, 'é'.repeat(60), 'é'.repeat(60));
  mkdirSync(dir, { recursive: true });
  const names = Array.from({ length: 499 }, (_, i) => `${i}${'é'.repeat(60)}`);
  for (let round = 0; round < 3; round++) {
    for (const name of names) writeFileSync(join(dir, name), 'temporary');
    f.git('add', '.');
    f.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'historical paths');
    for (const name of names) rmSync(join(dir, name));
    f.git('add', '.');
    f.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'remove historical paths');
  }
  f.refreshProof();
  expect(f.proof.entries).toBe(2);
  expect(() => f.run({ kind: 'inspect' })).toThrow(/history path byte bound/);
}, 60_000);

it('imports the exact successor bundle into an empty child without changing its parent', () => {
  const f = fixture();
  const value = f.run({
    kind: 'successor',
    sourceBranch: 'feature',
    sourceOid: f.proof.commit,
    maxBytes: 1048576,
  });
  const child = mkdtempSync(join(tmpdir(), 'successor-import-'));
  roots.push(child);
  const run = (bundle: Buffer) =>
    JSON.parse(
      execFileSync(
        'python3',
        [
          '-I',
          '-c',
          ARTIFACT_GIT_SUCCESSOR_IMPORT.replaceAll(
            `root='${SYMPOSIUM_ARTIFACT_TARGET}'`,
            `root=${JSON.stringify(child)}`,
          ),
          '.',
          JSON.stringify({
            expected: f.proof,
            selection: value.selection,
            bundleSha256: value.bundleSha256,
            bytes: value.bytes,
          }),
        ],
        { input: bundle, stdio: 'pipe', timeout: 50000 },
      ).toString(),
    );
  const bundle = Buffer.from(value.bundle, 'base64');
  expect(() => run(Buffer.from('substitute'))).toThrow();
  expect(run(bundle)).toEqual(f.proof);
  expect(f.refreshProof()).toEqual(f.proof);
  expect(() => run(bundle)).toThrow();
  expect(
    execFileSync('git', ['-C', child, 'config', '--get', 'remote.origin.url']).toString().trim(),
  ).toBe(value.selection.originUrl);
});
