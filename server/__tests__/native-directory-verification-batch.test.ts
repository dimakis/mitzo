import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as operations from '../native-file-operation.js';
import { executeSandboxedCommand } from '../sandboxed-command.js';

let root: string;
let scratch: string;
let directories: string[];
const identity = async (path: string) => {
  const value = await lstat(path, { bigint: true });
  return { dev: String(value.dev), ino: String(value.ino) };
};
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-directory-batch-')));
  scratch = join(root, 'scratch');
  directories = [join(root, 'one'), join(root, 'two')];
  for (const directory of [scratch, ...directories]) await mkdir(directory);
  await writeFile(join(directories[0], 'one.txt'), 'UNREAD SOURCE BYTES');
  await writeFile(join(directories[1], 'two.txt'), 'UNREAD SOURCE BYTES');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function request() {
  return {
    operation: 'ListDirectoryBatch' as const,
    deniedRoots: Object.freeze([] as string[]),
    items: await Promise.all(
      directories.map(async (file_path) => ({
        operation: 'ListDirectory' as const,
        file_path,
        rootAnchor: { rootPath: root, identity: await identity(root) },
        parentIdentity: await identity(root),
        identity: await identity(file_path),
        limit: 1,
        maxEntries: 10000,
        maxNameBytes: 1024 * 1024,
      })),
    ),
  };
}
function transport(deniedRoots: string[] = []) {
  return vi.fn<operations.NativeFileHelperTransport>(async (input) => {
    const result = await executeSandboxedCommand({
      command: input.command,
      cwd: scratch,
      writableRoots: [scratch],
      deniedRoots,
      env: { PATH: '/usr/bin:/bin' },
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
      privateOutput: 'separate',
    });
    return { stdout: result.stdout ?? '', isError: result.isError };
  });
}
const actual = it.runIf(
  process.platform === 'darwin' && process.env.MITZO_SANDBOX_INTEGRATION === '1',
);
actual(
  'returns ordered complete directory witnesses through one existing SRT helper',
  async () => {
    const input = await request(),
      run = transport();
    const result = await operations.executeNativeDirectoryVerificationBatch(
      input,
      new AbortController().signal,
      15000,
      run,
    );
    expect(
      result.map((entry) =>
        JSON.parse(entry.content).entries.map((value: { name: string }) => value.name),
      ),
    ).toEqual([['one.txt'], ['two.txt']]);
    expect(result.every((entry) => !entry.is_error)).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0].maxOutputBytes).toBe(8 * 1024 * 1024);
  },
  30000,
);
actual.each(['root', 'parent', 'final'] as const)(
  'discards every listing if a %s identity differs',
  async (changed) => {
    const input = await request();
    const last = input.items[1];
    if (changed === 'root') last.rootAnchor.identity = { dev: '0', ino: '0' };
    if (changed === 'parent') last.parentIdentity = { dev: '0', ino: '0' };
    if (changed === 'final') {
      await rename(last.file_path, last.file_path + '-retained');
      await mkdir(last.file_path);
    }
    await expect(
      operations.executeNativeDirectoryVerificationBatch(
        input,
        new AbortController().signal,
        15000,
        transport(),
      ),
    ).rejects.toThrow('Anchored directory batch unavailable');
  },
  30000,
);
actual.for(['case', 'unicode'] as const)(
  'returns no partial result for an actually filesystem-equivalent %s denied item',
  { timeout: 30000 },
  async (kind, context) => {
    const input = await request();
    const physical = join(root, kind === 'case' ? 'Case-private' : 'Café-private');
    const alias = join(root, kind === 'case' ? 'CASE-PRIVATE' : 'Cafe\u0301-private');
    await rename(directories[1], physical);
    const original = await identity(physical);
    let equivalent = false;
    try {
      equivalent = JSON.stringify(await identity(alias)) === JSON.stringify(original);
    } catch {
      /* Case-sensitive volumes have no alias. */
    }
    if (!equivalent) {
      context.skip();
      return;
    }
    input.items[1].file_path = alias;
    Object.assign(input, { deniedRoots: [physical] });
    await expect(
      operations.executeNativeDirectoryVerificationBatch(
        input,
        new AbortController().signal,
        15000,
        transport([physical]),
      ),
    ).rejects.toThrow('Anchored directory batch unavailable');
  },
);
it.each(['duplicate', 'mixed', 'overlimit', 'getter', 'denials'] as const)(
  'refuses %s before private transport or source lookup',
  async (fault) => {
    const input = await request();
    if (fault === 'duplicate') input.items[1] = input.items[0];
    if (fault === 'mixed') Object.assign(input.items[1], { operation: 'ReadBytes' });
    if (fault === 'overlimit') input.items = Array.from({ length: 9 }, () => input.items[0]);
    if (fault === 'denials')
      Object.assign(input, {
        deniedRoots: Array.from({ length: 257 }, (_, index) => join(root, String(index))),
      });
    const getter = vi.fn(() => directories[0]);
    if (fault === 'getter') Object.defineProperty(input.items[0], 'file_path', { get: getter });
    const run = vi.fn<operations.NativeFileHelperTransport>();
    await expect(
      operations.executeNativeDirectoryVerificationBatch(
        input,
        new AbortController().signal,
        15000,
        run,
      ),
    ).rejects.toThrow('Anchored directory batch unavailable');
    expect(run).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  },
);
it('requires explicit private transport and refuses cancellation before launch', async () => {
  const input = await request();
  await expect(
    operations.executeNativeDirectoryVerificationBatch(input, new AbortController().signal, 15000),
  ).rejects.toThrow();
  const abort = new AbortController();
  abort.abort();
  const run = vi.fn<operations.NativeFileHelperTransport>();
  await expect(
    operations.executeNativeDirectoryVerificationBatch(input, abort.signal, 15000, run),
  ).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
  await expect(
    operations.executeNativeFileOperation(
      {
        operation: 'ListDirectoryBatch',
        file_path: '/',
        identity: null,
        parentIdentity: { dev: '0', ino: '0' },
        limit: 1,
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow('Private helper transport unavailable');
});

it('rejects an oversized aggregate request before invoking its private transport', async () => {
  const input = await request();
  const rootPath = '/' + 'r'.repeat(4090);
  Object.assign(input, {
    deniedRoots: Array.from(
      { length: 256 },
      (_, index) => '/' + 'd'.repeat(250) + String(index).padStart(3, '0'),
    ),
    items: Array.from({ length: 8 }, (_, index) => ({
      ...input.items[0],
      file_path: rootPath + '/' + index,
      rootAnchor: { ...input.items[0].rootAnchor, rootPath },
    })),
  });
  const run = vi.fn<operations.NativeFileHelperTransport>();
  await expect(
    operations.executeNativeDirectoryVerificationBatch(
      input,
      new AbortController().signal,
      15000,
      run,
    ),
  ).rejects.toThrow('Anchored directory batch unavailable');
  expect(run).not.toHaveBeenCalled();
});

it.each(['valid', 'count', 'order', 'partial-error', 'extra-envelope', 'oversized'] as const)(
  'checks %s output before exposing a complete listing',
  async (fault) => {
    const input = await request();
    let contents = input.items.map((item) =>
      JSON.stringify({ identity: item.identity, entries: [], truncated: false, incomplete: false }),
    );
    if (fault === 'count') contents = contents.slice(0, 1);
    if (fault === 'order') contents.reverse();
    const content = JSON.stringify(contents);
    const stdout =
      fault === 'oversized'
        ? 'x'.repeat(8 * 1024 * 1024 + 1)
        : `{"content": ${JSON.stringify(content)}, "is_error": ${fault === 'partial-error'}${fault === 'extra-envelope' ? ', "private": "MUST NOT ESCAPE"' : ''}}\n`;
    const run = vi.fn<operations.NativeFileHelperTransport>(async () => ({
      stdout,
      isError: false,
    }));
    const result = operations.executeNativeDirectoryVerificationBatch(
      input,
      new AbortController().signal,
      15000,
      run,
    );
    if (fault === 'valid') await expect(result).resolves.toHaveLength(2);
    else await expect(result).rejects.toThrow('Anchored directory batch unavailable');
    expect(run).toHaveBeenCalledOnce();
  },
);
