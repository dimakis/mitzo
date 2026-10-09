import { afterEach, expect, it, vi } from 'vitest';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    cp: async (...args: Parameters<typeof actual.cp>) => {
      const [, destination, options] = args;
      if ((options?.mode ?? 0) & constants.COPYFILE_EXCL) {
        const existing = await actual.lstat(destination).catch(() => undefined);
        if (existing)
          throw Object.assign(new Error('Exclusive copy target already exists'), {
            code: 'EEXIST',
          });
      }
      await actual.cp(...args);
    },
  };
});
import { copyRepositoryTaskCheckout } from '../repository-task-copy.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('allows strict directory EXCL copying to create only the newly reserved task root', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-strict-copy-')));
  roots.push(root);
  const source = join(root, 'source'),
    destination = join(root, 'task');
  await mkdir(source);
  await writeFile(join(source, 'file.txt'), 'source');
  await copyRepositoryTaskCheckout(source, destination);
  expect(await readFile(join(destination, 'file.txt'), 'utf8')).toBe('source');
  await writeFile(join(destination, 'file.txt'), 'retained task edit');
  await expect(copyRepositoryTaskCheckout(source, destination)).rejects.toThrow();
  expect(await readFile(join(destination, 'file.txt'), 'utf8')).toBe('retained task edit');
});
