import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  chmodSync,
  realpathSync,
  linkSync,
  symlinkSync,
  renameSync,
  openSync,
  closeSync,
  fstatSync,
} from 'node:fs';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { createStagingOfflineOperatorAuthorizer as createAuthorizer } from '../../scripts/lib/staging-offline-operator-auth.mjs';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, openSync: vi.fn(actual.openSync), closeSync: vi.fn(actual.closeSync) };
});
const factories = [];
function createStagingOfflineOperatorAuthorizer(options) {
  const value = createAuthorizer(options);
  factories.push(value);
  return value;
}
const planSha256 = 'a'.repeat(64);
it('binds native allocation to a different reviewed helper command and refuses unknown authentication purposes', async () => {
  const options = {
    helperPath,
    expectedSha256: createHash('sha256').update('synthetic helper never executed').digest('hex'),
    purpose: 'contained_native_allocation',
  };
  const native = createStagingOfflineOperatorAuthorizer(options);
  const pending = native.authenticate(planSha256);
  expect(spawn).toHaveBeenLastCalledWith(
    helperPath,
    expect.arrayContaining(['authenticate-native-allocation', '--plan-sha256', planSha256]),
    expect.any(Object),
  );
  success();
  const authority = await pending;
  expect(() => authorizer.consume(authority, planSha256)).toThrow();
  const lease = native.consume(authority, planSha256);
  expect(lease.assertCurrent(planSha256)).toBe(true);
  lease.close();
  expect(() =>
    createStagingOfflineOperatorAuthorizer({ ...options, purpose: 'retire_everything' }),
  ).toThrow();
});
let directory, helperPath, authorizer, child;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'offline-auth-test-')));
  chmodSync(directory, 0o700);
  helperPath = join(directory, 'operator-auth');
  writeFileSync(helperPath, 'synthetic helper never executed', { mode: 0o700 });
  child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  vi.mocked(spawn).mockReturnValue(child);
  authorizer = createStagingOfflineOperatorAuthorizer({
    helperPath,
    expectedSha256: createHash('sha256').update('synthetic helper never executed').digest('hex'),
  });
});
afterEach(() => {
  for (const factory of factories.splice(0)) factory.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  rmSync(directory, { recursive: true, force: true });
});
function success(patch = {}) {
  const [, args] = vi.mocked(spawn).mock.calls.at(-1);
  const response = {
    version: 1,
    result: 'authenticated',
    planSha256: args[2],
    nonce: args[4],
    uid: Number(args[6]),
    parentPid: process.pid,
    helperPid: child.pid,
    ...patch,
  };
  child.stdout.emit('data', JSON.stringify(response));
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
}
it('creates only fresh in-memory authority for the exact spawned helper and single plan use', async () => {
  const pending = authorizer.authenticate(planSha256);
  expect(spawn).toHaveBeenCalledWith(
    helperPath,
    expect.arrayContaining(['authenticate', '--plan-sha256', planSha256]),
    expect.objectContaining({
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    }),
  );
  success();
  const authority = await pending;
  expect(() => authorizer.consume(JSON.parse(JSON.stringify(authority)), planSha256)).toThrow();
  expect(() => authorizer.consume(authority, 'b'.repeat(64))).toThrow();
  const lease = authorizer.consume(authority, planSha256);
  expect(lease.assertCurrent(planSha256)).toBe(true);
  expect(() => lease.assertCurrent('b'.repeat(64))).toThrow();
  expect(() => authorizer.consume(authority, planSha256)).toThrow();
  lease.close();
  expect(() => lease.assertCurrent(planSha256)).toThrow();
});
it.each([
  { planSha256: 'b'.repeat(64) },
  { nonce: 'wrong' },
  { uid: 0 },
  { parentPid: 1 },
  { helperPid: 1 },
  { result: 'cancelled' },
  { extra: 'credential' },
])('rejects mismatched or expanded child response %j', async (patch) => {
  const pending = authorizer.authenticate(planSha256);
  const rejected = expect(pending).rejects.toThrow(/authentication/i);
  success(patch);
  await rejected;
});
it('requires successful original child exit and rejects cancellation, timeout, and oversized output', async () => {
  const pending = authorizer.authenticate(planSha256);
  const rejected = expect(pending).rejects.toThrow(/authentication/i);
  child.stdout.emit('data', 'x'.repeat(2048));
  await rejected;
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  const timeout = authorizer.authenticate(planSha256);
  const timedOut = expect(timeout).rejects.toThrow(/authentication/i);
  await vi.advanceTimersByTimeAsync(120000);
  await timedOut;
  const cancelled = authorizer.authenticate(planSha256);
  const denied = expect(cancelled).rejects.toThrow(/authentication/i);
  child.emit('exit', 2, null);
  child.emit('close', 2, null);
  await denied;
});
it('refuses unavailable helper, changed binary identity and data instead of an actual exit', async () => {
  const pending = authorizer.authenticate(planSha256);
  const rejected = expect(pending).rejects.toThrow(/authentication/i);
  writeFileSync(helperPath, 'replaced');
  success();
  await rejected;
  expect(() =>
    createStagingOfflineOperatorAuthorizer({ helperPath, expectedSha256: 'a'.repeat(64) }),
  ).toThrow();
});
it('expires authority within ten minutes and cannot transfer it to another parent authorizer', async () => {
  const pending = authorizer.authenticate(planSha256);
  success();
  const authority = await pending;
  const other = createStagingOfflineOperatorAuthorizer({
    helperPath,
    expectedSha256: createHash('sha256').update('synthetic helper never executed').digest('hex'),
  });
  expect(() => other.consume(authority, planSha256)).toThrow();
  vi.setSystemTime(1600000);
  expect(() => authorizer.consume(authority, planSha256)).toThrow();
});
it('refuses unsafe helper metadata and invalid plan input before spawning', () => {
  chmodSync(helperPath, 0o755);
  expect(() =>
    createStagingOfflineOperatorAuthorizer({ helperPath, expectedSha256: 'a'.repeat(64) }),
  ).toThrow();
  expect(() => authorizer.authenticate('caller text or token')).toThrow();
  expect(() => authorizer.authenticate({ toString: () => planSha256 })).toThrow();
  expect(spawn).not.toHaveBeenCalled();
});
it('refuses aliased helper files or a nonprivate enclosing directory', () => {
  const expectedSha256 = createHash('sha256')
    .update('synthetic helper never executed')
    .digest('hex');
  const alias = join(directory, 'alias');
  symlinkSync(helperPath, alias);
  expect(() =>
    createStagingOfflineOperatorAuthorizer({ helperPath: alias, expectedSha256 }),
  ).toThrow();
  rmSync(alias);
  linkSync(helperPath, alias);
  expect(() => createStagingOfflineOperatorAuthorizer({ helperPath, expectedSha256 })).toThrow();
  rmSync(alias);
  chmodSync(directory, 0o755);
  expect(() => createStagingOfflineOperatorAuthorizer({ helperPath, expectedSha256 })).toThrow();
});
it('expires monotonically even when the wall clock moves backwards', async () => {
  const monotonic = vi.spyOn(performance, 'now').mockReturnValue(1000);
  const pending = authorizer.authenticate(planSha256);
  success();
  const authority = await pending;
  vi.setSystemTime(1);
  monotonic.mockReturnValue(601000);
  expect(() => authorizer.consume(authority, planSha256)).toThrow();
});
it('keeps the original deadline and helper binding throughout a consumed operation lease', async () => {
  const monotonic = vi.spyOn(performance, 'now').mockReturnValue(1000);
  const pending = authorizer.authenticate(planSha256);
  success();
  const authority = await pending;
  monotonic.mockReturnValue(600000);
  const lease = authorizer.consume(authority, planSha256);
  expect(lease.assertCurrent(planSha256)).toBe(true);
  monotonic.mockReturnValue(601000);
  expect(() => lease.assertCurrent(planSha256)).toThrow();
  expect(JSON.parse(JSON.stringify(lease))).toEqual({});
});
it('does not accept close-only success or replayed stdout from a previous child attempt', async () => {
  const pending = authorizer.authenticate(planSha256);
  const rejected = expect(pending).rejects.toThrow(/authentication/i);
  expect(() => authorizer.authenticate(planSha256)).toThrow();
  const [, oldArgs] = vi.mocked(spawn).mock.calls.at(-1);
  child.emit('close', 0, null);
  await rejected;
  const next = authorizer.authenticate(planSha256);
  const replayed = expect(next).rejects.toThrow(/authentication/i);
  success({ nonce: oldArgs[4] });
  await replayed;
});
it('rejects spawn errors, signal exit and helper identity substitution even with matching bytes', async () => {
  const pending = authorizer.authenticate(planSha256);
  const rejected = expect(pending).rejects.toThrow(/authentication/i);
  child.emit('error', Error('Do not expose upstream diagnostics'));
  await rejected;
  const signalled = authorizer.authenticate(planSha256);
  const signalFailure = expect(signalled).rejects.toThrow(/authentication/i);
  child.emit('exit', 0, 'SIGTERM');
  child.emit('close', 0, 'SIGTERM');
  await signalFailure;
  const substituted = authorizer.authenticate(planSha256);
  const substitutionFailure = expect(substituted).rejects.toThrow(/authentication/i);
  const replacement = join(directory, 'replacement');
  writeFileSync(replacement, 'synthetic helper never executed', { mode: 0o700 });
  renameSync(replacement, helperPath);
  success();
  await substitutionFailure;
});

