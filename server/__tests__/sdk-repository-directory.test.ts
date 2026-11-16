import { afterEach, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, mkdir, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSdkRepositoryDirectory } from '../sdk-repository-directory.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('creates an absent Claude task namespace using descriptor-relative directory operations', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sdk-directory-')));
  roots.push(root);
  const target = join(root, '.claude', 'repository-tasks');
  await createSdkRepositoryDirectory(root, target, new AbortController().signal);
  expect(await realpath(target)).toBe(target);
});
it('rejects linked ancestors and destinations outside the approved root without effects', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sdk-directory-')));
  roots.push(root);
  const workspace = join(root, 'workspace'),
    outside = join(root, 'outside');
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  await symlink(outside, join(workspace, '.claude'));
  const signal = new AbortController().signal;
  await expect(
    createSdkRepositoryDirectory(workspace, join(workspace, '.claude', 'tasks'), signal),
  ).rejects.toThrow();
  await expect(
    createSdkRepositoryDirectory(workspace, join(outside, 'tasks'), signal),
  ).rejects.toThrow();
  expect(await readdir(outside)).toEqual([]);
});
