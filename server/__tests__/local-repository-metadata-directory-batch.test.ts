import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promisify } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
  LocalRepositoryReadAccess,
  type LocalRepositoryReadAuthority,
} from '../local-repository-read-access.js';
import { inspectLocalRepositoryGitMetadata } from '../local-repository-git-inspection.js';
import {
  captureNativeReadAnchor,
  executeNativeAnchoredReadOperation,
  executeNativeDirectoryVerificationBatch,
  freezeNativeDirectoryVerificationInputs,
} from '../native-file-operation.js';

// Explicit descriptor-owner mechanism fixture; actual signed/native/SRT
// qualification remains the registered mechanical fixture.
vi.setConfig({ testTimeout: 30000 });
let root: string, source: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-metadata-batch-')));
  source = join(root, 'source');
  await mkdir(source);
  execFileSync('/usr/bin/git', ['-C', source, 'init', '--template=', '-q', '-b', 'main'], {
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
    await mkdir(join(source, '.git', 'refs', `namespace-${name}`));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function fixture() {
  const signal = AbortSignal.timeout(30000),
    deadline = Date.now() + 30000;
  const check = (path: string) => {
    signal.throwIfAborted();
    const rest = relative(root, path);
    if (isAbsolute(rest) || rest === '..' || rest.startsWith(`..${sep}`))
      throw Error('Fixture path outside scope');
  };
  const authority: LocalRepositoryReadAuthority = {
    deadline,
    signal,
    deniedRoots: [],
    assertCurrentSync: () => signal.throwIfAborted(),
    assertReadable: async (path) => check(path),
    captureReadAnchor: (path) =>
      captureNativeReadAnchor({ file_path: path, deniedRoots: [] }, signal, deadline - Date.now()),
    executeReadOperation: vi.fn(executeNativeAnchoredReadOperation),
    executeDirectoryVerification: vi.fn((requests, requestSignal, timeoutMs) => {
      const captured = freezeNativeDirectoryVerificationInputs(requests);
      return executeNativeDirectoryVerificationBatch(
        {
          operation: 'ListDirectoryBatch',
          deniedRoots: Object.freeze([...new Set(captured.flatMap((item) => item.deniedRoots))]),
          items: captured.map(({ deniedRoots: _, ...item }) => ({
            ...item,
            operation: 'ListDirectory' as const,
          })),
        },
        requestSignal,
        timeoutMs,
        async (input) => {
          const result = await promisify(execFile)('/bin/sh', ['-c', input.command], {
            cwd: root,
            env: { PATH: '/usr/bin:/bin' },
            signal: input.signal,
            timeout: input.timeoutMs,
            maxBuffer: input.maxOutputBytes,
          });
          return { stdout: result.stdout, isError: false };
        },
      );
    }),
  };
  const access = new LocalRepositoryReadAccess(authority);
  return { authority, access };
}
it('uses bounded ready-directory batches while retaining complete generic Git metadata coverage', async () => {
  const f = fixture();
  await f.access.pinRoot(source);
  const metadata = await inspectLocalRepositoryGitMetadata({
    path: source,
    readAccess: f.access,
    assertReadable: (path) => f.access.assertPath(path),
    signal: f.authority.signal,
    timeoutMs: 30000,
  });
  expect(metadata.referenceCoverage).toBeUndefined();
  expect(metadata.qualification).toBeUndefined();
  const batches = vi.mocked(f.authority.executeDirectoryVerification!).mock.calls;
  const singleBefore = vi
    .mocked(f.authority.executeReadOperation!)
    .mock.calls.filter(([request]) => request.operation === 'ListDirectory').length;
  if (process.env.MITZO_READ_BATCH_COUNTS_PATH)
    await writeFile(
      process.env.MITZO_READ_BATCH_COUNTS_PATH,
      JSON.stringify({
        batchSizes: batches.map(([items]) => items.length),
        singleDirectoryHelpers: singleBefore,
        totalDirectoryHelpers: singleBefore + batches.length,
      }),
      { flag: 'wx' },
    );
  expect(batches.some(([items]) => items.length > 1)).toBe(true);
  expect(
    batches.every(
      ([items]) =>
        items.length >= 1 &&
        items.length <= 8 &&
        items.every((item) => item.operation === 'ListDirectory'),
    ),
  ).toBe(true);
  const directories = new Set(batches.flatMap(([items]) => items.map((item) => item.file_path)));
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
    expect(directories.has(join(source, '.git', 'refs', `namespace-${name}`))).toBe(true);
  const single = vi
    .mocked(f.authority.executeReadOperation!)
    .mock.calls.filter(([request]) => request.operation === 'ListDirectory');
  const observedDirectories = new Set([
    ...directories,
    ...single.map(([request]) => request.file_path),
  ]);
  expect(single.length + batches.length).toBeLessThanOrEqual(
    Math.ceil(observedDirectories.size / 2),
  );
  await f.access.verify();
});
it('retains unsafe-ref detection in the last sibling rather than narrowing generic coverage', async () => {
  await symlink(join(root, 'outside'), join(source, '.git', 'refs', 'namespace-h', 'unsafe-ref'));
  const f = fixture();
  await f.access.pinRoot(source);
  await expect(
    inspectLocalRepositoryGitMetadata({
      path: source,
      readAccess: f.access,
      assertReadable: (path) => f.access.assertPath(path),
      signal: f.authority.signal,
      timeoutMs: 30000,
    }),
  ).rejects.toMatchObject({ reason: 'symlinks-unavailable' });
});
