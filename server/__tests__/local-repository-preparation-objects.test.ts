import { execFileSync } from 'node:child_process';
import { deflateSync, inflateSync } from 'node:zlib';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRepositoryReadAccess } from '../local-repository-read-access.js';
import { inspectLocalRepositoryGitMetadata } from '../local-repository-git-inspection.js';
import { executeNativeAnchoredReadOperation } from '../native-file-operation.js';
import { fixtureReadAnchor } from './fixtures/local-repository-read-owner.js';
import { withLocalRepositoryPreparationObjects } from '../local-repository-preparation-objects.js';

let root: string, source: string;
const git = (...args: string[]) =>
  execFileSync(
    'git',
    ['-C', source, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    },
  ).trim();
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-preparation-objects-')));
  source = join(root, 'source');
  await mkdir(source);
  git('init', '-q', '-b', 'base');
  git('config', 'user.name', 'Offline fixture');
  git('config', 'user.email', 'offline@example.invalid');
  await writeFile(join(source, 'source.txt'), 'COMMITTED\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const reads: string[] = [];
  const access = new LocalRepositoryReadAccess({
    deniedRoots: [],
    deadline: Date.now() + 30000,
    assertReadable: async () => {},
    captureReadAnchor: fixtureReadAnchor,
    executeReadOperation: async (...args) => {
      if (args[0].operation === 'ReadBytes') reads.push(args[0].file_path);
      return executeNativeAnchoredReadOperation(...args);
    },
  });
  await access.pinRoot(source);
  const metadata = await inspectLocalRepositoryGitMetadata({
    path: source,
    mode: 'preparation',
    readAccess: access,
    assertReadable: (path) => access.assertPath(path),
    timeoutMs: 30000,
  });
  return {
    access,
    metadata,
    reads,
    options: { readAccess: access, timeoutMs: 30000, baseOid: git('rev-parse', 'HEAD') },
  };
}
it('qualifies required commit/tree/blobs from private bytes without mutating dirty source', async () => {
  await writeFile(join(source, 'source.txt'), 'DIRTY\n');
  await writeFile(join(source, 'untracked'), 'KEEP');
  const index = await readFile(join(source, '.git', 'index'));
  const f = await fixture();
  let scratch = '';
  await withLocalRepositoryPreparationObjects(f.metadata, f.options, async (view) => {
    scratch = view.scratch;
    expect(view.coverage).toBe('preparation-required-objects-v1');
    expect(view.baseOid).toBe(f.options.baseOid);
    expect(view.treeOid).toBe(git('rev-parse', 'HEAD^{tree}'));
    expect(
      await readFile(
        join(view.gitDirectory, 'objects', view.baseOid.slice(0, 2), view.baseOid.slice(2)),
      ),
    ).toBeTruthy();
  });
  await expect(readFile(join(scratch, 'config'))).rejects.toThrow();
  expect(await readFile(join(source, '.git', 'index'))).toEqual(index);
  expect(await readFile(join(source, 'source.txt'), 'utf8')).toBe('DIRTY\n');
  expect(await readFile(join(source, 'untracked'), 'utf8')).toBe('KEEP');
}, 30000);
it('never reads omitted object info, alternate targets or executable source config', async () => {
  const outside = join(root, 'private-canary');
  await writeFile(outside, 'DO NOT READ');
  await writeFile(join(source, '.git', 'objects', 'info', 'alternates'), outside + '\n');
  await symlink(outside, join(source, '.git', 'objects', 'info', 'commit-graph'));
  const f = await fixture();
  await withLocalRepositoryPreparationObjects(f.metadata, f.options, async () => {});
  expect(
    f.reads.some(
      (path) => path.startsWith(join(source, '.git', 'objects', 'info')) || path === outside,
    ),
  ).toBe(false);
}, 30000);
it('refuses a required commit supplied only by an omitted alternate without probing its target', async () => {
  const f = await fixture();
  const oid = f.options.baseOid;
  const object = join(source, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
  const saved = await readFile(object);
  await rm(object);
  const alternate = join(root, 'private-store');
  await mkdir(alternate);
  await writeFile(join(alternate, 'secret'), saved);
  await writeFile(join(source, '.git', 'objects', 'info', 'alternates'), alternate + '\n');
  await expect(
    withLocalRepositoryPreparationObjects(f.metadata, f.options, async () => {
      throw Error('must not publish');
    }),
  ).rejects.toThrow('Preparation objects unavailable');
  expect(f.reads.some((path) => path.startsWith(alternate))).toBe(false);
}, 30000);
it.for(['symlink', 'hardlink'] as const)(
  'refuses consumed %s storage without following or changing it',
  async (kind) => {
    const oid = git('rev-parse', 'HEAD');
    const object = join(source, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
    const outside = join(root, 'canary');
    const bytes = await readFile(object);
    await writeFile(outside, bytes);
    await rm(object);
    if (kind === 'symlink') await symlink(outside, object);
    else await link(outside, object);
    const f = await fixture();
    await expect(
      withLocalRepositoryPreparationObjects(f.metadata, f.options, async () => {}),
    ).rejects.toThrow('Preparation objects unavailable');
    expect(await readFile(outside)).toEqual(bytes);
  },
);
it('supports fixed private packed storage without reading source object info', async () => {
  git('repack', '-ad');
  const f = await fixture();
  await withLocalRepositoryPreparationObjects(f.metadata, f.options, async (view) => {
    expect(view.baseOid).toBe(f.options.baseOid);
  });
  expect(f.reads.some((path) => path.endsWith('.pack'))).toBe(true);
  expect(f.reads.some((path) => path.includes('/objects/info/'))).toBe(false);
}, 30000);

it('refuses a blob whose valid compression/header conceals content not matching its object name', async () => {
  const oid = git('rev-parse', 'HEAD:source.txt');
  const object = join(source, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
  const decoded = inflateSync(await readFile(object));
  decoded[decoded.length - 2] ^= 1;
  await chmod(object, 0o600);
  await writeFile(object, deflateSync(decoded));
  const f = await fixture();
  await expect(
    withLocalRepositoryPreparationObjects(f.metadata, f.options, async () => {}),
  ).rejects.toThrow('Preparation objects unavailable');
}, 30000);

it('rechecks consumed storage after the action and preserves changed source bytes on refusal', async () => {
  const f = await fixture();
  const oid = f.options.baseOid;
  const object = join(source, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
  await expect(
    withLocalRepositoryPreparationObjects(f.metadata, f.options, async () => {
      await chmod(object, 0o600);
      await writeFile(object, 'CHANGED');
    }),
  ).rejects.toThrow('Preparation objects unavailable');
  expect(await readFile(object, 'utf8')).toBe('CHANGED');
}, 30000);

it('qualifies a shallow base without requiring unconsumed parent history', async () => {
  const parent = git('rev-parse', 'HEAD');
  await writeFile(join(source, 'source.txt'), 'NEXT\n');
  git('add', '.');
  git('commit', '-qm', 'next');
  await writeFile(join(source, '.git', 'shallow'), git('rev-parse', 'HEAD') + '\n');
  await rm(join(source, '.git', 'objects', parent.slice(0, 2), parent.slice(2)));
  git('fsck', '--no-reflogs');
  const f = await fixture();
  await withLocalRepositoryPreparationObjects(f.metadata, f.options, async (view) => {
    expect(view.baseOid).toBe(f.options.baseOid);
  });
}, 30000);

it('preserves a superproject gitlink without requiring or fetching the external commit', async () => {
  const external = '1234567890abcdef1234567890abcdef12345678';
  git('update-index', '--add', '--cacheinfo', `160000,${external},submodule`);
  git('commit', '-qm', 'gitlink');
  const f = await fixture();
  await withLocalRepositoryPreparationObjects(f.metadata, f.options, async (view) => {
    const checkout = join(view.scratch, 'checkout');
    await mkdir(checkout);
    const run = (...args: string[]) =>
      execFileSync(
        '/usr/bin/git',
        ['--git-dir', view.gitDirectory, '--work-tree', checkout, ...args],
        {
          encoding: 'utf8',
          env: {
            PATH: '/usr/bin:/bin',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_NO_LAZY_FETCH: '1',
          },
        },
      );
    run('read-tree', view.baseOid);
    run('checkout-index', '--all');
    expect(await readFile(join(checkout, 'source.txt'), 'utf8')).toBe('COMMITTED\n');
    expect(run('ls-files', '--stage')).toContain(`160000 ${external}`);
    await expect(
      readFile(join(view.gitDirectory, 'objects', external.slice(0, 2), external.slice(2))),
    ).rejects.toThrow();
  });
}, 30000);

it('refuses compressed object headers declaring oversized expansion before publishing a view', async () => {
  await writeFile(join(source, 'large'), Buffer.alloc(16 * 1024 * 1024 + 1, 65));
  git('add', 'large');
  git('commit', '-qm', 'large');
  const f = await fixture();
  let published = false;
  await expect(
    withLocalRepositoryPreparationObjects(f.metadata, f.options, async () => {
      published = true;
    }),
  ).rejects.toThrow('Preparation objects unavailable');
  expect(published).toBe(false);
}, 30000);

it('retains a foreign replacement when failed actor cleanup sees changed private scratch custody', async () => {
  const f = await fixture();
  let scratch = '';
  try {
    await expect(
      withLocalRepositoryPreparationObjects(f.metadata, f.options, async (view) => {
        scratch = view.scratch;
        await import('node:fs/promises').then((fs) =>
          fs.rename(scratch, scratch + '-owned-retained'),
        );
        await mkdir(scratch);
        await writeFile(join(scratch, 'FOREIGN-CANARY'), 'KEEP FOREIGN');
        throw Error('actor setup refused');
      }),
    ).rejects.toThrow('Preparation objects unavailable');
    expect(await readFile(join(scratch, 'FOREIGN-CANARY'), 'utf8')).toBe('KEEP FOREIGN');
  } finally {
    if (scratch) {
      await rm(scratch, { recursive: true, force: true });
      await rm(scratch + '-owned-retained', { recursive: true, force: true });
    }
  }
}, 30000);

it('observes object parents before joining at most two independent byte reads per wave', async () => {
  const f = await fixture();
  const preload = vi.spyOn(f.access, 'preloadDirectories');
  const original = f.access.read.bind(f.access);
  const originalList = f.access.list.bind(f.access);
  const observedParents = new Set<string>();
  let active = 0,
    peak = 0;
  vi.spyOn(f.access, 'list').mockImplementation(async (...args) => {
    expect(active).toBe(0);
    const entries = await originalList(...args);
    observedParents.add(args[0]);
    return entries;
  });
  vi.spyOn(f.access, 'read').mockImplementation(async (path, limit) => {
    expect(observedParents.has(path.slice(0, path.lastIndexOf('/')))).toBe(true);
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return await original(path, limit);
    } finally {
      active--;
    }
  });
  await withLocalRepositoryPreparationObjects(f.metadata, f.options, async () => {});
  expect(peak).toBe(2);
  expect(active).toBe(0);
  expect(preload).not.toHaveBeenCalled();
}, 30000);

it.each(['failure', 'abort'] as const)(
  'joins a %s object wave before refusing and never launches the next wave',
  async (kind) => {
    const f = await fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    let started = 0,
      settled = false;
    vi.spyOn(f.access, 'read').mockImplementation(async () => {
      const index = started++;
      if (index === 0) {
        if (kind === 'abort') controller.abort(Error('Preparation objects unavailable'));
        throw Error('synthetic first object refusal');
      }
      await held;
      throw Error('synthetic joined second object refusal');
    });
    const pending = withLocalRepositoryPreparationObjects(
      f.metadata,
      { ...f.options, signal: controller.signal },
      async () => {
        throw Error('must not publish');
      },
    ).finally(() => {
      settled = true;
    });
    const outcome = expect(pending).rejects.toThrow('Preparation objects unavailable');
    try {
      for (let i = 0; i < 1000 && started < 2 && !settled; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(started).toBe(2);
      expect(settled).toBe(false);
    } finally {
      release();
      await outcome;
    }
    expect(started).toBe(2);
  },
  30000,
);

it('preserves ordinary listing coverage for numerous optional pack accelerators', async () => {
  const pack = join(source, '.git', 'objects', 'pack');
  for (let index = 0; index < 5000; index++)
    await writeFile(join(pack, `pack-${index.toString(16).padStart(40, '0')}.keep`), '');
  const f = await fixture();
  const preload = vi.spyOn(f.access, 'preloadDirectories');
  await expect(
    withLocalRepositoryPreparationObjects(f.metadata, f.options, async () => {}),
  ).resolves.toBeUndefined();
  expect(preload.mock.calls.every(([paths]) => !paths.includes(pack))).toBe(true);
  expect(f.reads.some((path) => path.endsWith('.keep'))).toBe(false);
}, 60000);

it('bounds expanded checkout content independently of unrelated historical blobs', async () => {
  await writeFile(join(source, 'historical-large'), Buffer.alloc(16 * 1024 * 1024 + 1, 65));
  git('add', 'historical-large');
  git('commit', '-qm', 'large historical file');
  git('rm', '-q', 'historical-large');
  git('commit', '-qm', 'remove historical file');
  const f = await fixture();
  await expect(
    withLocalRepositoryPreparationObjects(f.metadata, f.options, async (view) => {
      expect(view.entries.some((entry) => entry.path === 'historical-large')).toBe(false);
    }),
  ).resolves.toBeUndefined();
}, 30000);
