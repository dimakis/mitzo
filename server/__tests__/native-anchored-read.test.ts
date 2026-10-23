import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
const race = vi.hoisted(() => ({ run: undefined as (() => void) | undefined, noStat: false }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (...args: Parameters<typeof actual.execFile>) => {
      const run = race.run;
      race.run = undefined;
      run?.();
      if (race.noStat && Array.isArray(args[1]))
        args[1] = args[1].map((value) =>
          value.replace(
            'child = entry.stat(follow_symlinks=False)',
            "if entry.name == 'PRIVATE-DENIED-NAME': raise RuntimeError('Forbidden metadata probe')\n                    child = entry.stat(follow_symlinks=False)",
          ),
        );
      return actual.execFile(...args);
    },
  };
});
import { executeNativeAnchoredReadOperation } from '../native-file-operation.js';
let root: string;
let source: string;
const identity = async (path: string) => {
  const value = await lstat(path, { bigint: true });
  return { dev: String(value.dev), ino: String(value.ino) };
};
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-anchored-read-')));
  source = join(root, 'source');
  await mkdir(source);
  await mkdir(join(source, 'nested'));
  await writeFile(join(source, 'nested', 'bytes'), Buffer.from([0, 255, 128, 65]));
});
afterEach(async () => {
  race.run = undefined;
  race.noStat = false;
  await rm(root, { recursive: true, force: true });
});
async function request(path = join(source, 'nested', 'bytes')) {
  return {
    operation: 'ReadBytes' as const,
    deniedRoots: [] as readonly string[],
    rootAnchor: { rootPath: source, identity: await identity(source) },
    identity: await identity(path),
    parentIdentity: await identity(dirname(path)),
    file_path: path,
    limit: 1024,
  };
}
it('reads binary bytes through the existing pinned descriptor helper without changing source', async () => {
  const result = await executeNativeAnchoredReadOperation(
    await request(),
    new AbortController().signal,
  );
  expect(result.is_error).toBe(false);
  expect(Buffer.from(result.content, 'base64')).toEqual(Buffer.from([0, 255, 128, 65]));
  expect(await readFile(join(source, 'nested', 'bytes'))).toEqual(Buffer.from([0, 255, 128, 65]));
});
it('rejects an ancestor substituted immediately before helper open without reading denied bytes', async () => {
  const approved = await request();
  const denied = join(root, 'denied');
  await mkdir(denied);
  await writeFile(join(denied, 'bytes'), 'SYNTHETIC DENIED CONTENT');
  race.run = () => {
    renameSync(join(source, 'nested'), join(source, 'original'));
    symlinkSync(denied, join(source, 'nested'));
  };
  const result = await executeNativeAnchoredReadOperation(approved, new AbortController().signal);
  expect(result.is_error).toBe(true);
  expect(result.content).not.toContain('SYNTHETIC');
  expect(await readFile(join(denied, 'bytes'), 'utf8')).toBe('SYNTHETIC DENIED CONTENT');
});
it('rejects a substituted real root against the immutable root identity before descendant reads', async () => {
  const approved = await request();
  const replacement = join(root, 'replacement');
  await mkdir(replacement);
  await mkdir(join(replacement, 'nested'));
  await writeFile(join(replacement, 'nested', 'bytes'), 'SYNTHETIC DENIED CONTENT');
  race.run = () => {
    renameSync(source, join(root, 'original-root'));
    renameSync(replacement, source);
  };
  const result = await executeNativeAnchoredReadOperation(approved, new AbortController().signal);
  expect(result.is_error).toBe(true);
  expect(result.content).not.toContain('SYNTHETIC');
});
it('rejects hard-link aliases before binary reads', async () => {
  await link(join(source, 'nested', 'bytes'), join(root, 'alias'));
  expect(
    await executeNativeAnchoredReadOperation(await request(), new AbortController().signal),
  ).toMatchObject({ is_error: true });
});
it('lists only bounded pinned directory metadata and refuses overflow without partial names', async () => {
  const directory = join(source, 'nested');
  await writeFile(join(directory, 'another'), 'unused');
  const input = {
    ...(await request(directory)),
    operation: 'ListDirectory' as const,
    maxEntries: 1,
    maxNameBytes: 1024,
  };
  const overflow = await executeNativeAnchoredReadOperation(input, new AbortController().signal);
  expect(overflow.is_error).toBe(true);
  expect(overflow.content).not.toContain('another');
  const listed = await executeNativeAnchoredReadOperation(
    { ...input, maxEntries: 10 },
    new AbortController().signal,
  );
  expect(listed.is_error).toBe(false);
  const value = JSON.parse(listed.content);
  expect(value.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'bytes', kind: 'file', nlink: 1, size: 4 }),
    ]),
  );
});
it('refuses byte limits before allocating/returning oversize content and respects cancellation', async () => {
  const input = await request();
  expect(
    await executeNativeAnchoredReadOperation({ ...input, limit: 1 }, new AbortController().signal),
  ).toMatchObject({ is_error: true });
  const controller = new AbortController();
  controller.abort();
  await expect(executeNativeAnchoredReadOperation(input, controller.signal)).rejects.toThrow();
});

