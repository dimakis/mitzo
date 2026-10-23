import { expect, it, vi } from 'vitest';
import type { NativeAnchoredReadRequest } from '../native-file-operation.js';
import {
  LocalRepositoryReadAccess,
  type LocalRepositoryReadAuthority,
  type LocalRepositoryReadEntry,
} from '../local-repository-read-access.js';

const root = '/fixture/anchored';
const child = (name: string): LocalRepositoryReadEntry => ({
  name,
  identity: { dev: '1', ino: String(name.charCodeAt(0)) },
  kind: 'directory',
  size: 0,
  mode: 0o40700,
  nlink: 1,
  mtimeNs: '1',
  ctimeNs: '1',
});
function fixture(batch = true) {
  const abort = new AbortController();
  let current = true;
  const rootIdentity = { dev: '1', ino: '1' };
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const listing = (path: string) => ({
    content: JSON.stringify({
      identity: path === root ? rootIdentity : child(path.at(-1)!).identity,
      entries: path === root ? names.map(child) : [],
      truncated: false,
      incomplete: false,
    }),
    is_error: false,
  });
  const assertCurrentSync = vi.fn(() => {
    if (!current) throw Error('Current native owner revoked');
  });
  const authority: LocalRepositoryReadAuthority = {
    deadline: Date.now() + 15000,
    signal: abort.signal,
    deniedRoots: [],
    assertCurrentSync,
    assertReadable: vi.fn(async () => assertCurrentSync()),
    captureReadAnchor: vi.fn(async (path) => ({ rootPath: path, identity: rootIdentity })),
    executeReadOperation: vi.fn(async (request) => listing(request.file_path)),
    ...(batch
      ? {
          executeDirectoryVerification: vi.fn(
            async (requests: readonly NativeAnchoredReadRequest[]) =>
              requests.map((request) => listing(request.file_path)),
          ),
        }
      : {}),
  };
  const ceiling = {
    assertReadable: vi.fn(async (_path: string) => {}),
    revalidate: async () => {},
  };
  const access = new LocalRepositoryReadAccess(authority, ceiling);
  const ready = async () => {
    await access.pinRoot(root);
    await access.list(root);
    vi.mocked(authority.executeReadOperation!).mockClear();
  };
  return {
    access,
    authority,
    ceiling,
    abort,
    assertCurrentSync,
    listing,
    names,
    ready,
    revoke: () => {
      current = false;
    },
  };
}

it('preloads eight already-observed sibling directories with one existing batch and no later helper lookup', async () => {
  const f = fixture();
  await f.ready();
  const paths = Object.freeze(f.names.map((name) => `${root}/${name}`));
  await f.access.preloadDirectories(paths);
  expect(f.authority.executeDirectoryVerification).toHaveBeenCalledOnce();
  const [requests, signal, timeout] = vi.mocked(f.authority.executeDirectoryVerification!).mock
    .calls[0];
  expect(requests.map((r) => r.file_path)).toEqual(paths);
  expect(
    requests.every((r) => r.operation === 'ListDirectory' && r.rootAnchor.rootPath === root),
  ).toBe(true);
  expect(signal).toBe(f.abort.signal);
  expect(timeout).toBeLessThanOrEqual(15000);
  for (const path of paths) expect(await f.access.list(path)).toEqual([]);
  expect(f.authority.executeReadOperation).not.toHaveBeenCalled();
});

it.each(['unknown', 'nested-unknown', 'duplicate', 'too-many', 'relative'] as const)(
  'refuses an unready directory set without an unknown lookup: %s',
  async (kind) => {
    const f = fixture();
    await f.ready();
    const paths =
      kind === 'unknown'
        ? [`${root}/unknown`]
        : kind === 'nested-unknown'
          ? [`${root}/a/unlisted`]
          : kind === 'duplicate'
            ? [`${root}/a`, `${root}/a`]
            : kind === 'too-many'
              ? [...f.names.map((name) => `${root}/${name}`), `${root}/i`]
              : ['relative'];
    await expect(f.access.preloadDirectories(paths)).rejects.toThrow();
    expect(f.authority.executeDirectoryVerification).not.toHaveBeenCalled();
    expect(f.authority.executeReadOperation).not.toHaveBeenCalled();
    expect(f.authority.captureReadAnchor).toHaveBeenCalledOnce();
  },
);

