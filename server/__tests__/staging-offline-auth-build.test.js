import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildStagingOfflineAuthHelper } from '../../scripts/lib/staging-offline-auth-build.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
function fixture() {
  const controllerRoot = realpathSync(mkdtempSync(join(tmpdir(), 'auth-build-test-')));
  roots.push(controllerRoot);
  mkdirSync(join(controllerRoot, 'scripts/native'), { recursive: true });
  const source = 'synthetic Swift source; never authenticated';
  writeFileSync(join(controllerRoot, 'scripts/native/staging-operator-auth.swift'), source);
  const sourceCommit = 'a'.repeat(40);
  const assertQualifiedSource = vi.fn(() => undefined);
  const run = vi.fn((executable, args) => {
    if (executable === '/usr/bin/git') {
      if (args.includes('rev-parse')) return { status: 0, stdout: sourceCommit + '\n' };
      if (args.includes('show')) return { status: 0, stdout: source };
      return { status: 0, stdout: '' };
    }
    if (args.includes('--version')) return { status: 0, stdout: 'Apple Swift version 6.3\n' };
    writeFileSync(args[args.indexOf('-o') + 1], 'synthetic compiled bytes', { mode: 0o700 });
    return { status: 0, stdout: '' };
  });
  return { controllerRoot, sourceCommit, assertQualifiedSource, run, source };
}
it('enrolls only a qualified clean source build as included private controller artifacts', () => {
  const f = fixture();
  const receipt = buildStagingOfflineAuthHelper(f, { run: f.run });
  expect(f.assertQualifiedSource).toHaveBeenCalledTimes(2);
  expect(receipt.sourceSha256).toBe(createHash('sha256').update(f.source).digest('hex'));
  expect(receipt.compiledSha256).toBe(
    createHash('sha256').update('synthetic compiled bytes').digest('hex'),
  );
  expect(receipt.compiledPath).toBe('dist/staging-offline-operator-auth/helper');
  expect(receipt.fileIdentity.mode).toBe(0o500);
  expect(receipt.swiftVersion).toBe('Apple Swift version 6.3');
  expect(
    JSON.parse(
      readFileSync(join(f.controllerRoot, 'dist/staging-offline-operator-auth/build.json'), 'utf8'),
    ),
  ).toEqual(receipt);
  const compile = f.run.mock.calls.find(
    ([exe, args]) => exe === '/usr/bin/swiftc' && !args.includes('--version'),
  );
  expect(compile[2].env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'C' });
  expect(compile[1]).toContain('-module-cache-path');
  expect(
    f.run.mock.calls.every(([exe]) => exe === '/usr/bin/git' || exe === '/usr/bin/swiftc'),
  ).toBe(true);
});
it('refuses unqualified, dirty, wrong-commit or substituted source before compiling', () => {
  for (const mode of ['unqualified', 'dirty', 'commit', 'source']) {
    const f = fixture();
    if (mode === 'unqualified')
      f.assertQualifiedSource = () => {
        throw Error('unqualified');
      };
    const original = f.run;
    f.run = vi.fn((exe, args, options) => {
      if (exe === '/usr/bin/git') {
        if (mode === 'dirty' && args.includes('status'))
          return { status: 0, stdout: ' M scripts/native/staging-operator-auth.swift' };
        if (mode === 'commit' && args.includes('rev-parse'))
          return { status: 0, stdout: 'b'.repeat(40) };
        if (mode === 'source' && args.includes('show'))
          return { status: 0, stdout: 'substitution' };
      }
      return original(exe, args, options);
    });
    expect(() => buildStagingOfflineAuthHelper(f, { run: f.run })).toThrow();
    expect(f.run.mock.calls.some(([exe]) => exe === '/usr/bin/swiftc')).toBe(false);
  }
});
it('refuses failed compilation, post-build source drift and overwrite of an enrolled helper', () => {
  const f = fixture();
  buildStagingOfflineAuthHelper(f, { run: f.run });
  expect(() => buildStagingOfflineAuthHelper(f, { run: f.run })).toThrow();
  const failed = fixture();
  expect(() =>
    buildStagingOfflineAuthHelper(failed, {
      run: (exe, args, options) =>
        exe === '/usr/bin/swiftc' && !args.includes('--version')
          ? { status: 1, stderr: 'private diagnostic' }
          : failed.run(exe, args, options),
    }),
  ).toThrow(/build/i);
  const drift = fixture();
  drift.assertQualifiedSource = vi
    .fn()
    .mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => {
      throw Error('drift');
    });
  expect(() => buildStagingOfflineAuthHelper(drift, { run: drift.run })).toThrow();
});
it('records the installed Apple compiler driver banner before freezing the helper', () => {
  const f = fixture();
  const version =
    'swift-driver version: 1.168.6 Apple Swift version 6.4 (swiftlang-6.4.0.34.1 clang-2100.3.34.1)\nTarget: arm64-apple-macosx26.0';
  const run = (exe, args, options) =>
    args.includes('--version') ? { status: 0, stdout: version } : f.run(exe, args, options);
  expect(buildStagingOfflineAuthHelper(f, { run }).swiftVersion).toBe(version);
});
