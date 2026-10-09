import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareBackupTools } from '../backup/setup-tools.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'backup-tools-'));
  roots.push(root);
  return root;
}
it('rejects a bad download checksum before any executable is extracted or installed', async () => {
  const root = await fixture();
  const execute = vi.fn(async () => {});
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
