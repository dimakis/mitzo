import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { renameSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const boundary = vi.hoisted(() => ({
  mutate: undefined as (() => void) | undefined,
  afterCopy: undefined as (() => void) | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    cp: async (...args: Parameters<typeof actual.cp>) => {
      boundary.mutate?.();
      await actual.cp(...args);
      boundary.afterCopy?.();
    },
  };
});
import { copyRepositoryTaskCheckout } from '../repository-task-copy.js';
const roots: string[] = [];
afterEach(async () => {
  boundary.mutate = undefined;
  boundary.afterCopy = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it.each(['destination', 'source'])(
  'refuses %s alias replacement before filesystem copying without crossing the copy boundary',
  async (replacement) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-copy-boundary-')));
    roots.push(root);
    const source = join(root, 'source'),
      destination = join(root, 'task'),
      outside = join(root, 'unrelated');
    await mkdir(source);
    await mkdir(outside);
    await writeFile(join(source, 'new.txt'), 'prepared source');
    await writeFile(join(outside, 'owned.txt'), 'unrelated work');
    boundary.mutate = () => {
      const selected = replacement === 'source' ? source : destination;
      renameSync(selected, selected + '-original');
      symlinkSync(outside, selected, 'dir');
    };
    await expect(copyRepositoryTaskCheckout(source, destination)).rejects.toThrow();
    expect(await readFile(join(outside, 'owned.txt'), 'utf8')).toBe('unrelated work');
    await expect(access(join(outside, 'new.txt'))).rejects.toThrow();
    if (replacement === 'source')
      await expect(access(join(destination, 'owned.txt'))).rejects.toThrow();
  },
);

it.each(['source', 'destination'])(
  'rejects replacement of the reserved %s identity during copying',
  async (replacement) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-copy-identity-')));
    roots.push(root);
    const source = join(root, 'source'),
      destination = join(root, 'task');
    await mkdir(source);
    await writeFile(join(source, 'file.txt'), 'source');
    boundary.afterCopy = () => {
      const selected = replacement === 'source' ? source : destination;
      renameSync(selected, selected + '-original');
      mkdirSync(selected);
      writeFileSync(join(selected, 'unrelated.txt'), 'preserved data');
    };
    await expect(copyRepositoryTaskCheckout(source, destination)).rejects.toThrow(
      'Repository task copy identity changed',
    );
    const selected = replacement === 'source' ? source : destination;
    expect(await readFile(join(selected, 'unrelated.txt'), 'utf8')).toBe('preserved data');
  },
);
