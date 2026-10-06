import { describe, expect, it, vi } from 'vitest';
import {
  stagingBoundary,
  compareStage,
  promoteStage,
} from '../../scripts/lib/staging-operations.mjs';
const oldSha = 'a'.repeat(40),
  nextSha = 'b'.repeat(40);
function fixture(overrides = {}) {
  const context = {
    root: '/private/stage',
    label: 'com.mitzo.staging',
    port: 3190,
    workspace: '/private/stage/workspace',
    release: '/private/stage/releases/' + oldSha.slice(0, 12),
    sourceCommit: oldSha,
    ...overrides,
  };
  return context;
}
it.each([
  { label: 'com.mitzo.server' },
  { port: 3100 },
  { port: 3101 },
  { workspace: '/private/production' },
  { release: '/private/production' },
  { sourceCommit: 'main' },
])('refuses unsafe staging boundaries %j', (patch) =>
  expect(() => stagingBoundary(fixture(patch))).toThrow(),
);
it('accepts only the canonical stage label and contained immutable release', () =>
  expect(stagingBoundary(fixture())).toBeUndefined());
it('reports newer main and source, artifact, dependency or runtime mismatch separately', () => {
  expect(
    compareStage({
      expected: oldSha,
      main: nextSha,
      source: oldSha,
      artifacts: true,
      dependencies: true,
      runtime: true,
    }),
  ).toEqual({ safe: true, stale: true, issues: [] });
  expect(
    compareStage({
      expected: oldSha,
      main: oldSha,
      source: nextSha,
      artifacts: false,
      dependencies: false,
      runtime: false,
    }),
  ).toEqual({
    safe: false,
    stale: false,
    issues: ['source', 'artifacts', 'dependencies', 'runtime'],
  });
});
function ops() {
  const trace = [];
  const add = (name, result) =>
    vi.fn(async () => {
      trace.push(name);
      return result;
    });
  return {
    trace,
    lock: add('lock'),
    unlock: add('unlock'),
    audit: add('audit'),
    validate: add('validate'),
    current: add('current', oldSha),
    stop: add('stop'),
    snapshot: add('snapshot'),
    activate: add('activate'),
    start: add('start'),
    verify: add('verify'),
  };
}
it('validates and fences before stop, preserves state before activation, and verifies before success', async () => {
  const effects = ops();
  await promoteStage({ expectedCurrent: oldSha, target: nextSha }, effects);
  expect(effects.trace).toEqual([
    'lock',
    'audit',
    'validate',
    'current',
    'stop',
    'snapshot',
    'activate',
    'start',
    'verify',
    'audit',
    'unlock',
  ]);
});
it('refuses a stale expected-current value before stopping', async () => {
  const effects = ops();
  await expect(
    promoteStage({ expectedCurrent: nextSha, target: nextSha }, effects),
  ).rejects.toThrow('changed');
  expect(effects.stop).not.toHaveBeenCalled();
  expect(effects.unlock).toHaveBeenCalledOnce();
});
it('refuses a non-exact source selector before acquiring control', async () => {
  const effects = ops();
  await expect(
    promoteStage({ expectedCurrent: oldSha, target: 'main' }, effects),
  ).rejects.toThrow();
  expect(effects.lock).not.toHaveBeenCalled();
});
it.each(['validate', 'stop', 'snapshot', 'activate', 'start', 'verify'])(
  'retains uncertainty and avoids rollback or second starts when %s fails',
  async (step) => {
    const effects = ops();
    effects[step].mockRejectedValue(new Error('uncertain'));
    await expect(
      promoteStage({ expectedCurrent: oldSha, target: nextSha }, effects),
    ).rejects.toThrow('uncertain');
    if (step === 'validate') expect(effects.stop).not.toHaveBeenCalled();
    if (step === 'stop') {
      expect(effects.snapshot).not.toHaveBeenCalled();
      expect(effects.start).not.toHaveBeenCalled();
    }
    if (step === 'snapshot') expect(effects.activate).not.toHaveBeenCalled();
    expect(effects.start.mock.calls.length).toBeLessThanOrEqual(1);
    expect(effects.unlock).toHaveBeenCalledTimes(step === 'validate' ? 1 : 0);
  },
);
it('does not release another deployment lock when lock acquisition fails', async () => {
  const effects = ops();
  effects.lock.mockRejectedValue(new Error('busy'));
  await expect(promoteStage({ expectedCurrent: oldSha, target: nextSha }, effects)).rejects.toThrow(
    'busy',
  );
  expect(effects.unlock).not.toHaveBeenCalled();
});

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintDirectory } from '../../scripts/lib/staging-files.mjs';
it('fingerprints dependency content and symlink text without following outside the release', () => {
  const root = mkdtempSync(join(tmpdir(), 'stage-fingerprint-'));
  try {
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'entry'), 'one');
    const first = fingerprintDirectory(root, 'node_modules');
    writeFileSync(join(root, 'node_modules', 'entry'), 'two');
    expect(fingerprintDirectory(root, 'node_modules')).not.toBe(first);
    symlinkSync('/usr/bin', join(root, 'node_modules', 'outside'));
    expect(() => fingerprintDirectory(root, 'node_modules')).toThrow('escaped');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