it.each(['malformed', 'limit', 'denied', 'cancelled', 'revoked'] as const)(
  'commits no earlier directory/exclusion/budget witness after a late %s item',
  async (kind) => {
    const f = fixture();
    await f.ready();
    let armed = false;
    f.ceiling.assertReadable.mockImplementation(async (path) => {
      if (armed && kind === 'denied' && path === `${root}/b`) throw Error('Changed ceiling');
    });
    vi.mocked(f.authority.executeDirectoryVerification!).mockImplementation(async (requests) => {
      const first = {
        content: JSON.stringify({
          identity: child('a').identity,
          entries: [{ ...child('new'), name: 'uncommitted' }],
          truncated: false,
          incomplete: true,
        }),
        is_error: false,
      };
      armed = true;
      if (kind === 'cancelled') f.abort.abort();
      if (kind === 'revoked') f.revoke();
      return [
        first,
        kind === 'malformed'
          ? { content: '{}', is_error: false }
          : kind === 'limit'
            ? { content: 'Anchored read limit exceeded', is_error: true }
            : f.listing(requests[1].file_path),
      ];
    });
    const pending = f.access.preloadDirectories([`${root}/a`, `${root}/b`]);
    if (kind === 'limit')
      await expect(pending).rejects.toMatchObject({ kind: 'limit', reason: 'snapshot-entries' });
    else await expect(pending).rejects.toThrow();
    expect(f.access.hasExclusionsWithin()).toBe(false);
    // Actual cache/budget observations, without clearing or replacing the owner.
    expect(Object.getOwnPropertyDescriptor(f.access, 'totalEntries')?.value).toBe(8);
    expect(
      (Object.getOwnPropertyDescriptor(f.access, 'directories')?.value as Map<string, unknown>)
        .size,
    ).toBe(1);
    expect(
      (Object.getOwnPropertyDescriptor(f.access, 'entries')?.value as Map<string, unknown>).has(
        `${root}/a/uncommitted`,
      ),
    ).toBe(false);
  },
);

it('keeps generic no-batch fixture reads sequential and stages them before any cache commit', async () => {
  const f = fixture(false);
  await f.ready();
  await f.access.preloadDirectories([`${root}/a`, `${root}/b`]);
  expect(f.authority.executeReadOperation).toHaveBeenCalledTimes(2);
  await f.access.list(`${root}/a`);
  await f.access.list(`${root}/b`);
  expect(f.authority.executeReadOperation).toHaveBeenCalledTimes(2);
});

it('invokes the original batch port with its authority receiver despite an own call-property replacement', async () => {
  const f = fixture();
  await f.ready();
  Object.defineProperty(f.authority.executeDirectoryVerification!, 'call', {
    value: () => {
      throw Error('Borrowed callback call property');
    },
  });
  await f.access.preloadDirectories([`${root}/a`, `${root}/b`]);
  expect(f.authority.executeDirectoryVerification).toHaveBeenCalledOnce();
});

it.each(['current-reference', 'aggregate-budget', 'aggregate-output'] as const)(
  'refuses a late %s change without staging earlier cache effects',
  async (kind) => {
    const f = fixture();
    await f.ready();
    const before = kind === 'aggregate-budget' ? 99999 : 8;
    if (kind === 'aggregate-budget')
      Object.defineProperty(f.access, 'totalEntries', { value: before, writable: true });
    vi.mocked(f.authority.executeDirectoryVerification!).mockImplementation(async (requests) => {
      if (kind === 'current-reference')
        Object.defineProperty(f.authority, 'assertCurrentSync', {
          value: () => {},
          writable: true,
          configurable: true,
        });
      return requests.map((request) => ({
        content: JSON.stringify({
          identity: child(request.file_path.at(-1)!).identity,
          truncated: false,
          incomplete: true,
          entries: [{ ...child('z'), name: 'staged' }],
          ...(kind === 'aggregate-output' ? { padding: 'x'.repeat(1100000) } : {}),
        }),
        is_error: false,
      }));
    });
    const pending = f.access.preloadDirectories([`${root}/a`, `${root}/b`]);
    if (kind === 'aggregate-budget')
      await expect(pending).rejects.toMatchObject({ kind: 'limit', reason: 'snapshot-entries' });
    else await expect(pending).rejects.toThrow();
    expect(f.access.hasExclusionsWithin()).toBe(false);
    expect(Object.getOwnPropertyDescriptor(f.access, 'totalEntries')?.value).toBe(before);
    expect(
      (Object.getOwnPropertyDescriptor(f.access, 'directories')?.value as Map<string, unknown>)
        .size,
    ).toBe(1);
  },
);

