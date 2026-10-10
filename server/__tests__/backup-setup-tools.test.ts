import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as files from '../backup/files.js';
import { prepareBackupTools, readBackupToolPaths } from '../backup/setup-tools.js';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'backup-tools-'));
  roots.push(root);
  return root;
}
it('rejects a bad download checksum before any executable is extracted or installed', async () => {
  const root = await fixture();
  await writeFile(join(root, 'probe.swift'), 'fixture-source');
  const execute = vi.fn(async () => Buffer.alloc(0));
  await expect(
    prepareBackupTools({
      directory: root,
      source: join(root, 'probe.swift'),
      download: async () => Buffer.from('tampered'),
      execute,
    }),
  ).rejects.toThrow('Backup tools could not be prepared');
  expect(execute).not.toHaveBeenCalled();
});
it('prepares pinned tools once without overwriting existing executables', async () => {
  const root = await fixture();
  const source = join(root, 'probe.swift');
  await writeFile(source, 'fixture-source');
  const archive = Buffer.from('synthetic-archive');
  const execute = vi.fn(async (binary: string, args: string[]) => {
    if (binary === '/usr/bin/bzip2') return Buffer.from('fixture-restic');
    await writeFile(args[args.indexOf('-o') + 1], 'fixture-probe');
    return Buffer.alloc(0);
  });
  const download = vi.fn(async () => archive);
  const config = {
    directory: join(root, 'tools'),
    source,
    download,
    execute,
    archiveHash: createHash('sha256').update(archive).digest('hex'),
  };
  const paths = await prepareBackupTools(config);
  await access(paths.restic);
  await access(paths.probe);
  await prepareBackupTools(config);
  expect(download).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledTimes(2);
});

async function toolFixture() {
  const root = await fixture();
  const source = join(root, 'probe.swift');
  await writeFile(source, 'fixture-source-v1');
  const archive = Buffer.from('synthetic-archive');
  const execute = vi.fn(async (binary: string, args: string[]) => {
    if (binary === '/usr/bin/bzip2') return Buffer.from('fixture-restic');
    const sourcePath = args.find((arg) => arg.endsWith('.swift'))!;
    await writeFile(
      args[args.indexOf('-o') + 1],
      'compiled-' + (await readFile(sourcePath, 'utf8')),
    );
    return Buffer.alloc(0);
  });
  const download = vi.fn(async () => archive);
  const config = {
    directory: join(root, 'tools'),
    source,
    execute,
    download,
    archiveHash: createHash('sha256').update(archive).digest('hex'),
  };
  return { config, execute, download, source };
}
it.each(['before', 'after'])(
  'recovers when manifest commit fails %s its atomic replacement',
  async (phase) => {
    const { config } = await toolFixture();
    const save = files.durableJson;
    let fail = true;
    vi.spyOn(files, 'durableJson').mockImplementation(async (path, value) => {
      if (path === join(config.directory, 'tools.json') && fail) {
        fail = false;
        if (phase === 'after') await save(path, value);
        throw Error('synthetic publication failure');
      }
      await save(path, value);
    });
    await expect(prepareBackupTools(config)).rejects.toThrow('Backup tools could not be prepared');
    const paths = await prepareBackupTools(config);
    expect(await readFile(paths.restic, 'utf8')).toBe('fixture-restic');
    expect(await readFile(paths.probe, 'utf8')).toBe('compiled-fixture-source-v1');
    expect(await readBackupToolPaths(config.directory)).toEqual(paths);
  },
);
it('rebuilds a changed bundled source and keeps the qualified previous generation on failed publication', async () => {
  const { config, source, execute, download } = await toolFixture();
  const previous = await prepareBackupTools(config);
  await writeFile(source, 'fixture-source-v2');
  const save = files.durableJson;
  let fail = true;
  vi.spyOn(files, 'durableJson').mockImplementation(async (path, value) => {
    if (path === join(config.directory, 'tools.json') && fail) {
      fail = false;
      throw Error('synthetic publication failure');
    }
    await save(path, value);
  });
  await expect(prepareBackupTools(config)).rejects.toThrow();
  expect(await readBackupToolPaths(config.directory)).toEqual(previous);
  expect(await readFile(previous.probe, 'utf8')).toBe('compiled-fixture-source-v1');
  const updated = await prepareBackupTools(config);
  expect(updated.probe).not.toBe(previous.probe);
  expect(await readFile(updated.probe, 'utf8')).toBe('compiled-fixture-source-v2');
  expect(await readFile(previous.probe, 'utf8')).toBe('compiled-fixture-source-v1');
  const count = execute.mock.calls.length;
  await prepareBackupTools(config);
  expect(execute).toHaveBeenCalledTimes(count);
  expect(download).toHaveBeenCalledTimes(1);
});
it('refuses unqualified legacy executables without removing or overwriting them', async () => {
  const { config } = await toolFixture();
  await files.safeDirectory(config.directory, true);
  const path = join(config.directory, 'restic-0.19.1');
  await writeFile(path, 'unregistered-tool', { mode: 0o700 });
  await expect(prepareBackupTools(config)).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe('unregistered-tool');
});
