import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as operations from '../native-file-operation.js';
import { executeSandboxedCommand } from '../sandboxed-command.js';

let root: string;
let parent: string;
let scratch: string;
let target: string;
const identity = async (path: string) => {
  const info = await lstat(path, { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino) };
};
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-exclusive-directory-')));
  parent = join(root, 'source-parent');
  scratch = join(root, 'operation-scratch');
  target = join(parent, 'owned-task');
  await mkdir(parent);
  await mkdir(scratch);
  await writeFile(join(parent, 'source-index-witness'), 'SOURCE BYTES');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function request() {
  await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  return {
    file_path: target,
    rootAnchor: { rootPath: root, identity: await identity(root) },
    parentIdentity: await identity(parent),
    expectedAbsent: true as const,
    deniedRoots: Object.freeze([] as string[]),
  };
}
function transport(signal = new AbortController().signal, deniedRoots: string[] = []) {
  return vi.fn<operations.NativeFileHelperTransport>(async (operation) => {
    const result = await executeSandboxedCommand({
      command: operation.command,
      cwd: scratch,
      writableRoots: [scratch, target],
      deniedRoots,
      env: { PATH: '/usr/bin:/bin' },
      signal: AbortSignal.any([signal, operation.signal]),
      timeoutMs: operation.timeoutMs,
      maxOutputBytes: operation.maxOutputBytes,
      privateOutput: 'separate',
    });
    return { stdout: result.stdout ?? '', isError: result.isError };
  });
}
const actual = it.runIf(
  process.platform === 'darwin' && process.env.MITZO_SANDBOX_INTEGRATION === '1',
);
// Actual existing SRT + fixed helper mechanism fixtures only. These independent
// synthetic scopes do not stand in for signed Prepare authorization or register it.
actual(
  'exclusively creates the absent directory with frozen identity through the supplied SRT actor',
  async () => {
    const input = await request();
    const run = transport();
    const created = await operations.createNativeExclusiveDirectory(
      input,
      new AbortController().signal,
      15000,
      run,
    );
    expect(created).toEqual({ directory: target, identity: await identity(target) });
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.identity)).toBe(true);
    expect((await lstat(target)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(parent, 'source-index-witness'), 'utf8')).toBe('SOURCE BYTES');
    expect(run).toHaveBeenCalledOnce();
  },
  30000,
);
actual(
  'never adopts an existing foreign empty directory after original absence was captured',
  async () => {
    const input = await request();
    await mkdir(target);
    const foreign = await identity(target);
    await expect(
      operations.createNativeExclusiveDirectory(
        input,
        new AbortController().signal,
        15000,
        transport(),
      ),
    ).rejects.toThrow('Exclusive native directory unavailable');
    expect(await identity(target)).toEqual(foreign);
    expect(await readFile(join(parent, 'source-index-witness'), 'utf8')).toBe('SOURCE BYTES');
  },
  30000,
);
actual.each(['root', 'parent'] as const)(
  'refuses a replaced approved %s before creating any directory',
  async (changed) => {
    const input = await request();
    const path = changed === 'root' ? root : parent;
    await rename(path, path + '-retained');
    await mkdir(path);
    if (changed === 'root') {
      await mkdir(parent);
      await mkdir(scratch);
    }
    try {
      await expect(
        operations.createNativeExclusiveDirectory(
          input,
          new AbortController().signal,
          15000,
          transport(),
        ),
      ).rejects.toThrow('Exclusive native directory unavailable');
      await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(path, { recursive: true, force: true });
      await rename(path + '-retained', path);
    }
  },
  30000,
);
actual(
  'retains an uncertain created directory when cancellation wins after the actual helper effect',
  async () => {
    const input = await request();
    const abort = new AbortController();
    const run = transport();
    const cancelled: operations.NativeFileHelperTransport = async (operation) => {
      const result = await run(operation);
      abort.abort();
      return result;
    };
    await expect(
      operations.createNativeExclusiveDirectory(input, abort.signal, 15000, cancelled),
    ).rejects.toThrow();
    expect((await lstat(target)).isDirectory()).toBe(true);
  },
  30000,
);
actual(
  'the same SRT actor can create its exact child but cannot rename its parent/root or create a suffix sibling',
  async () => {
    const script = `import errno, json, os
os.mkdir(${JSON.stringify(target)}, 0o700)
result = {}
for name, operation in [
    ('parent', lambda: os.rename(${JSON.stringify(parent)}, ${JSON.stringify(parent + '-moved')})),
    ('root', lambda: os.rename(${JSON.stringify(root)}, ${JSON.stringify(root + '-moved')})),
    ('suffix', lambda: os.mkdir(${JSON.stringify(target + '-foreign-suffix')})),
]:
    try:
        operation()
        result[name] = False
    except OSError as error:
        result[name] = error.errno in (errno.EACCES, errno.EPERM)
print(json.dumps(result))`;
    const result = await executeSandboxedCommand({
      command: "/usr/bin/python3 -I -c '" + script.replaceAll("'", "'\\''") + "'",
      cwd: scratch,
      writableRoots: [scratch, target],
      deniedRoots: [],
      env: { PATH: '/usr/bin:/bin' },
      signal: AbortSignal.timeout(15000),
      timeoutMs: 15000,
      privateOutput: 'separate',
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.stdout!)).toEqual({ parent: true, root: true, suffix: true });
    expect((await lstat(target)).isDirectory()).toBe(true);
    expect((await lstat(parent)).isDirectory()).toBe(true);
    await expect(lstat(parent + '-moved')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(root + '-moved')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(target + '-foreign-suffix')).rejects.toMatchObject({ code: 'ENOENT' });
  },
  30000,
);
actual.each(['file', 'symlink'] as const)(
  'refuses an existing foreign %s without modifying its identity or content',
  async (kind) => {
    const input = await request();
    if (kind === 'file') await writeFile(target, 'FOREIGN CONTENT');
    else await symlink(join(parent, 'source-index-witness'), target);
    const foreign = await identity(target);
    await expect(
      operations.createNativeExclusiveDirectory(
        input,
        new AbortController().signal,
        15000,
        transport(),
      ),
    ).rejects.toThrow('Exclusive native directory unavailable');
    expect(await identity(target)).toEqual(foreign);
    expect(await readFile(target, 'utf8')).toBe(
      kind === 'file' ? 'FOREIGN CONTENT' : 'SOURCE BYTES',
    );
  },
  30000,
);
it('refuses denied, malformed, oversized and missing-transport requests before any helper launch', async () => {
  const input = await request();
  const run = vi.fn<operations.NativeFileHelperTransport>();
  for (const invalid of [
    { ...input, deniedRoots: [parent] },
    { ...input, deniedRoots: undefined },
    { ...input, deniedRoots: Array.from({ length: 257 }, (_, index) => join(root, String(index))) },
    { ...input, expectedAbsent: false },
    { ...input, file_path: target + '/..' },
    { ...input, file_path: '/' },
    { ...input, file_path: root },
    { ...input, file_path: '/' + 'a'.repeat(4096) },
    {
      ...input,
      deniedRoots: Array.from(
        { length: 17 },
        (_, index) => '/' + String(index).padStart(4, '0') + 'a'.repeat(4090),
      ),
    },
    { ...input, parentIdentity: { dev: 'invalid', ino: '1' } },
  ]) {
    await expect(
      operations.createNativeExclusiveDirectory(
        invalid as Parameters<typeof operations.createNativeExclusiveDirectory>[0],
        new AbortController().signal,
        15000,
        run,
      ),
    ).rejects.toThrow('Exclusive native directory unavailable');
  }
  await expect(
    operations.createNativeExclusiveDirectory(
      input,
      new AbortController().signal,
      15000,
      undefined as unknown as operations.NativeFileHelperTransport,
    ),
  ).rejects.toThrow('Exclusive native directory unavailable');
  expect(run).not.toHaveBeenCalled();
  await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('refuses cancellation before launching or touching the destination', async () => {
  const input = await request();
  const abort = new AbortController();
  abort.abort();
  const run = vi.fn<operations.NativeFileHelperTransport>();
  await expect(
    operations.createNativeExclusiveDirectory(input, abort.signal, 15000, run),
  ).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
  await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('projects only bounded private arguments without copying or inspecting unrelated caller material', async () => {
  const input = await request();
  Object.defineProperty(input, 'unrelated', {
    enumerable: true,
    get: () => {
      throw Error('Unrelated input must never be copied');
    },
  });
  // Decoder-only fixture, not evidence of a real filesystem effect or authority.
  const content = JSON.stringify({ directory: target, identity: { dev: '1', ino: '2' } });
  const run = vi.fn<operations.NativeFileHelperTransport>(async () => ({
    stdout: `{"content": ${JSON.stringify(content)}, "is_error": false}\n`,
    isError: false,
  }));
  await expect(
    operations.createNativeExclusiveDirectory(input, new AbortController().signal, 15000, run),
  ).resolves.toMatchObject({ directory: target });
  expect(run.mock.calls[0][0].command).not.toContain('unrelated');
  await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('refuses the private write operation through the legacy direct-host entry point', async () => {
  const input = await request();
  await expect(
    operations.executeNativeFileOperation(
      {
        ...input,
        operation: 'CreateDirectory',
        identity: null,
        timeoutMs: 15000,
        limit: 1,
      },
      new AbortController().signal,
      15000,
    ),
  ).rejects.toThrow('Private helper transport unavailable');
  await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
});
