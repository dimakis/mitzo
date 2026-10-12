import { afterEach, expect, it, vi } from 'vitest';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
const effects = vi.hoisted(() => ({ body: new Map(), command: vi.fn(), held: vi.fn() }));
vi.mock('node:fs', async (original) => {
  const fs = await original();
  return {
    ...fs,
    realpathSync: (path) => path,
    openSync: (path) => path,
    closeSync() {},
    readFileSync: (path) => effects.body.get(path),
    fstatSync: (path) => ({
      isFile: () => true,
      uid: process.getuid(),
      nlink: 1,
      mode: 0o100600,
      size: effects.body.get(path).length,
    }),
    lstatSync: (path) => ({
      isDirectory: () => !effects.body.has(path),
      uid: process.getuid(),
      mode: effects.body.has(path) ? 0o100600 : 0o40700,
    }),
  };
});
vi.mock('node:child_process', () => ({ spawnSync: effects.command }));
vi.mock('../../scripts/lib/staging-native-source-continuity.mjs', () => ({
  loadOriginalHeldFileCapture: async () => ({
    assertCurrent: effects.held,
    module: { captureOriginalImmutableFile: () => ({ assertCurrent: effects.held, close() {} }) },
  }),
}));
import {
  createContainedNativeLauncherPlist,
  createContainedNativeRegisteredLauncherObserver,
} from '../../scripts/lib/staging-contained-native-launcher-observation.mjs';

const platform = Object.getOwnPropertyDescriptor(process, 'platform');
const parent = Object.getOwnPropertyDescriptor(process, 'ppid');
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  Object.defineProperty(process, 'ppid', parent);
  vi.restoreAllMocks();
  effects.body.clear();
});
it('keeps actual original observer liveness across 100 loaded-source polls without another command or body read', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  Object.defineProperty(process, 'ppid', { configurable: true, value: 1 });
  const root = join(homedir(), '.local/share/mitzo-staging');
  const sourceRoot = join(root, 'releases', 'a'.repeat(12));
  vi.spyOn(process, 'cwd').mockReturnValue(sourceRoot);
  const body = Buffer.from('{"fixture":"registered-original"}');
  const spec = {
    root,
    sourceRoot,
    sourceCommit: 'a'.repeat(40),
    node: process.execPath,
    allocation: '22222222-2222-4222-8222-222222222222',
    bootstrapSha256: createHash('sha256').update(body).digest('hex'),
  };
  const expected = createContainedNativeLauncherPlist(spec);
  const plist = join(root, 'service/com.mitzo.staging.plist');
  effects.body.set(plist, Buffer.from(expected.bytes));
  effects.body.set(expected.bootstrapPath, body);
  effects.command.mockImplementation((program, args) => ({
    status: 0,
    stderr: '',
    stdout:
      program === '/usr/bin/plutil'
        ? JSON.stringify(expected.fields)
        : program === '/bin/launchctl'
          ? `path = ${plist}\nstate = running\nruns = 1\npid = ${process.pid}`
          : program === '/usr/sbin/lsof'
            ? `p${process.pid}\nn${sourceRoot}`
            : args.includes('lstart=')
              ? 'original birth'
              : '1',
  }));
  const observer = createContainedNativeRegisteredLauncherObserver(spec);
  const loaded = await observer.captureLoadedCurrent('b'.repeat(64), 'c'.repeat(64));
  effects.command.mockClear();
  for (let index = 0; index < 100; index++) loaded.assertCurrent();
  expect(effects.command).not.toHaveBeenCalled();
  loaded.assertRegistrationCurrent();
  expect(effects.command).toHaveBeenCalled();
  Object.defineProperty(process, 'ppid', { configurable: true, value: 99 });
  expect(() => loaded.assertCurrent()).toThrow();
});
