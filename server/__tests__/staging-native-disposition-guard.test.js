import { afterEach, expect, it, vi } from 'vitest';
import process from 'node:process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const home = vi.hoisted(() => `/private/tmp/mitzo-new-guard-${globalThis.process.pid}`);
vi.mock('node:os', () => ({ homedir: () => home }));
import { createContainedNativeGuard } from '../../scripts/lib/staging-native-disposition-guard.mjs';
const root = join(home, '.local/share/mitzo-staging'),
  allocation = '22222222-2222-4222-8222-222222222222';
afterEach(() => rmSync(home, { recursive: true, force: true }));
function fixture() {
  mkdirSync(join(root, 'service'), { recursive: true, mode: 0o700 });
  const sourceCommit = 'a'.repeat(40),
    sourceRoot = join(root, 'releases', sourceCommit.slice(0, 12));
  const identity = {
    pid: process.pid,
    birth: 'exact original launcher birth',
    sourceRoot,
    registrationSha256: 'b'.repeat(64),
  };
  const verifyRegisteredLauncher = vi.fn(() => identity);
  const guard = createContainedNativeGuard({
    root,
    allocation,
    planSha256: 'c'.repeat(64),
    sourceCommit,
    sourceRoot,
    verifyRegisteredLauncher,
  });
  return { guard, identity, verifyRegisteredLauncher, path: join(root, 'service/deployment.lock') };
}
it('acquires its own new original guard and never adopts an existing recovery/foreign lock', () => {
  const f = fixture();
  writeFileSync(f.path, 'retained foreign guard', { mode: 0o600 });
  expect(() => f.guard.acquire()).toThrow();
  expect(readFileSync(f.path, 'utf8')).toBe('retained foreign guard');
});
it('refuses unqualified registered identity before writing a guard', () => {
  const f = fixture();
  f.verifyRegisteredLauncher.mockReturnValue({ ...f.identity, pid: 1 });
  expect(() => f.guard.acquire()).toThrow();
  expect(existsSync(f.path)).toBe(false);
});
it('binds original inode, bytes and actual launcher birth without a serialized capability', () => {
  const f = fixture();
  f.guard.acquire();
  f.guard.assertCurrent();
  expect(JSON.parse(JSON.stringify(f.guard))).toEqual({});
  const body = readFileSync(f.path);
  renameSync(f.path, f.path + '.original');
  writeFileSync(f.path, body, { mode: 0o600 });
  expect(() => f.guard.assertCurrent()).toThrow();
  f.guard.retain();
  expect(existsSync(f.path)).toBe(true);
});
it('requires fresh physical/native verification and preserves the guard after failed completion', async () => {
  const f = fixture();
  f.guard.acquire();
  const failed = vi.fn(async () => {
    throw Error('fresh native proof missing');
  });
  await expect(f.guard.completeNative(failed)).rejects.toThrow();
  expect(existsSync(f.path)).toBe(true);
  await expect(f.guard.completeNative(async () => ({}))).rejects.toThrow();
  f.guard.retain();
});
it('rechecks source identity before release and refuses app/native proof for another allocation', async () => {
  const f = fixture();
  f.guard.acquire();
  await expect(
    f.guard.completeNative(async () => ({
      allocation: 'other',
      sourceCommit: 'a'.repeat(40),
      parentPid: process.pid,
      parentBirth: f.identity.birth,
    })),
  ).rejects.toThrow();
  expect(existsSync(f.path)).toBe(true);
  f.guard.retain();
});
it('releases only its matching original new guard after complete fresh owner proof and retains a separate completion record', async () => {
  const f = fixture();
  f.guard.acquire();
  const proof = {
    allocation,
    sourceCommit: 'a'.repeat(40),
    parentPid: process.pid,
    parentBirth: f.identity.birth,
    instanceId: '33333333-3333-4333-8333-333333333333',
    epoch: 1,
    appPid: process.pid + 1,
    appBirth: 'synthetic exact child birth',
    vmObservationSha256: 'd'.repeat(64),
    archiveProofSha256: 'e'.repeat(64),
  };
  await f.guard.completeNative(async () => proof);
  expect(existsSync(f.path)).toBe(false);
  const completed = JSON.parse(
    readFileSync(
      join(root, 'service/native-dispositions', allocation, 'launcher-completed.json'),
      'utf8',
    ),
  );
  expect(completed.proof).toEqual(proof);
  expect(completed.nativeCleanupConfirmed).toBe(false);
  expect(() => f.guard.assertCurrent()).toThrow();
});
