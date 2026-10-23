import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { LocalRepositoryReadAccess } from '../local-repository-read-access.js';
import { executeNativeAnchoredReadOperation } from '../native-file-operation.js';
import { fixtureReadAnchor } from './fixtures/local-repository-read-owner.js';
const MiB = 1024 * 1024;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** Real sparse fixture entries/identities; synthetic byte transport deliberately
 * isolates the controller's aggregate accounting, not native-byte qualification. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-read-budget-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const seeds = ['one', 'two', 'three'].map((name) => join(root, name));
  const targets = ['a', 'b', 'c'].map((name) => join(root, name));
  for (const file of [...seeds, ...targets]) {
    const handle = await open(file, 'wx', 0o600);
    try {
      await handle.truncate(seeds.includes(file) ? 16 * MiB : 12 * MiB);
    } finally {
      await handle.close();
    }
  }
  const bytes = new Map([
    [8 * MiB, Buffer.alloc(8 * MiB).toString('base64')],
    [16 * MiB, Buffer.alloc(16 * MiB).toString('base64')],
    [12 * MiB, Buffer.alloc(12 * MiB).toString('base64')],
  ]);
  let before: (path: string) => Promise<void> = async () => {};
  let live = true;
  let malformed = false;
  const launches = vi.fn(async (path: string) => {
    await before(path);
  });
  const access = new LocalRepositoryReadAccess({
    deniedRoots: [],
    deadline: Date.now() + 30000,
    captureReadAnchor: fixtureReadAnchor,
    assertReadable: async () => {
      if (!live) throw Error('owner revoked');
    },
    executeReadOperation: async (request, signal, timeout) => {
      if (request.operation !== 'ReadBytes')
        return executeNativeAnchoredReadOperation(request, signal, timeout);
      await launches(request.file_path);
      return {
        content: malformed ? '?' : bytes.get(request.limit)!,
        is_error: false,
        ...(request.prefix ? { truncated: request.limit < request.expectedState!.size } : {}),
      };
    },
  });
  await access.pinRoot(root);
  await access.list(root);
  for (const seed of seeds) await access.read(seed, 16 * MiB);
  launches.mockClear();
  return {
    access,
    seeds,
    targets,
    launches,
    before: (action: typeof before) => {
      before = action;
    },
    revoke: () => {
      live = false;
    },
    restore: () => {
      live = true;
    },
    malformed: (value: boolean) => {
      malformed = value;
    },
  };
}

it('reserves distinct in-flight reads before awaits so the second near-cap request never launches', async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.before(async () => {
    entered();
    await held;
  });
  const joined = Promise.allSettled(
    f.targets.slice(0, 2).map((path) => f.access.read(path, 12 * MiB)),
  );
  await started;
  try {
    await setImmediate();
    expect(f.launches).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await joined;
  }
  const results = await joined;
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
  const denied = results[1] as PromiseRejectedResult;
  expect(denied.reason).toMatchObject({ kind: 'limit', reason: 'snapshot-bytes' });
  expect(f.launches.mock.calls.map(([path]) => path)).toEqual([f.targets[0]]);
});

it('retains cached observations at the cap without charging or launching another byte read', async () => {
  const f = await fixture();
  await f.access.read(f.targets[0], 12 * MiB); // 60 MiB captured.
  const before = f.launches.mock.calls.length;
  expect((await f.access.read(f.seeds[0], 16 * MiB)).length).toBe(16 * MiB);
  expect(f.launches).toHaveBeenCalledTimes(before);
  f.revoke();
  await expect(f.access.read(f.seeds[0], 16 * MiB)).rejects.toThrow();
  expect(f.launches).toHaveBeenCalledTimes(before);
});

it.each(['transport', 'post-read-owner'] as const)(
  'releases an in-flight reservation after %s failure without permitting a budget overflow',
  async (point) => {
    const f = await fixture();
    f.before(async (path) => {
      if (path === f.targets[0]) {
        if (point === 'transport') throw Error('synthetic failed helper');
        f.revoke();
      }
    });
    await expect(f.access.read(f.targets[0], 12 * MiB)).rejects.toThrow();
    f.restore();
    f.before(async () => {});
    expect((await f.access.read(f.targets[1], 12 * MiB)).length).toBe(12 * MiB);
    await expect(f.access.read(f.targets[2], 12 * MiB)).rejects.toMatchObject({ kind: 'limit' });
    expect(f.launches.mock.calls.map(([path]) => path)).toEqual([f.targets[0], f.targets[1]]);
  },
);

it('releases rejected response reservations and rejects invalid limits without poisoning later capacity', async () => {
  const f = await fixture();
  for (const limit of [NaN, Infinity, -1, 0, 0.5])
    await expect(f.access.read(f.targets[0], limit)).rejects.toMatchObject({ kind: 'limit' });
  expect(f.launches).not.toHaveBeenCalled();
  f.malformed(true);
  await expect(f.access.read(f.targets[0], 12 * MiB)).rejects.toThrow();
  f.malformed(false);
  expect((await f.access.read(f.targets[1], 12 * MiB)).length).toBe(12 * MiB);
  await expect(f.access.read(f.targets[2], 12 * MiB)).rejects.toMatchObject({ kind: 'limit' });
  expect(f.launches).toHaveBeenCalledTimes(2);
});

it('settles two independent bounded prefixes at the exact cap and refuses a later physical read', async () => {
  const f = await fixture();
  const results = await Promise.allSettled(
    f.targets.slice(0, 2).map((path) => f.access.readPrefix(path, 8 * MiB)),
  );
  expect(
    results.every((result) => result.status === 'fulfilled' && result.value.length === 8 * MiB),
  ).toBe(true);
  await expect(f.access.read(f.targets[2], 12 * MiB)).rejects.toMatchObject({ kind: 'limit' });
  expect(f.launches).toHaveBeenCalledTimes(2);
});
