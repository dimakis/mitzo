import process from 'node:process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import * as vm from '../../scripts/lib/staging-fresh-applehv.mjs';
it('a timed out original start permanently refuses late inspections and destroys every held connection', async () => {
  const close = vi.fn(),
    authority = vm.createFreshAppleHvStartRevocation(close);
  const socket = { destroy: vi.fn() };
  authority.track(socket);
  let finish;
  const inspection = new Promise((resolve) => {
    finish = resolve;
  });
  const acknowledge = vi.fn();
  const pending = (async () => {
    authority.assertCurrent();
    await inspection;
    authority.assertCurrent();
    acknowledge();
  })();
  authority.revoke();
  finish();
  await expect(pending).rejects.toThrow(/revoked/);
  expect(acknowledge).not.toHaveBeenCalled();
  expect(socket.destroy).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  const late = { destroy: vi.fn() };
  authority.track(late);
  expect(late.destroy).toHaveBeenCalledOnce();
  expect(() => authority.assertCurrent()).toThrow();
  authority.revoke();
  expect(close).toHaveBeenCalledOnce();
});
it('initialization intent must fsync the file and private parent before returning dispatch authority', () => {
  const calls = [],
    fs = {
      openSync: vi.fn((path) => {
        calls.push(['open', path]);
        return calls.length;
      }),
      writeFileSync: vi.fn(() => calls.push(['write'])),
      fsyncSync: vi.fn((fd) => calls.push(['sync', fd])),
      closeSync: vi.fn((fd) => calls.push(['close', fd])),
    };
  vm.persistFreshVmInitializationAttempt('/private/owned/attempt.json', { operation: 'owned' }, fs);
  expect(calls.map((c) => c[0])).toEqual([
    'open',
    'write',
    'sync',
    'close',
    'open',
    'sync',
    'close',
  ]);
  expect(calls[4][1]).toBe('/private/owned');
  fs.fsyncSync.mockImplementation(() => {
    throw Error('uncertain persistence');
  });
  expect(() =>
    vm.persistFreshVmInitializationAttempt('/private/owned/attempt.json', {}, fs),
  ).toThrow(/persistence/);
});

it('actual immutable-input inspection rejects first-boot Ignition changed after its approved capture', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vm-ignition-proof-'))),
    home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  const files = {};
  for (const name of ['ssh', 'configuration', 'ignition']) {
    const path = join(home, name);
    writeFileSync(path, 'original', { mode: 0o600 });
    const stat = lstatSync(path);
    files[name] = {
      path,
      dev: stat.dev,
      ino: stat.ino,
      uid: process.getuid(),
      mode: 0o600,
      nlink: 1,
      size: 8,
      sha256: createHash('sha256').update('original').digest('hex'),
    };
  }
  const plan = { nativeRoot: root, qualification: { environment: { HOME: home } }, files };
  try {
    expect(() => vm.inspectFreshAppleHvImmutableInputs(plan)).not.toThrow();
    writeFileSync(files.ignition.path, 'tampered');
    expect(() => vm.inspectFreshAppleHvImmutableInputs(plan)).toThrow(/immutable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
