import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
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
import * as files from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import * as operations from '../native-file-operation.js';
import * as sandbox from '../sandboxed-command.js';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';

const rmHarness = vi.hoisted(() => ({
  real: undefined as typeof import('node:fs/promises').rm | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  rmHarness.real = actual.rm;
  return { ...actual, rm: vi.fn(actual.rm) };
});

let root: string, parent: string, scratch: string, payload: string, target: string;
const bytes = Buffer.from([0, 1, 2, 128, 255, 10]);
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const identity = async (path: string) => {
  const info = await lstat(path, { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino) };
};
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-exclusive-file-')));
  parent = join(root, 'qualified-parent');
  scratch = join(root, 'owned-scratch');
  payload = join(scratch, 'generated');
  target = join(parent, 'registration');
  await mkdir(parent);
  await mkdir(scratch);
  await writeFile(payload, bytes);
  await writeFile(join(parent, 'source-index-witness'), 'SOURCE BYTES');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(files.rm).mockImplementation(rmHarness.real!);
  await rm(root, { recursive: true, force: true });
});
async function request() {
  return {
    file_path: target,
    rootAnchor: { rootPath: parent, identity: await identity(parent) },
    parentIdentity: await identity(parent),
    expectedAbsent: true as const,
    payload: {
      file_path: payload,
      rootAnchor: { rootPath: scratch, identity: await identity(scratch) },
      parentIdentity: await identity(scratch),
      identity: await identity(payload),
      size: bytes.length,
      sha256: sha(bytes),
    },
    deniedRoots: Object.freeze([] as string[]),
  };
}

function transport(signal = new AbortController().signal) {
  return vi.fn<operations.NativeFileHelperTransport>(async (invocation) => {
    // Explicit synthetic scope only. Production derives it from the actual
    // consumed operation and phase-owned parent identities, not this fixture.
    const result = await sandbox.executePrivateNativeFileHelper({
      requestJson: invocation.requestJson,
      cwd: scratch,
      writableRoots: Object.freeze([
        Object.freeze({
          path: scratch,
          parentAnchor: { rootPath: scratch, identity: await identity(scratch) },
        }),
        Object.freeze({
          path: target,
          parentAnchor: { rootPath: parent, identity: await identity(parent) },
        }),
      ]),
      deniedRoots: Object.freeze([]),
      signal: AbortSignal.any([signal, invocation.signal]),
      timeoutMs: invocation.timeoutMs,
      maxOutputBytes: invocation.maxOutputBytes,
      assertCurrentSync() {
        signal.throwIfAborted();
      },
      async revalidate() {
        signal.throwIfAborted();
      },
    });
    return { stdout: result.stdout ?? '', isError: result.isError };
  });
}
const actual = it.runIf(
  process.platform === 'darwin' && process.env.MITZO_SANDBOX_INTEGRATION === '1',
);

actual(
  'copies exact binary bytes into an exclusively created file through the fixed private SRT runner',
  async () => {
    const created = await operations.createNativeExclusiveFile(
      await request(),
      new AbortController().signal,
      15000,
      transport(),
    );
    expect(created).toEqual({
      file_path: target,
      identity: await identity(target),
      byteLength: bytes.length,
      sha256: sha(bytes),
    });
    expect(await readFile(target)).toEqual(bytes);
    expect((await lstat(target)).mode & 0o777).toBe(0o600);
    expect(Object.isFrozen(created.identity)).toBe(true);
    expect(await readFile(join(parent, 'source-index-witness'), 'utf8')).toBe('SOURCE BYTES');
  },
  30000,
);

actual.each(['file', 'symlink'] as const)(
  'refuses a foreign target %s without overwrite or adoption',
  async (kind) => {
    const input = await request();
    if (kind === 'file') await writeFile(target, 'FOREIGN');
    else await symlink(join(parent, 'source-index-witness'), target);
    const foreign = await identity(target);
    await expect(
      operations.createNativeExclusiveFile(input, new AbortController().signal, 15000, transport()),
    ).rejects.toThrow();
    expect(await identity(target)).toEqual(foreign);
    expect(await readFile(target, 'utf8')).toBe(kind === 'file' ? 'FOREIGN' : 'SOURCE BYTES');
  },
  30000,
);

actual.each(['parent', 'payload-identity', 'payload-bytes'] as const)(
  'refuses changed original %s before publishing',
  async (change) => {
    const input = await request();
    if (change === 'parent') {
      await rename(parent, parent + '-old');
      await mkdir(parent);
    }
    if (change === 'payload-identity') {
      await rename(payload, payload + '-old');
      await writeFile(payload, bytes);
    }
    if (change === 'payload-bytes') await writeFile(payload, Buffer.alloc(bytes.length, 42));
    await expect(
      operations.createNativeExclusiveFile(input, new AbortController().signal, 15000, transport()),
    ).rejects.toThrow();
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  },
  30000,
);