it('refuses reentrant cache drift while retaining the unrelated original observation', async () => {
  const f = fixture();
  await f.ready();
  vi.mocked(f.authority.executeDirectoryVerification!).mockImplementation(async (requests) => {
    await f.access.list(`${root}/c`);
    return requests.map((request) => ({
      content: JSON.stringify({
        identity: child(request.file_path.at(-1)!).identity,
        entries: [],
        truncated: false,
        incomplete: true,
      }),
      is_error: false,
    }));
  });
  await expect(f.access.preloadDirectories([`${root}/a`, `${root}/b`])).rejects.toThrow();
  expect(f.access.hasExclusionsWithin()).toBe(false);
  const directories = Object.getOwnPropertyDescriptor(f.access, 'directories')?.value as Map<
    string,
    unknown
  >;
  expect([...directories.keys()]).toEqual([root, `${root}/c`]);
  expect(Object.getOwnPropertyDescriptor(f.access, 'totalEntries')?.value).toBe(8);
});

it('uses one pre/post authorization for each already-known target without a redundant stat lookup', async () => {
  const f = fixture();
  await f.ready();
  vi.mocked(f.authority.assertReadable).mockClear();
  await f.access.preloadDirectories([`${root}/a`, `${root}/b`]);
  for (const path of [`${root}/a`, `${root}/b`])
    expect(
      vi.mocked(f.authority.assertReadable).mock.calls.filter(([actual]) => actual === path),
    ).toHaveLength(2);
  expect(f.authority.executeReadOperation).not.toHaveBeenCalled();
});
it('refuses mutation of the original known target identity during the batch await', async () => {
  const f = fixture();
  await f.ready();
  const original = await f.access.stat(`${root}/a`);
  vi.mocked(f.authority.executeDirectoryVerification!).mockImplementation(async (requests) => {
    original!.identity = { dev: '1', ino: '999' };
    return requests.map((request) => f.listing(request.file_path));
  });
  await expect(f.access.preloadDirectories([`${root}/a`, `${root}/b`])).rejects.toThrow();
  expect(
    (Object.getOwnPropertyDescriptor(f.access, 'directories')?.value as Map<string, unknown>).size,
  ).toBe(1);
  expect(f.access.hasExclusionsWithin()).toBe(false);
});

it('refuses a reentrant more-specific anchor while retaining the independently authorized pin', async () => {
  const f = fixture();
  await f.ready();
  vi.mocked(f.authority.captureReadAnchor).mockImplementation(async (path) => ({
    rootPath: path,
    identity: child(path.at(-1)!).identity,
  }));
  vi.mocked(f.authority.executeDirectoryVerification!).mockImplementation(async (requests) => {
    await f.access.pinRoot(`${root}/a`);
    return requests.map((request) => f.listing(request.file_path));
  });
  await expect(f.access.preloadDirectories([`${root}/a`, `${root}/b`])).rejects.toThrow();
  expect(
    (Object.getOwnPropertyDescriptor(f.access, 'directories')?.value as Map<string, unknown>).size,
  ).toBe(1);
  expect(
    (Object.getOwnPropertyDescriptor(f.access, 'anchors')?.value as Map<string, unknown>).has(
      `${root}/a`,
    ),
  ).toBe(true);
  expect(f.access.hasExclusionsWithin()).toBe(false);
});
