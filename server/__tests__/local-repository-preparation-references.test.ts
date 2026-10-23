import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRepositoryReadAccess } from '../local-repository-read-access.js';
import { executeNativeAnchoredReadOperation } from '../native-file-operation.js';
import { fixtureReadAnchor } from './fixtures/local-repository-read-owner.js';
import {
  inspectLocalRepositoryGitMetadata,
  readLocalRepositoryStatus,
} from '../local-repository-git-inspection.js';
import {
  hasLocalRepositoryReferenceConflict,
  readLocalRepositoryGitFacts,
  readLocalRepositoryPreparationReferences,
  readLocalRepositorySnapshotStatus,
  readLocalRepositoryWorktrees,
} from '../local-repository-git-snapshot.js';

vi.setConfig({ testTimeout: 30000 });
let root: string, source: string;
const git = (...args: string[]) =>
  execFileSync(
    'git',
    ['-C', source, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    },
  ).trim();
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-preparation-refs-')));
  source = join(root, 'source');
  await mkdir(source);
  git('init', '-q', '-b', 'base');
  git('config', 'user.name', 'Offline fixture');
  git('config', 'user.email', 'offline@example.invalid');
  await writeFile(join(source, 'source.txt'), 'SOURCE BYTES');
  git('add', '.');
  git('commit', '-qm', 'fixture');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function fixture(deniedRoots: readonly string[] = []) {
  const bytes: string[] = [];
  const assertReadable = vi.fn(async () => {});
  const access = new LocalRepositoryReadAccess({
    deniedRoots,
    assertReadable,
    captureReadAnchor: fixtureReadAnchor,
    deadline: Date.now() + 30000,
    executeReadOperation: async (...args) => {
      if (args[0].operation === 'ReadBytes') bytes.push(args[0].file_path);
      return executeNativeAnchoredReadOperation(...args);
    },
  });
  await access.pinRoot(source);
  const metadata = await inspectLocalRepositoryGitMetadata({
    path: source,
    mode: 'references',
    readAccess: access,
    assertReadable: (path) => access.assertPath(path),
    timeoutMs: 30000,
  });
  const options = { readAccess: access, timeoutMs: 30000 };
  return { access, metadata, options, bytes, assertReadable };
}
it('resolves actual nondefault symbolic HEAD through a packed target without reading 25 unrelated loose OIDs', async () => {
  git('branch', 'origin/β');
  git('pack-refs', '--all', '--prune');
  git('symbolic-ref', 'refs/heads/alias', 'refs/heads/origin/β');
  git('symbolic-ref', 'HEAD', 'refs/heads/alias');
  for (let index = 0; index < 25; index++) git('branch', `topic/branch-${index}`);
  const before = await readFile(join(source, '.git', 'index'));
  expect(git('branch', '--show-current')).toBe('origin/β');
  const f = await fixture();
  const actual = await readLocalRepositoryPreparationReferences(
    f.metadata,
    f.options,
    'refs/heads/mitzo/task',
  );
  await f.access.verify();
  expect(actual).toEqual({
    branch: git('branch', '--show-current'),
    head: git('rev-parse', 'HEAD'),
    conflict: false,
    referenceCoverage: 'preparation-head-and-namespace-v1',
  });
  expect(f.bytes.some((path) => path.includes('/refs/heads/topic/'))).toBe(false);
  expect(f.bytes).toContain(join(source, '.git', 'refs', 'heads', 'alias'));
  expect(f.bytes).toContain(join(source, '.git', 'packed-refs'));
  expect(await readFile(join(source, '.git', 'index'))).toEqual(before);
  expect(await readFile(join(source, 'source.txt'), 'utf8')).toBe('SOURCE BYTES');
});