actual(
  'retains the uncertain file if cancellation wins after the helper has created it',
  async () => {
    const abort = new AbortController();
    const run = transport();
    const cancelled: operations.NativeFileHelperTransport = async (invocation) => {
      const result = await run(invocation);
      abort.abort();
      return result;
    };
    await expect(
      operations.createNativeExclusiveFile(await request(), abort.signal, 15000, cancelled),
    ).rejects.toThrow();
    expect(await readFile(target)).toEqual(bytes);
  },
  30000,
);

it('refuses malformed, denied, oversized and missing-transport file requests before any launch', async () => {
  const input = await request();
  const run = vi.fn<operations.NativeFileHelperTransport>();
  for (const bad of [
    { ...input, deniedRoots: undefined },
    { ...input, deniedRoots: [parent] },
    { ...input, deniedRoots: [scratch] },
    { ...input, expectedAbsent: false },
    { ...input, payload: { ...input.payload, size: 16 * 1024 * 1024 + 1 } },
    { ...input, payload: { ...input.payload, sha256: 'not-a-sha' } },
    { ...input, payload: { ...input.payload, file_path: scratch + '/..' } },
    { ...input, payload: { ...input.payload, identity: { dev: 'bad', ino: '1' } } },
  ])
    await expect(
      operations.createNativeExclusiveFile(bad as never, new AbortController().signal, 15000, run),
    ).rejects.toThrow();
  await expect(
    operations.createNativeExclusiveFile(
      input,
      new AbortController().signal,
      15000,
      undefined as never,
    ),
  ).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
  await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses private file publication through the legacy direct-host dispatcher', async () => {
  await expect(
    operations.executeNativeFileOperation(
      { ...(await request()), operation: 'CreateFile', identity: null, limit: 1 },
      new AbortController().signal,
      15000,
    ),
  ).rejects.toThrow('Private helper transport unavailable');
  await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('checks the actual full owner before sandbox dependency or scope setup', async () => {
  const input = {
    ...(await request()),
    operation: 'CreateFile',
    identity: null,
    limit: 1,
    timeoutMs: 15000,
  };
  const dependencies = vi.spyOn(SandboxManager, 'checkDependencies');
  const current = vi.fn();
  const revalidate = vi.fn(async () => {
    throw Error('Original owner revoked');
  });
  await expect(
    sandbox.executePrivateNativeFileHelper({
      requestJson: JSON.stringify(input),
      cwd: scratch,
      writableRoots: [
        { path: scratch, parentAnchor: input.payload.rootAnchor },
        { path: target, parentAnchor: input.rootAnchor },
      ],
      deniedRoots: [],
      signal: new AbortController().signal,
      timeoutMs: 15000,
      maxOutputBytes: 32768,
      assertCurrentSync: current,
      revalidate,
    }),
  ).rejects.toThrow('Original owner revoked');
  expect(revalidate).toHaveBeenCalledOnce();
  expect(dependencies).not.toHaveBeenCalled();
  await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
});

actual(
  'does not inspect or expand a Git marker inside the independently owned actor scratch',
  async () => {
    await writeFile(join(scratch, '.git'), 'gitdir: /synthetic/never-probe-this-metadata');
    await operations.createNativeExclusiveFile(
      await request(),
      new AbortController().signal,
      15000,
      transport(),
    );
    expect(await readFile(target)).toEqual(bytes);
  },
  30000,
);

actual(
  'revalidates the original owner after joined worker cleanup rejects, retaining uncertain published bytes',
  async () => {
    const realRm = rmHarness.real!;
    let retainedCleanup: string | undefined;
    vi.mocked(files.rm).mockImplementation(async (path, options) => {
      if (typeof path === 'string' && path.split('/').at(-1)?.startsWith('mitzo-shell-')) {
        retainedCleanup = path;
        throw Error('Synthetic private cleanup diagnostic must not escape');
      }
      return realRm(path, options);
    });
    const input = await request();
    let validations = 0;
    let live = true;
    const run: operations.NativeFileHelperTransport = async (invocation) => {
      const result = await sandbox.executePrivateNativeFileHelper({
        requestJson: invocation.requestJson,
        cwd: scratch,
        writableRoots: [
          { path: scratch, parentAnchor: input.payload.rootAnchor },
          { path: target, parentAnchor: input.rootAnchor },
        ],
        deniedRoots: [],
        signal: invocation.signal,
        timeoutMs: invocation.timeoutMs,
        maxOutputBytes: invocation.maxOutputBytes,
        assertCurrentSync() {
          if (!live) throw Error('Original owner revoked after cleanup');
        },
        async revalidate() {
          validations++;
          if (validations === 3) live = false;
        },
      });
      return { stdout: result.stdout ?? '', isError: result.isError };
    };
    try {
      await expect(
        operations.createNativeExclusiveFile(input, new AbortController().signal, 15000, run),
      ).rejects.toThrow('Exclusive native file unavailable');
      expect(retainedCleanup).toBeDefined();
      expect(validations).toBe(3);
      expect(await readFile(target)).toEqual(bytes);
    } finally {
      vi.restoreAllMocks();
      if (retainedCleanup) await realRm(retainedCleanup, { recursive: true, force: true });
    }
  },
  30000,
);

it('refuses accessor root arrays without invoking them or calling the actual owner', async () => {
  const input = {
    ...(await request()),
    operation: 'CreateFile',
    identity: null,
    limit: 1,
    timeoutMs: 15000,
  };
  const roots = [{ path: scratch, parentAnchor: input.payload.rootAnchor }];
  const getter = vi.fn(() => {
    throw Error('Root accessor must not execute');
  });
  Object.defineProperty(roots, '1', { get: getter });
  const revalidate = vi.fn(async () => {});
  await expect(
    sandbox.executePrivateNativeFileHelper({
      requestJson: JSON.stringify(input),
      cwd: scratch,
      writableRoots: roots,
      deniedRoots: [],
      signal: new AbortController().signal,
      timeoutMs: 15000,
      maxOutputBytes: 32768,
      assertCurrentSync() {},
      revalidate,
    }),
  ).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(revalidate).not.toHaveBeenCalled();
});

actual.each(['symlink', 'hardlink', 'fifo'] as const)(
  'refuses a consumed payload %s before creating a target',
  async (kind) => {
    const input = await request();
    if (kind === 'hardlink') await files.link(payload, payload + '-alias');
    else {
      await files.rename(payload, payload + '-retained');
      if (kind === 'symlink') await files.symlink(payload + '-retained', payload);
      else execFileSync('/usr/bin/mkfifo', [payload]);
      input.payload.identity = await identity(payload);
    }
    await expect(
      operations.createNativeExclusiveFile(input, new AbortController().signal, 15000, transport()),
    ).rejects.toThrow('Exclusive native file unavailable');
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  },
  30000,
);

actual.each(['case', 'normalization'] as const)(
  'keeps actual SRT denial across a physical %s alias',
  async (kind) => {
    if (kind === 'normalization') {
      const moved = join(root, 'qualified-café');
      await rename(parent, moved);
      parent = moved;
      target = join(parent, 'registration');
    }
    const alias = kind === 'case' ? parent.toUpperCase() : parent.normalize('NFD');
    const aliasedIdentity = await identity(alias).catch(() => undefined);
    if (!aliasedIdentity) {
      // Explicit case-sensitive/normalization-distinct platform control. Never
      // infer equivalence by lowercasing or normalizing a permission path.
      await expect(lstat(join(alias, 'registration'))).rejects.toThrow();
      return;
    }
    expect(aliasedIdentity).toEqual(await identity(parent));
    const input = await request();
    input.file_path = join(alias, 'registration');
    input.rootAnchor.rootPath = alias;
    input.deniedRoots = Object.freeze([parent]);
    const run: operations.NativeFileHelperTransport = async (invocation) => {
      const result = await sandbox.executePrivateNativeFileHelper({
        requestJson: invocation.requestJson,
        cwd: scratch,
        writableRoots: [
          { path: scratch, parentAnchor: input.payload.rootAnchor },
          { path: input.file_path, parentAnchor: input.rootAnchor },
        ],
        deniedRoots: input.deniedRoots,
        signal: invocation.signal,
        timeoutMs: invocation.timeoutMs,
        maxOutputBytes: invocation.maxOutputBytes,
        assertCurrentSync() {},
        async revalidate() {},
      });
      return { stdout: result.stdout ?? '', isError: result.isError };
    };
    await expect(
      operations.createNativeExclusiveFile(input, new AbortController().signal, 15000, run),
    ).rejects.toThrow('Exclusive native file unavailable');
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  },
  30000,
);

it('refuses replaced owned actor scratch before dependency setup or a worker launch', async () => {
  const input = {
    ...(await request()),
    operation: 'CreateFile',
    identity: null,
    limit: 1,
    timeoutMs: 15000,
  };
  await rename(scratch, scratch + '-retained');
  await mkdir(scratch);
  const dependencies = vi
    .spyOn(SandboxManager, 'checkDependencies')
    .mockReturnValue({ errors: ['fixture stop after scope'], warnings: [] });
  await expect(
    sandbox.executePrivateNativeFileHelper({
      requestJson: JSON.stringify(input),
      cwd: scratch,
      writableRoots: [
        { path: scratch, parentAnchor: input.payload.rootAnchor },
        { path: target, parentAnchor: input.rootAnchor },
      ],
      deniedRoots: [],
      signal: new AbortController().signal,
      timeoutMs: 15000,
      maxOutputBytes: 32768,
      assertCurrentSync() {},
      async revalidate() {},
    }),
  ).rejects.toThrow();
  expect(dependencies).not.toHaveBeenCalled();
  await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
});
