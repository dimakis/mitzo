import { afterEach, expect, it } from 'vitest';
import { mkdtemp, realpath, mkdir, writeFile, readFile, stat, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyRepositoryTaskCheckout } from '../repository-task-copy.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-task-copy-')));
  roots.push(root);
  const source = join(root, 'source'),
    destination = join(root, 'task');
  await mkdir(join(source, '.git'), { recursive: true });
  await writeFile(join(source, '.git', 'HEAD'), 'ref: refs/heads/mitzo/task\n');
  await writeFile(join(source, 'file.txt'), Buffer.alloc(2 * 1024 * 1024, 37));
  await writeFile(join(source, 'run.sh'), '#!/bin/sh\n');
  await chmod(join(source, 'run.sh'), 0o755);
  return { root, source, destination };
}
it.each([...new Set([process.platform, 'linux' as const])])(
  'keeps cloned work and Git metadata independent through edits and seed deletion (%s)',
  async (platform) => {
    const f = await fixture();
    await copyRepositoryTaskCheckout(f.source, f.destination, platform);
    for (const file of ['file.txt', '.git/HEAD', 'run.sh']) {
      const source = await stat(join(f.source, file)),
        task = await stat(join(f.destination, file));
      expect(task.ino).not.toBe(source.ino);
      expect(task.nlink).toBe(1);
      expect(task.mode & 0o777).toBe(source.mode & 0o777);
    }
    await writeFile(join(f.destination, 'file.txt'), 'task edit');
    await writeFile(join(f.destination, '.git', 'HEAD'), 'ref: refs/heads/task-edited\n');
    expect((await readFile(join(f.source, 'file.txt'))).length).toBe(2 * 1024 * 1024);
    expect(await readFile(join(f.source, '.git', 'HEAD'), 'utf8')).toContain('mitzo/task');
    await rm(f.source, { recursive: true });
    expect(await readFile(join(f.destination, 'file.txt'), 'utf8')).toBe('task edit');
    expect(await readFile(join(f.destination, '.git', 'HEAD'), 'utf8')).toContain('task-edited');
  },
);
it('refuses an existing destination and preserves its files', async () => {
  const f = await fixture();
  await mkdir(f.destination);
  await writeFile(join(f.destination, 'owned.txt'), 'retained work');
  await expect(copyRepositoryTaskCheckout(f.source, f.destination)).rejects.toThrow();
  expect(await readFile(join(f.destination, 'owned.txt'), 'utf8')).toBe('retained work');
  await expect(stat(join(f.destination, 'file.txt'))).rejects.toThrow();
});
it('rejects a destination outside a private canonical container before creating it', async () => {
  const f = await fixture();
  await chmod(f.root, 0o755);
  await expect(copyRepositoryTaskCheckout(f.source, f.destination)).rejects.toThrow(
    'private canonical',
  );
  await expect(stat(f.destination)).rejects.toThrow();
});
