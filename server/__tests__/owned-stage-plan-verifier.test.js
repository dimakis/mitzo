import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { qualifyCompletedPlanVerifier } from '../../scripts/lib/owned-stage-plan-verifier.mjs';
import { hash, bytes } from '../../scripts/lib/staging-cold-audit.mjs';
import { artifacts, fingerprintDirectory } from '../../scripts/lib/staging-files.mjs';
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(unrelated = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'owned-plan-verifier-')));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo, { mode: 0o700 });
  const git = (cwd, ...args) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git(repo, 'init');
  git(repo, 'config', 'user.name', 'Offline fixture');
  git(repo, 'config', 'user.email', 'fixture@example.test');
  writeFileSync(join(repo, 'marker'), 'original');
  git(repo, 'add', 'marker');
  git(repo, 'commit', '-m', 'fixture original');
  const old = git(repo, 'rev-parse', 'HEAD');
  if (unrelated) git(repo, 'checkout', '--orphan', 'unrelated');
  writeFileSync(join(repo, 'marker'), 'current');
  git(repo, 'add', 'marker');
  git(repo, 'commit', '-m', 'fixture current');
  const current = git(repo, 'rev-parse', 'HEAD');
  mkdirSync(join(root, 'releases'), { mode: 0o700 });
  const prepare = (sha) => {
    const source = join(root, 'releases', sha.slice(0, 12));
    git(repo, 'clone', '--no-hardlinks', repo, source);
    git(source, 'checkout', '--detach', sha);
    git(source, 'remote', 'set-url', 'origin', 'https://github.com/dimakis/mitzo.git');
    for (const dir of [
      'node_modules',
      'dist',
      'frontend/dist',
      'packages/protocol/dist',
      'packages/harness/dist',
      'packages/client/dist',
    ])
      mkdirSync(join(source, dir), { recursive: true, mode: 0o700 });
    writeFileSync(join(source, 'dist', 'build.js'), 'fixture artifact', { mode: 0o600 });
    const receipt = {
      sourceCommit: sha,
      sourceTree: git(source, 'rev-parse', 'HEAD^{tree}'),
      compiledArtifacts: artifacts(source),
      dependencyFingerprint: fingerprintDirectory(source, 'node_modules'),
    };
    writeFileSync(join(source, 'staging-release.json'), JSON.stringify(receipt) + '\n', {
      mode: 0o600,
    });
    return {
      controllerSource: sha,
      controllerReceiptSha256: hash(bytes(join(source, 'staging-release.json'))),
    };
  };
  const original = prepare(old),
    verifier = prepare(current);
  return { root, original, verifier, current };
}
it('qualifies a newer accepted prepared verifier through actual Git ancestry and immutable original prepared receipt', () => {
  const f = fixture();
  const result = qualifyCompletedPlanVerifier(f.root, f.original, f.verifier, () => f.current);
  expect(result.originalControllerSource).toBe(f.original.controllerSource);
  expect(result.verifierSource).toBe(f.current);
});
it.each([
  'unaccepted',
  'unrelated',
  'receipt-drift',
  'unknown-schema',
  'replace-ref',
  'missing-receipt',
  'compiled-drift',
  'dependency-drift',
])('rejects %s metadata verifier without substituting original authority', (failure) => {
  const f = fixture(failure === 'unrelated');
  if (failure === 'receipt-drift')
    writeFileSync(
      join(f.root, 'releases', f.original.controllerSource.slice(0, 12), 'staging-release.json'),
      '{}\n',
    );
  const originalPath = join(f.root, 'releases', f.original.controllerSource.slice(0, 12));
  const currentPath = join(f.root, 'releases', f.verifier.controllerSource.slice(0, 12));
  if (failure === 'replace-ref')
    execFileSync('git', ['-C', currentPath, 'replace', f.original.controllerSource, f.current]);
  if (failure === 'missing-receipt') rmSync(join(originalPath, 'staging-release.json'));
  if (failure === 'compiled-drift')
    writeFileSync(join(originalPath, 'dist/build.js'), 'changed build');
  if (failure === 'dependency-drift')
    writeFileSync(join(originalPath, 'node_modules/extra'), 'changed dependency');
  const original = failure === 'unknown-schema' ? { ...f.original, override: true } : f.original;
  expect(() =>
    qualifyCompletedPlanVerifier(f.root, original, f.verifier, () =>
      failure === 'unaccepted' ? '0'.repeat(40) : f.current,
    ),
  ).toThrow();
});