it('holds the enrolled helper inode until explicit parent disposal and revokes the live lease', async () => {
  const fd = vi.mocked(openSync).mock.results[0].value;
  expect(vi.mocked(closeSync).mock.calls.some(([closed]) => closed === fd)).toBe(false);
  expect(fstatSync(fd).nlink).toBe(1);
  const pending = authorizer.authenticate(planSha256);
  success();
  const lease = authorizer.consume(await pending, planSha256);
  authorizer.close();
  expect(() => fstatSync(fd)).toThrow();
  expect(() => lease.assertCurrent(planSha256)).toThrow();
  expect(() => authorizer.authenticate(planSha256)).toThrow();
  authorizer.close();
});
it('prevents unlink/recreate inode reuse throughout a consumed lease', async () => {
  const fd = vi.mocked(openSync).mock.results[0].value,
    original = fstatSync(fd);
  const pending = authorizer.authenticate(planSha256);
  success();
  const lease = authorizer.consume(await pending, planSha256);
  rmSync(helperPath);
  writeFileSync(helperPath, 'synthetic helper never executed', { mode: 0o700 });
  expect(fstatSync(fd).nlink).toBe(0);
  const replacement = openSync(helperPath, 0);
  try {
    expect(fstatSync(replacement).ino).not.toBe(original.ino);
  } finally {
    closeSync(replacement);
  }
  expect(() => lease.assertCurrent(planSha256)).toThrow();
});
it('disposal cancels only the original pending helper and invalidates outstanding authority', async () => {
  const pending = authorizer.authenticate(planSha256),
    rejected = expect(pending).rejects.toThrow(/authentication/i);
  authorizer.close();
  await rejected;
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  expect(() => authorizer.authenticate(planSha256)).toThrow();
  authorizer.close();
  expect(child.kill).toHaveBeenCalledTimes(1);
  const other = createStagingOfflineOperatorAuthorizer({
    helperPath,
    expectedSha256: createHash('sha256').update('synthetic helper never executed').digest('hex'),
  });
  const attempt = other.authenticate(planSha256);
  success();
  const authority = await attempt;
  other.close();
  expect(() => other.consume(authority, planSha256)).toThrow();
});
