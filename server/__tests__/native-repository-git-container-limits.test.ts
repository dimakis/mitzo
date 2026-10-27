import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, lstat, writeFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeFileHelperProgram } from '../native-file-operation.js';
import { expect, it } from 'vitest';
import {
  projectNativeTreeEntries,
  projectNativeRepositoryTreeEntries,
  projectNativeRepositoryGitTreeEntries,
} from '../native-tree-publication.js';
import {
  acquisitionGitEntrySizeLimit,
  repositoryGitEntrySizeLimit,
} from '../repository-git-container-policy.js';

const MiB = 1024 * 1024;
const pack = `objects/pack/pack-${'a'.repeat(40)}.pack`;
const entry = (path: string, size: number, mode = '100644') => ({
  path,
  size,
  mode,
  identity: { dev: '1', ino: '2' },
  sha256: '0'.repeat(64),
});
const manifest = (...leaves: ReturnType<typeof entry>[]) => [
  entry('objects', 0, '040000'),
  entry('objects/pack', 0, '040000'),
  ...leaves,
];

it.each(['pack', 'idx'])(
  'admits only canonical Git %s containers above the tracked-file bound',
  (suffix) => {
    const entries = manifest(entry(pack.replace(/pack$/, suffix), 17 * MiB));
    expect(projectNativeRepositoryGitTreeEntries(entries)).toHaveLength(3);
    expect(() => projectNativeTreeEntries(entries)).toThrow();
    expect(() => projectNativeRepositoryTreeEntries(entries)).toThrow();
  },
);

it.each([
  ['config', '100644'],
  ['payload.bin', '100644'],
  ['objects/pack/pack-short.pack', '100644'],
  ['objects/pack/tmp_pack_owned', '100644'],
  [pack, '100755'],
])(
  'retains the 16MiB bound for metadata, tracked files and noncanonical containers: %s %s',
  (path, mode) => {
    expect(() =>
      projectNativeRepositoryGitTreeEntries(manifest(entry(path, 17 * MiB, mode))),
    ).toThrow();
  },
);

it('retains canonical container per-file and aggregate 128MiB bounds', () => {
  expect(() => projectNativeRepositoryGitTreeEntries(manifest(entry(pack, 129 * MiB)))).toThrow();
  expect(() =>
    projectNativeRepositoryGitTreeEntries(
      manifest(entry(pack, 65 * MiB), entry(pack.replace('.pack', '.idx'), 65 * MiB)),
    ),
  ).toThrow();
});

it('grants temporary container capacity only during owned acquisition fetch', () => {
  const temporary = 'objects/pack/tmp_pack_owned';
  expect(acquisitionGitEntrySizeLimit(temporary, true)).toBe(128 * MiB);
  expect(acquisitionGitEntrySizeLimit(temporary, false)).toBe(16 * MiB);
  expect(repositoryGitEntrySizeLimit(temporary)).toBe(16 * MiB);
  expect(acquisitionGitEntrySizeLimit('objects/pack/tmp_pack', true)).toBe(16 * MiB);
  expect(acquisitionGitEntrySizeLimit('outside/tmp_pack_owned', true)).toBe(16 * MiB);
});

it('ignores a caller-supplied Git-container role in generic fixed-helper requests before effects', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'generic-container-refusal-')));
  try {
    const source = join(root, 'source'),
      target = join(root, 'target');
    await mkdir(join(source, 'objects', 'pack'), { recursive: true });
    await mkdir(target);
    const bytes = Buffer.alloc(17 * MiB);
    await writeFile(join(source, pack), bytes);
    const identity = async (path: string) => {
      const info = await lstat(path, { bigint: true });
      return { dev: String(info.dev), ino: String(info.ino) };
    };
    const rootIdentity = await identity(root);
    const entries = await Promise.all(
      manifest(entry(pack, bytes.length)).map(async (item) => ({
        ...item,
        identity: await identity(join(source, item.path)),
        sha256: createHash('sha256')
          .update(item.mode === '040000' ? '' : bytes)
          .digest('hex'),
      })),
    );
    const request = {
      operation: 'PublishTree',
      timeoutMs: 15000,
      repository_git_containers: true,
      file_path: target,
      rootAnchor: { rootPath: root, identity: rootIdentity },
      parentIdentity: rootIdentity,
      targetIdentity: await identity(target),
      payload: {
        file_path: source,
        rootAnchor: { rootPath: root, identity: rootIdentity },
        parentIdentity: rootIdentity,
        identity: await identity(source),
      },
      originalSourcePath: join(root, 'original'),
      deniedRoots: [],
      entries,
    };
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        '/usr/bin/python3',
        ['-I', '-c', nativeFileHelperProgram],
        { maxBuffer: 32768 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin!.end(JSON.stringify(request));
    });
    expect(JSON.parse(output).is_error).toBe(true);
    expect(await readdir(target)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