it('returns an explicitly bounded trusted instruction prefix without reading the remaining bytes', async () => {
  const result = await executeNativeAnchoredReadOperation(
    { ...(await request()), limit: 2, prefix: true },
    new AbortController().signal,
  );
  expect(result).toMatchObject({ is_error: false, truncated: true });
  expect(Buffer.from(result.content, 'base64')).toEqual(Buffer.from([0, 255]));
});

async function aliasRequest() {
  const alias = join(source, 'nested', 'alias');
  await symlink('bytes', alias);
  return { ...(await request(alias)), operation: 'ReadLink' as const, limit: 4096 };
}
it('reads only bounded link text without following its target', async () => {
  const result = await executeNativeAnchoredReadOperation(
    await aliasRequest(),
    new AbortController().signal,
  );
  expect(result.is_error).toBe(false);
  expect(Buffer.from(result.content, 'base64').toString()).toBe('bytes');
});
it('rejects a link swapped before readlinkat without exposing replacement text', async () => {
  const input = await aliasRequest();
  race.run = () => {
    renameSync(input.file_path, input.file_path + '-old');
    symlinkSync('DENIED-TARGET', input.file_path);
  };
  const result = await executeNativeAnchoredReadOperation(input, new AbortController().signal);
  expect(result.is_error).toBe(true);
  expect(result.content).not.toContain('DENIED');
});
it('rejects link text exceeding the private limit and cancelled link reads', async () => {
  const input = await aliasRequest();
  expect(
    await executeNativeAnchoredReadOperation({ ...input, limit: 1 }, new AbortController().signal),
  ).toMatchObject({ is_error: true });
  const controller = new AbortController();
  controller.abort();
  await expect(executeNativeAnchoredReadOperation(input, controller.signal)).rejects.toThrow();
});

it('refuses oversized link requests and paths before starting a filesystem helper', async () => {
  const input = await aliasRequest();
  race.run = () => {
    throw Error('Must reject before spawn');
  };
  expect(
    await executeNativeAnchoredReadOperation(
      { ...input, limit: 4097 },
      new AbortController().signal,
    ),
  ).toMatchObject({ is_error: true });
  expect(
    await executeNativeAnchoredReadOperation(
      { ...input, file_path: '/' + 'x'.repeat(4096) },
      new AbortController().signal,
    ),
  ).toMatchObject({ is_error: true });
  expect(race.run).toBeTypeOf('function');
});

it('lists an explicitly qualified root directory without widening root byte or link reads', async () => {
  const pinned = await identity('/');
  const input = {
    operation: 'ListDirectory' as const,
    deniedRoots: Object.freeze([]),
    file_path: '/',
    rootAnchor: { rootPath: '/', identity: pinned },
    identity: pinned,
    parentIdentity: pinned,
    limit: 1,
    maxEntries: 10000,
    maxNameBytes: 1024 * 1024,
  };
  const result = await executeNativeAnchoredReadOperation(input, new AbortController().signal);
  expect(result.is_error).toBe(false);
  expect(JSON.parse(result.content).identity).toEqual(pinned);
  for (const operation of ['ReadBytes', 'ReadLink'] as const)
    expect(
      await executeNativeAnchoredReadOperation(
        { ...input, operation },
        new AbortController().signal,
      ),
    ).toMatchObject({ is_error: true });
});

it('excludes an actual denied child before stat without disclosing names or counts', async () => {
  const directory = join(source, 'nested');
  const denied = join(directory, 'PRIVATE-DENIED-NAME');
  await writeFile(denied, 'PRIVATE-CONTENT');
  race.noStat = true;
  const result = await executeNativeAnchoredReadOperation(
    {
      ...(await request(directory)),
      operation: 'ListDirectory',
      deniedRoots: Object.freeze([denied]),
      maxEntries: 10000,
      maxNameBytes: 1024 * 1024,
    },
    new AbortController().signal,
  );
  expect(result.is_error).toBe(false);
  const value = JSON.parse(result.content);
  expect(value).toMatchObject({ incomplete: true, truncated: false });
  expect(JSON.stringify(value)).not.toMatch(
    /PRIVATE-DENIED-NAME|PRIVATE-CONTENT|excludedCount|deniedCount/,
  );
});
it.each([
  undefined,
  ['relative'],
  Array(257).fill('/private/denied'),
  Array.from({ length: 32 }, (_, i) => '/' + String(i) + 'x'.repeat(3000)),
])(
  'refuses missing, invalid, or oversized actual denial projections before any filesystem operation (%#)',
  async (deniedRoots) => {
    const input = { ...(await request()), deniedRoots } as unknown as Parameters<
      typeof executeNativeAnchoredReadOperation
    >[0];
    race.run = () => {
      throw Error('Must not spawn with invalid actual projection');
    };
    expect(
      await executeNativeAnchoredReadOperation(input, new AbortController().signal),
    ).toMatchObject({ is_error: true });
    expect(race.run).toBeTypeOf('function');
  },
);
