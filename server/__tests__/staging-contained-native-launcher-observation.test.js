import { expect, it } from 'vitest';
import process from 'node:process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createContainedNativeLauncherPlist,
  assertContainedNativeLauncherObservation,
} from '../../scripts/lib/staging-contained-native-launcher-observation.mjs';
const root = join(homedir(), '.local/share/mitzo-staging');
const spec = {
  root,
  allocation: '22222222-2222-4222-8222-222222222222',
  sourceCommit: 'a'.repeat(40),
  sourceRoot: join(root, 'releases', 'a'.repeat(12)),
  node: process.execPath,
  bootstrapSha256: 'b'.repeat(64),
};
function fixture() {
  const expected = createContainedNativeLauncherPlist(spec);
  const observation = {
    pid: process.pid,
    birth: 'actual self birth',
    cwd: spec.sourceRoot,
    parentPid: 1,
    plist: globalThis.structuredClone(expected.fields),
    plistSha256: expected.sha256,
    bootstrapSha256: spec.bootstrapSha256,
    job: {
      path: join(root, 'service/com.mitzo.staging.plist'),
      pid: process.pid,
      runs: 1,
      state: 'running',
    },
  };
  return { expected, observation };
}
it('derives only one canonical registered launcher and binds actual PID/birth/first-run/source/working-directory observations', () => {
  const f = fixture();
  expect(assertContainedNativeLauncherObservation(f.expected, f.observation)).toEqual({
    pid: process.pid,
    birth: 'actual self birth',
    sourceRoot: spec.sourceRoot,
    registrationSha256: f.expected.sha256,
  });
  expect(f.expected.fields.KeepAlive).toBe(false);
  expect(f.expected.fields.RunAtLoad).toBe(false);
  expect(f.expected.fields.ProgramArguments).toContain(
    join(spec.sourceRoot, 'scripts/start-contained-native-staging.mjs'),
  );
});
it.each(['pid', 'birth', 'cwd', 'parentPid', 'plistSha256', 'bootstrapSha256'])(
  'rejects %s drift without deriving authority from a label',
  (field) => {
    const f = fixture();
    expect(() =>
      assertContainedNativeLauncherObservation(f.expected, {
        ...f.observation,
        [field]: field === 'birth' ? '' : 'other',
      }),
    ).toThrow();
  },
);
it('rejects resumed/foreign launchd identities, modified argv/environment and noncanonical allocation roots', () => {
  for (const mutate of [
    (o) => (o.job.runs = 2),
    (o) => (o.job.pid = 1),
    (o) => (o.plist.ProgramArguments[1] = '/other/source.mjs'),
    (o) => (o.plist.EnvironmentVariables.NODE_OPTIONS = '--require=/foreign/code.js'),
  ]) {
    const f = fixture();
    mutate(f.observation);
    expect(() => assertContainedNativeLauncherObservation(f.expected, f.observation)).toThrow();
  }
  expect(() => createContainedNativeLauncherPlist({ ...spec, root: '/other/stage' })).toThrow();
});
