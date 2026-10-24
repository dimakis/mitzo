import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as operations from '../native-file-operation.js';
import type { NativeExclusiveTreeRequest } from '../native-tree-publication.js';
import { executePrivateNativeFileHelper } from '../sandboxed-command.js';

let root: string, scratch: string, source: string, target: string;
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const identity = async (path: string) => {
  const info = await lstat(path, { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino) };
};
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-exclusive-tree-')));
  scratch = join(root, 'owned');
  source = join(scratch, 'checkout');
  target = join(root, 'qualified-parent', 'task');
  await mkdir(scratch);
  await mkdir(source);
  await mkdir(join(root, 'qualified-parent'));
  await mkdir(target);
  await mkdir(join(source, 'lib'));
  await writeFile(join(source, 'lib', 'binary'), Buffer.from([0, 128, 255]));
  await writeFile(join(source, 'run'), '#!/bin/sh\nexit 0\n');
  await chmod(join(source, 'run'), 0o755);
  await symlink('../run', join(source, 'lib', 'literal-link'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
async function request(): Promise<NativeExclusiveTreeRequest> {
  return {
    file_path: target,
    rootAnchor: {
      rootPath: join(root, 'qualified-parent'),
      identity: await identity(join(root, 'qualified-parent')),
    },
    parentIdentity: await identity(join(root, 'qualified-parent')),
    targetIdentity: await identity(target),
    payload: {
      file_path: source,
      rootAnchor: { rootPath: scratch, identity: await identity(scratch) },
      parentIdentity: await identity(scratch),
      identity: await identity(source),
    },
    originalSourcePath: join(root, 'original-source'),
    deniedRoots: Object.freeze([] as string[]),
    entries: [
      {
        path: 'lib',
        mode: '040000',
        identity: await identity(join(source, 'lib')),
        size: 0,
        sha256: sha(''),
      },
      {
        path: 'lib/binary',
        mode: '100644',
        identity: await identity(join(source, 'lib/binary')),
        size: 3,
        sha256: sha(Buffer.from([0, 128, 255])),
      },
      {
        path: 'lib/literal-link',
        mode: '120000',
        identity: await identity(join(source, 'lib/literal-link')),
        size: 6,
        sha256: sha('../run'),
      },
      {
        path: 'run',
        mode: '100755',
        identity: await identity(join(source, 'run')),
        size: 17,
        sha256: sha('#!/bin/sh\nexit 0\n'),
      },
    ],
  };
}
function transport() {
  return vi.fn<operations.NativeFileHelperTransport>(async (invocation) => {
    const original = JSON.parse(invocation.requestJson);
    const result = await executePrivateNativeFileHelper({
      requestJson: invocation.requestJson,
      cwd: scratch,
      writableRoots: [
        { path: scratch, parentAnchor: { rootPath: scratch, identity: await identity(scratch) } },
        { path: target, parentAnchor: original.rootAnchor },
      ],
      deniedRoots: original.deniedRoots,
      signal: invocation.signal,
      timeoutMs: invocation.timeoutMs,
      maxOutputBytes: invocation.maxOutputBytes,
      assertCurrentSync() {},
      async revalidate() {},
    });
    return { stdout: result.stdout ?? '', isError: result.isError };
  });
}
const actual = it.runIf(
  process.platform === 'darwin' && process.env.MITZO_SANDBOX_INTEGRATION === '1',
);
actual(
  'publishes a complete binary/executable/literal-symlink tree through the SAME exclusive SRT helper',
  async () => {
    const result = await operations.createNativeExclusiveTree(
      await request(),
      new AbortController().signal,
      15000,
      transport(),
    );
    expect(result.directory).toBe(target);
    expect(result.identity).toEqual(await identity(target));
    expect(result.entries).toBe(4);
    expect(result.byteLength).toBe(26);
    expect(await readFile(join(target, 'lib', 'binary'))).toEqual(Buffer.from([0, 128, 255]));
    expect(await readlink(join(target, 'lib', 'literal-link'))).toBe('../run');
    expect((await lstat(join(target, 'run'))).mode & 0o777).toBe(0o755);
  },
  30000,
);
actual.each([
  'foreign',
  'payload-bytes',
  'payload-identity',
  'source-root',
  'target-root',
  'unlisted',
  'mode',
] as const)(
  'refuses %s before any tree publication and retains foreign bytes',
  async (change) => {
    const input = await request();
    if (change === 'foreign') await writeFile(join(target, 'foreign'), 'KEEP');
    if (change === 'payload-bytes') await writeFile(join(source, 'run'), 'DIFFERENT CONTENT');
    if (change === 'payload-identity') {
      await rename(join(source, 'run'), join(source, 'retained'));
      await writeFile(join(source, 'run'), '#!/bin/sh\nexit 0\n');
    }
    if (change === 'source-root') {
      await rename(source, source + '-retained');
      await mkdir(source);
    }
    if (change === 'target-root') {
      await rename(target, target + '-retained');
      await mkdir(target);
    }
    if (change === 'mode') await chmod(join(source, 'run'), 0o4755);
    if (change === 'unlisted') await writeFile(join(source, 'extra'), 'UNLISTED');
    await expect(
      operations.createNativeExclusiveTree(input, new AbortController().signal, 15000, transport()),
    ).rejects.toThrow();
    await expect(lstat(join(target, 'run'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (change === 'foreign') expect(await readFile(join(target, 'foreign'), 'utf8')).toBe('KEEP');
  },
  30000,
);
it('rejects malformed, credential-named, metadata aliases, limits and missing transport before launch', async () => {
  const input = await request(),
    run = vi.fn<operations.NativeFileHelperTransport>();
  for (const path of [
    '../escape',
    '/absolute',
    'lib/../escape',
    '.git/config',
    '.GIT/config',
    '.aws/credentials',
    '.codex/auth.json',
    'lib//double',
    'lib\\escape',
  ])
    await expect(
      operations.createNativeExclusiveTree(
        { ...input, entries: [{ ...input.entries[3], path }] },
        new AbortController().signal,
        15000,
        run,
      ),
    ).rejects.toThrow();
  for (const entries of [
    [input.entries[3], input.entries[3]],
    [{ ...input.entries[3], size: 16 * 1024 * 1024 + 1 }],
    Array(10001).fill(input.entries[3]),
  ])
    await expect(
      operations.createNativeExclusiveTree(
        { ...input, entries },
        new AbortController().signal,
        15000,
        run,
      ),
    ).rejects.toThrow();
  await expect(
    operations.createNativeExclusiveTree(
      { ...input, deniedRoots: [input.originalSourcePath + '/private'] },
      new AbortController().signal,
      15000,
      run,
    ),
  ).rejects.toThrow();
  await expect(
    operations.createNativeExclusiveTree(
      input,
      new AbortController().signal,
      15000,
      undefined as never,
    ),
  ).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});
it('never exposes tree publication through the raw direct-host dispatcher', async () => {
  await expect(
    operations.executeNativeFileOperation(
      {
        ...(await request()),
        operation: 'PublishTree',
        identity: null,
        parentIdentity: await identity(target),
        limit: 1,
      },
      new AbortController().signal,
      15000,
    ),
  ).rejects.toThrow('Private helper transport unavailable');
});

actual(
  'refuses replacement of the allocation parent even when the same target inode is moved back',
  async () => {
    const input = await request(),
      taskId = await identity(target),
      parent = join(root, 'qualified-parent');
    await rename(parent, parent + '-retained');
    await mkdir(parent);
    await rename(join(parent + '-retained', 'task'), target);
    expect(await identity(target)).toEqual(taskId);
    await expect(
      operations.createNativeExclusiveTree(input, new AbortController().signal, 15000, transport()),
    ).rejects.toThrow();
    await expect(lstat(join(target, 'run'))).rejects.toMatchObject({ code: 'ENOENT' });
  },
  30000,
);

it('rejects non-string mode data without invoking coercion or transport', async () => {
  const input = await request(),
    coerce = vi.fn(() => '100644'),
    run = vi.fn<operations.NativeFileHelperTransport>();
  const bad = {
    ...input,
    entries: [{ ...input.entries[3], mode: { toString: coerce, [Symbol.toPrimitive]: coerce } }],
  };
  await expect(
    operations.createNativeExclusiveTree(bad as never, new AbortController().signal, 15000, run),
  ).rejects.toThrow();
  expect(coerce).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

actual.each(['case', 'normalization'] as const)(
  'refuses a physical %s alias of a denied ORIGINAL source child before any task write',
  async (kind) => {
    const original = join(root, kind === 'case' ? 'original-source' : 'original-café');
    await mkdir(original);
    await writeFile(join(original, 'run'), '#!/bin/sh\nexit 0\n');
    const git = (...args: string[]) =>
      execFileSync(
        '/usr/bin/git',
        [
          '-C',
          original,
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=offline@example.invalid',
          '-c',
          'commit.gpgsign=false',
          '-c',
          'core.hooksPath=/dev/null',
          ...args,
        ],
        {
          env: {
            PATH: '/usr/bin:/bin',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
          },
        },
      );
    git('init', '-q');
    git('add', 'run');
    git('commit', '-qm', 'fixture');
    const alias = kind === 'case' ? original.toUpperCase() : original.normalize('NFD');
    const physical = await identity(alias).catch(() => undefined);
    if (!physical) {
      expect(await identity(original)).toBeDefined();
      return;
    }
    expect(physical).toEqual(await identity(original));
    const input = {
      ...(await request()),
      originalSourcePath: original,
      deniedRoots: [join(alias, 'run')],
    };
    await expect(
      operations.createNativeExclusiveTree(input, new AbortController().signal, 15000, transport()),
    ).rejects.toThrow();
    await expect(lstat(join(target, 'run'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(original, 'run'), 'utf8')).toBe('#!/bin/sh\nexit 0\n');
  },
  30000,
);

actual.each(['case', 'normalization'] as const)(
  'refuses physical %s target-alias exclusions in whole preflight',
  async (kind) => {
    if (kind === 'normalization') {
      const moved = join(root, 'qualified-parent', 'task-café');
      await rename(target, moved);
      target = moved;
    }
    const input = await request(),
      alias = kind === 'case' ? target.toUpperCase() : target.normalize('NFD');
    const physical = await identity(alias).catch(() => undefined);
    if (!physical) return;
    expect(physical).toEqual(await identity(target));
    const run = transport();
    await expect(
      operations.createNativeExclusiveTree(
        { ...input, deniedRoots: [join(alias, 'run')] },
        new AbortController().signal,
        15000,
        run,
      ),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    await expect(lstat(join(target, 'run'))).rejects.toMatchObject({ code: 'ENOENT' });
  },
  30000,
);
