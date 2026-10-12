import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildStagingVmPeerHelper } from '../../scripts/lib/staging-vm-peer-build.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
function fixture() {
  const controllerRoot = realpathSync(mkdtempSync(join(tmpdir(), 'auth-build-test-')));
  roots.push(controllerRoot);
  mkdirSync(join(controllerRoot, 'scripts/native'), { recursive: true });
  const source = 'synthetic Swift source; never authenticated';
  writeFileSync(join(controllerRoot, 'scripts/native/staging-vm-peer.c'), source);
  const sourceCommit = 'a'.repeat(40);
  const assertQualifiedSource = vi.fn(() => undefined);
  const run = vi.fn((executable, args) => {
    if (executable === '/usr/bin/git') {
      if (args.includes('rev-parse')) return { status: 0, stdout: sourceCommit + '\n' };
      if (args.includes('show')) return { status: 0, stdout: source };
      return { status: 0, stdout: '' };
    }
    if (args.includes('--version')) return { status: 0, stdout: 'Apple clang version 17.0.0\n' };
    writeFileSync(args[args.indexOf('-o') + 1], 'synthetic compiled bytes', { mode: 0o700 });
    return { status: 0, stdout: '' };
  });
  return { controllerRoot, sourceCommit, assertQualifiedSource, run, source };
}
it('enrolls only a qualified clean source build as included private controller artifacts', () => {
  const f = fixture();
  const receipt = buildStagingVmPeerHelper(f, { run: f.run });
  expect(f.assertQualifiedSource).toHaveBeenCalledTimes(2);
  expect(receipt.sourceSha256).toBe(createHash('sha256').update(f.source).digest('hex'));
  expect(receipt.compiledSha256).toBe(
    createHash('sha256').update('synthetic compiled bytes').digest('hex'),
  );
  expect(receipt.compiledPath).toBe('dist/staging-vm-peer/helper');
  expect(receipt.fileIdentity.mode).toBe(0o500);
  expect(receipt.clangVersion).toBe('Apple clang version 17.0.0');
  expect(
    JSON.parse(readFileSync(join(f.controllerRoot, 'dist/staging-vm-peer/build.json'), 'utf8')),
  ).toEqual(receipt);
  const compile = f.run.mock.calls.find(
    ([exe, args]) => exe === '/usr/bin/clang' && !args.includes('--version'),
  );
  expect(compile[2].env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'C' });
  expect(compile[1]).toContain('-Werror');
  expect(compile[1]).not.toContain('-module-cache-path');
  expect(
    f.run.mock.calls.every(([exe]) => exe === '/usr/bin/git' || exe === '/usr/bin/clang'),
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
          return { status: 0, stdout: ' M scripts/native/staging-vm-peer.c' };
        if (mode === 'commit' && args.includes('rev-parse'))
          return { status: 0, stdout: 'b'.repeat(40) };
        if (mode === 'source' && args.includes('show'))
          return { status: 0, stdout: 'substitution' };
      }
      return original(exe, args, options);
    });
    expect(() => buildStagingVmPeerHelper(f, { run: f.run })).toThrow();
    expect(f.run.mock.calls.some(([exe]) => exe === '/usr/bin/clang')).toBe(false);
  }
});
it('refuses failed compilation, post-build source drift and overwrite of an enrolled helper', () => {
  const f = fixture();
  buildStagingVmPeerHelper(f, { run: f.run });
  expect(() => buildStagingVmPeerHelper(f, { run: f.run })).toThrow();
  const failed = fixture();
  expect(() =>
    buildStagingVmPeerHelper(failed, {
      run: (exe, args, options) =>
        exe === '/usr/bin/clang' && !args.includes('--version')
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
  expect(() => buildStagingVmPeerHelper(drift, { run: drift.run })).toThrow();
});
it('records the installed Apple clang target banner before sealing the helper', () => {
  const f = fixture(),
    version =
      'Apple clang version 17.0.0 (clang-1700.0.0)\nTarget: arm64-apple-darwin26.0.0\nThread model: posix\nInstalledDir: /usr/bin';
  const run = (exe, args, options) =>
    args.includes('--version') ? { status: 0, stdout: version } : f.run(exe, args, options);
  expect(buildStagingVmPeerHelper(f, { run }).clangVersion).toBe(version);
});
