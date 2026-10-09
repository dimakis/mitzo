import process from 'node:process';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fingerprintDirectory } from '../../scripts/lib/staging-files.mjs';
import { verifyDependencySource } from '../../scripts/lib/staging-dependency-source.mjs';
const roots = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stage-deps-')));
  roots.push(root);
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  const lock = '{"locked":"source"}\n';
  writeFileSync(join(root, 'package-lock.json'), lock);
  git('add', '.');
  git('commit', '-qm', 'locked');
  git('remote', 'add', 'origin', 'https://github.com/dimakis/mitzo.git');
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules/installed.js'), 'audited package');
  return {
    root,
    git,
    target: git('rev-parse', 'HEAD'),
    lockSha256: createHash('sha256').update(lock).digest('hex'),
    fingerprint: fingerprintDirectory(root, 'node_modules'),
  };
}
it('accepts only the explicit dependency closure from the same clean published source and lock', () => {
  const f = fixture();
  expect(verifyDependencySource(f.root, f.target, f.lockSha256, f.fingerprint)).toBe(f.fingerprint);
});
it('refuses installed-package drift, lock substitution or a different source commit', () => {
  const f = fixture();
  expect(() =>
    verifyDependencySource(f.root, 'a'.repeat(40), f.lockSha256, f.fingerprint),
  ).toThrow();
  expect(() => verifyDependencySource(f.root, f.target, 'b'.repeat(64), f.fingerprint)).toThrow();
  writeFileSync(join(f.root, 'node_modules/installed.js'), 'changed');
  expect(() => verifyDependencySource(f.root, f.target, f.lockSha256, f.fingerprint)).toThrow();
});
it('refuses hidden source flags and unpublished origin before dependency copy', () => {
  const f = fixture();
  f.git('update-index', '--assume-unchanged', 'package-lock.json');
  expect(() => verifyDependencySource(f.root, f.target, f.lockSha256, f.fingerprint)).toThrow();
  const g = fixture();
  g.git('remote', 'set-url', 'origin', 'https://example.invalid/unreviewed');
  expect(() => verifyDependencySource(g.root, g.target, g.lockSha256, g.fingerprint)).toThrow();
});
