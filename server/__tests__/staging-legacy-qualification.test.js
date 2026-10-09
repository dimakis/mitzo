import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { artifacts } from '../../scripts/lib/staging-files.mjs';
import {
  auditLegacyClosure,
  fingerprintLegacyDirectory,
} from '../../scripts/lib/staging-legacy.mjs';
import { assertStageRegistration } from '../../scripts/lib/staging-registration.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stage-legacy-')));
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
  for (const name of [
    'node_modules/pkg',
    'dist',
    'frontend/dist',
    'packages/protocol/dist',
    'packages/harness/dist',
    'packages/client/dist',
  ])
    mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, 'packages/protocol/index.js'), 'export const original=1;');
  writeFileSync(join(root, 'node_modules/pkg/index.js'), 'dependency');
  writeFileSync(join(root, 'packages/protocol/dist/index.js'), 'compiled');
  writeFileSync(join(root, '.gitignore'), 'node_modules\n**/dist\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  symlinkSync('../packages/protocol', join(root, 'node_modules/protocol'));
  const r = {
    sourceCommit: git('rev-parse', 'HEAD'),
    sourceTree: git('rev-parse', 'HEAD^{tree}'),
    compiledArtifacts: artifacts(root),
    dependencyFingerprint: fingerprintLegacyDirectory(root, 'node_modules'),
  };
  return { root, r, git };
}
it('accounts for every omitted workspace payload using published source or the original compiled receipt', () => {
  const f = fixture(),
    result = auditLegacyClosure(f.root, f.r);
  expect(result.coverage).toEqual({ tracked: 1, artifacts: 1 });
  expect(result.legacyFingerprint).toBe(f.r.dependencyFingerprint);
  expect(result.closureFingerprint).not.toBe(f.r.dependencyFingerprint);
});
it('refuses ignored executable content that the legacy receipt never covered', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'packages/protocol/dist/unrecorded.js'), 'extra');
  expect(() => auditLegacyClosure(f.root, f.r)).toThrow();
});
it('refuses linked source drift even though the old fingerprint stays unchanged', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'packages/protocol/index.js'), 'changed');
  expect(fingerprintLegacyDirectory(f.root, 'node_modules')).toBe(f.r.dependencyFingerprint);
  expect(() => auditLegacyClosure(f.root, f.r)).toThrow();
});
it('refuses dependency drift, artifact drift and unexpected linked directories', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'node_modules/pkg/index.js'), 'changed');
  expect(() => auditLegacyClosure(f.root, f.r)).toThrow();
  const g = fixture();
  writeFileSync(join(g.root, 'packages/protocol/dist/index.js'), 'changed');
  expect(() => auditLegacyClosure(g.root, g.r)).toThrow();
  const h = fixture();
  mkdirSync(join(h.root, 'ignored'));
  symlinkSync('../ignored', join(h.root, 'node_modules/unknown'));
  h.r.dependencyFingerprint = fingerprintLegacyDirectory(h.root, 'node_modules');
  expect(() => auditLegacyClosure(h.root, h.r)).toThrow();
});
it('does not requalify a v2 receipt or source with hidden index flags', () => {
  const f = fixture();
  f.git('update-index', '--assume-unchanged', 'packages/protocol/index.js');
  expect(() => auditLegacyClosure(f.root, f.r)).toThrow();
});
function registration() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stage-registration-')));
  roots.push(root);
  const canonical = join(root, 'service.plist'),
    legacy = join(root, 'legacy.plist');
  writeFileSync(canonical, 'original', { mode: 0o600 });
  writeFileSync(legacy, 'original', { mode: 0o600 });
  return { canonical, legacy };
}
it('requires an exact separately qualified legacy registration and original process', () => {
  const f = registration();
  expect(() =>
    assertStageRegistration({ ...f, registered: f.legacy, pid: 42, birth: 'original' }),
  ).toThrow();
  const q = {
    legacyRegistration: { path: f.legacy, sha256: 'not-a-proof' },
    original: { pid: 42, birth: 'original' },
  };
  expect(() =>
    assertStageRegistration({
      ...f,
      registered: f.legacy,
      pid: 42,
      birth: 'original',
      qualification: q,
    }),
  ).toThrow();
});
it('accepts the canonical registration without inventing a legacy qualification', () => {
  const f = registration();
  expect(
    assertStageRegistration({ ...f, registered: f.canonical, pid: 42, birth: 'original' }),
  ).toBe('canonical');
});
it('accepts only unchanged qualified bytes and the original live process', () => {
  const f = registration();
  const q = {
    legacyRegistration: {
      path: f.legacy,
      sha256: createHash('sha256').update('original').digest('hex'),
    },
    original: { pid: 42, birth: 'original' },
  };
  expect(
    assertStageRegistration({
      ...f,
      registered: f.legacy,
      pid: 42,
      birth: 'original',
      qualification: q,
    }),
  ).toBe('qualified-legacy');
  expect(() =>
    assertStageRegistration({
      ...f,
      registered: f.legacy,
      pid: 42,
      birth: 'successor',
      qualification: q,
    }),
  ).toThrow();
  writeFileSync(f.legacy, 'changed');
  expect(() =>
    assertStageRegistration({
      ...f,
      registered: f.legacy,
      pid: 42,
      birth: 'original',
      qualification: q,
    }),
  ).toThrow();
});
it('never accepts an unrelated loaded plist or an aliased legacy file', () => {
  const f = registration();
  expect(() => assertStageRegistration({ ...f, registered: '/production.plist' })).toThrow();
  rmSync(f.legacy);
  symlinkSync(f.canonical, f.legacy);
  expect(() =>
    assertStageRegistration({ ...f, registered: f.legacy, qualification: {} }),
  ).toThrow();
});
import process from 'node:process';
