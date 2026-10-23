import { execFile } from 'node:child_process';
import { renameSync, symlinkSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const race = vi.hoisted(() => ({ before: undefined as (() => void) | undefined }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn((...args: Parameters<typeof actual.execFile>) => {
      const before = race.before;
      race.before = undefined;
      before?.();
      return actual.execFile(...args);
    }),
  };
});
import { captureNativeReadAnchor } from '../native-file-operation.js';
let root: string;
let directory: string;
beforeEach(async () => {
  vi.clearAllMocks();
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-read-anchor-')));
  directory = join(root, 'source', 'nested');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'unread-file'), 'fixture bytes never needed for anchor');
});
afterEach(async () => {
  race.before = undefined;
  await rm(root, { recursive: true, force: true });
});
function capture(
  path = directory,
  deniedRoots: readonly string[] = [],
  signal = new AbortController().signal,
) {
  return captureNativeReadAnchor({ file_path: path, deniedRoots }, signal, 5000);
}
it('captures only a frozen descriptor-walk directory identity without listing or reading its files', async () => {
  const anchor = await capture();
  const actual = await lstat(directory, { bigint: true });
  expect(anchor).toEqual({
    rootPath: directory,
    identity: { dev: String(actual.dev), ino: String(actual.ino) },
  });
  expect(Object.isFrozen(anchor)).toBe(true);
  expect(Object.isFrozen(anchor.identity)).toBe(true);
  expect(JSON.stringify(anchor)).not.toContain('unread-file');
  expect(await readFile(join(directory, 'unread-file'), 'utf8')).toBe(
    'fixture bytes never needed for anchor',
  );
});
it('refuses a denied ancestor before launching the helper or looking up the target', async () => {
  await expect(capture(directory, [join(root, 'source')])).rejects.toThrow(
    'Anchored native read unavailable',
  );
  expect(execFile).not.toHaveBeenCalled();
});
it('refuses a directory alias installed immediately before the descriptor walk', async () => {
  const original = join(root, 'original');
  race.before = () => {
    renameSync(join(root, 'source'), original);
    symlinkSync(original, join(root, 'source'));
  };
  await expect(capture()).rejects.toThrow('Anchored native read unavailable');
});
it('refuses files, malformed paths and oversized exclusion projections without a fallback', async () => {
  await expect(capture(join(directory, 'unread-file'))).rejects.toThrow(
    'Anchored native read unavailable',
  );
  vi.mocked(execFile).mockClear();
  await expect(capture(directory + '/..')).rejects.toThrow();
  await expect(
    capture(
      directory,
      Array.from({ length: 257 }, (_, index) => join(root, String(index))),
    ),
  ).rejects.toThrow();
  expect(execFile).not.toHaveBeenCalled();
});
it('refuses cancellation before launch', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(capture(directory, [], controller.signal)).rejects.toThrow();
  expect(execFile).not.toHaveBeenCalled();
});
it('supports the actual filesystem root identity without enumerating its contents', async () => {
  const anchor = await capture('/');
  const actual = await lstat('/', { bigint: true });
  expect(anchor).toEqual({
    rootPath: '/',
    identity: { dev: String(actual.dev), ino: String(actual.ino) },
  });
});