it.for(['case-ancestor', 'unicode-ancestor', 'case-target', 'unicode-target'] as const)(
  'refuses lexical absence for an actually equivalent namespace %s',
  { timeout: 30000 },
  async (kind, context) => {
    const heads = join(source, '.git', 'refs', 'heads');
    const unicode = kind.startsWith('unicode'),
      ancestor = kind.endsWith('ancestor');
    const physicalName = unicode ? 'Café' : ancestor ? 'MITZO' : 'TASK';
    const parent = ancestor ? heads : join(heads, 'mitzo');
    await mkdir(parent, { recursive: true });
    const physical = join(parent, physicalName);
    if (ancestor) await mkdir(physical);
    else await writeFile(physical, git('rev-parse', 'HEAD') + '\n');
    const listed = (await readdir(parent)).find((name) =>
      unicode ? name.normalize('NFC') === 'Café' : name.toUpperCase() === physicalName,
    )!;
    const aliasName = unicode
      ? listed === listed.normalize('NFC')
        ? listed.normalize('NFD')
        : listed.normalize('NFC')
      : listed.toLowerCase();
    const alias = join(parent, aliasName);
    const a = await lstat(physical, { bigint: true });
    const b = await lstat(alias, { bigint: true }).catch(() => undefined);
    if (!b || a.dev !== b.dev || a.ino !== b.ino) {
      context.skip();
      return;
    }
    expect(aliasName).not.toBe(listed);
    const reference = ancestor ? `refs/heads/${aliasName}/task` : `refs/heads/mitzo/${aliasName}`;
    const f = await fixture();
    await expect(
      readLocalRepositoryPreparationReferences(f.metadata, f.options, reference),
    ).rejects.toThrow();
  },
);
it('keeps the default ALL reference consumer reading actual unrelated loose contents', async () => {
  git('branch', 'topic/unrelated');
  const f = await fixture();
  expect(await readLocalRepositoryGitFacts(f.metadata, f.options)).toEqual({
    branch: 'base',
    head: git('rev-parse', 'HEAD'),
  });
  expect(f.bytes).toContain(join(source, '.git', 'refs', 'heads', 'topic', 'unrelated'));
});
it.each(
  ['mitzo/task', 'mitzo', 'mitzo/task/child'].flatMap((name) =>
    ['0'.repeat(40), '1'.repeat(40)].map((oid) => ({ name, oid })),
  ),
)('retains packed namespace collision $name even when its OID is $oid', async ({ name, oid }) => {
  const packed = `# pack-refs with: peeled fully-peeled sorted\n${oid} refs/heads/${name}\n`;
  await writeFile(join(source, '.git', 'packed-refs'), packed);
  const f = await fixture();
  const actual = await readLocalRepositoryPreparationReferences(
    f.metadata,
    f.options,
    'refs/heads/mitzo/task',
  );
  await f.access.verify();
  expect(actual.conflict).toBe(true);
  expect(actual.head).toBe(git('rev-parse', 'HEAD'));
  expect(await readFile(join(source, '.git', 'packed-refs'), 'utf8')).toBe(packed);
});
it.each([
  'exact',
  'ancestor-file',
  'target-directory',
  'descendant',
  'ordinary-directory',
] as const)(
  'conservatively checks %s namespace custody without consuming unrelated loose content',
  async (kind) => {
    if (kind === 'exact') git('branch', 'mitzo/task');
    if (kind === 'ancestor-file') git('branch', 'mitzo');
    if (kind === 'target-directory')
      await mkdir(join(source, '.git', 'refs', 'heads', 'mitzo', 'task'), { recursive: true });
    if (kind === 'descendant') git('branch', 'mitzo/task/child');
    if (kind === 'ordinary-directory') git('branch', 'mitzo/sibling');
    const f = await fixture();
    const actual = await readLocalRepositoryPreparationReferences(
      f.metadata,
      f.options,
      'refs/heads/mitzo/task',
    );
    await f.access.verify();
    expect(actual.conflict).toBe(kind !== 'ordinary-directory');
    expect(f.bytes.some((path) => path.includes('/refs/heads/mitzo'))).toBe(false);
  },
);
it('does not qualify a denied required namespace or read its file content', async () => {
  git('branch', 'mitzo/task');
  const denied = join(source, '.git', 'refs', 'heads', 'mitzo');
  const f = await fixture([denied]);
  await expect(
    readLocalRepositoryPreparationReferences(f.metadata, f.options, 'refs/heads/mitzo/task'),
  ).rejects.toThrow();
  expect(f.bytes.some((path) => path.startsWith(denied))).toBe(false);
});
it('rejects a symbolic cycle rather than inferring a final OID', async () => {
  git('symbolic-ref', 'refs/heads/loop', 'refs/heads/loop');
  git('symbolic-ref', 'HEAD', 'refs/heads/loop');
  const f = await fixture();
  await expect(
    readLocalRepositoryPreparationReferences(f.metadata, f.options),
  ).rejects.toMatchObject({ reason: 'snapshot-reference-unsupported' });
  expect(f.bytes.filter((path) => path.endsWith('/refs/heads/loop'))).toHaveLength(1);
});
it('refuses namespace changes during final witness verification', async () => {
  const f = await fixture();
  expect(
    (await readLocalRepositoryPreparationReferences(f.metadata, f.options, 'refs/heads/mitzo/task'))
      .conflict,
  ).toBe(false);
  git('branch', 'mitzo/task');
  await expect(f.access.verify()).rejects.toThrow();
});
it('rejects the explicit partial view before every arbitrary-ref/object/status consumer source lookup', async () => {
  const f = await fixture();
  const partial = {
    ...f.metadata,
    referenceCoverage: 'preparation-head-and-namespace-v1' as const,
  };
  f.assertReadable.mockClear();
  for (const action of [
    () => readLocalRepositoryGitFacts(partial, f.options),
    () => hasLocalRepositoryReferenceConflict(partial, f.options, 'refs/heads/mitzo/task'),
    () => readLocalRepositoryWorktrees(partial, f.options),
    () => readLocalRepositorySnapshotStatus(partial, f.options),
    () => readLocalRepositoryStatus(partial, f.options),
  ])
    await expect(action()).rejects.toThrow();
  expect(f.assertReadable).not.toHaveBeenCalled();
});
