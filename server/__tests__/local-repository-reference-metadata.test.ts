import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRepositoryReadAccess } from '../local-repository-read-access.js';
import {
  inspectLocalRepositoryGitMetadata,
  readLocalRepositoryStatus,
} from '../local-repository-git-inspection.js';
import {
  readLocalRepositoryGitFacts,
  readLocalRepositorySnapshotStatus,
} from '../local-repository-git-snapshot.js';
import { executeNativeAnchoredReadOperation } from '../native-file-operation.js';
import { fixtureReadAnchor } from './fixtures/local-repository-read-owner.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture(denyObjects = true) {
  const source = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-reference-metadata-')));
  cleanups.push(() => rm(source, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        source,
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'maintenance.auto=false',
        '-c',
        'gc.auto=0',
        ...args,
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      },
    ).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Offline fixture');
  git('config', 'user.email', 'offline@example.invalid');
  await writeFile(join(source, 'fixture.txt'), 'ORIGINAL SOURCE');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD');
  await mkdir(join(source, '.git', 'objects', 'not-a-ref-input'));
  const objects = join(source, '.git', 'objects');
  const alternate = join(source, 'unread-alternate-store');
  await mkdir(alternate);
  await writeFile(join(alternate, 'foreign-witness'), 'UNREAD ALTERNATE BYTES');
  await writeFile(join(objects, 'info', 'alternates'), alternate + '\n');
  const execute = vi.fn(executeNativeAnchoredReadOperation);
  const owner = {
    deniedRoots: denyObjects ? [objects] : [],
    captureReadAnchor: fixtureReadAnchor,
    assertReadable: async () => {},
    deadline: Date.now() + 15000,
    signal: AbortSignal.timeout(15000),
    executeReadOperation: execute,
  };
  const access = new LocalRepositoryReadAccess(owner);
  await access.pinRoot(source);
  return { source, objects, alternate, access, execute, head };
}
it('qualifies copied references without probing or qualifying unconsumed object storage', async () => {
  const f = await fixture();
  const metadata = await inspectLocalRepositoryGitMetadata({
    path: f.source,
    readAccess: f.access,
    assertReadable: (path) => f.access.assertPath(path),
    timeoutMs: 15000,
    mode: 'references',
  });
  const facts = await readLocalRepositoryGitFacts(metadata, {
    readAccess: f.access,
    timeoutMs: 15000,
  });
  expect(metadata.qualification).toBe('references');
  expect(facts).toEqual({ branch: 'main', head: f.head });
  await f.access.verify();
  expect(
    f.execute.mock.calls.some(
      ([request]) =>
        request.file_path === f.objects || request.file_path.startsWith(f.objects + '/'),
    ),
  ).toBe(false);
  expect(await readFile(join(f.alternate, 'foreign-witness'), 'utf8')).toBe(
    'UNREAD ALTERNATE BYTES',
  );
  expect(await readFile(join(f.objects, 'info', 'alternates'), 'utf8')).toBe(f.alternate + '\n');
});
it('refuses reference-only metadata at both status consumers before any object or other source lookup', async () => {
  const f = await fixture();
  const metadata = {
    path: f.source,
    gitDirectory: join(f.source, '.git'),
    commonDirectory: join(f.source, '.git'),
    objectFormat: 'sha1' as const,
    comparisonConfig: {},
    qualification: 'references' as const,
  };
  const authorize = vi.spyOn(f.access, 'assertPath');
  for (const status of [readLocalRepositorySnapshotStatus, readLocalRepositoryStatus])
    await expect(
      status(metadata, { readAccess: f.access, timeoutMs: 15000 }),
    ).rejects.toMatchObject({ kind: 'unsafe', reason: 'reference-only-metadata' });
  expect(authorize).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
});
it('retains the strict default storage refusal when no reference-only mode is selected', async () => {
  const f = await fixture();
  await expect(
    inspectLocalRepositoryGitMetadata({
      path: f.source,
      readAccess: f.access,
      assertReadable: (path) => f.access.assertPath(path),
      timeoutMs: 15000,
    }),
  ).rejects.toMatchObject({ kind: 'access' });
});
it('retains the default nonempty alternates refusal without probing its target', async () => {
  const f = await fixture(false);
  await expect(
    inspectLocalRepositoryGitMetadata({
      path: f.source,
      readAccess: f.access,
      assertReadable: (path) => f.access.assertPath(path),
      timeoutMs: 15000,
    }),
  ).rejects.toMatchObject({ kind: 'unsafe', reason: 'alternate-storage-unavailable' });
  expect(
    f.execute.mock.calls.some(
      ([request]) =>
        request.file_path === f.alternate || request.file_path.startsWith(f.alternate + '/'),
    ),
  ).toBe(false);
  expect(await readFile(join(f.alternate, 'foreign-witness'), 'utf8')).toBe(
    'UNREAD ALTERNATE BYTES',
  );
});
