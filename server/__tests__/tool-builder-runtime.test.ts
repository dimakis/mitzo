import { mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createToolBuilderWorkspace } from '../tool-builder-runtime.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('limits draft writes and reads to an isolated child of the authorized worktree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mitzo-tool-builder-runtime-'));
  roots.push(root);
  const workspace = await createToolBuilderWorkspace(root);
  expect(workspace.root.startsWith(`${await realpath(root)}/`)).toBe(true);
  await workspace.write('src/index.mjs', 'export const value = 1;');
  expect(await workspace.read('src/index.mjs')).toBe('export const value = 1;');
  await expect(workspace.read('../outside')).rejects.toThrow('outside the authorized workspace');
  await expect(workspace.write('/tmp/outside', 'x')).rejects.toThrow(
    'outside the authorized workspace',
  );
  await expect(workspace.write('src/index.mjs', 'replace')).rejects.toThrow();
});

it('rejects symbolic links in draft paths and removes failed workspace contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mitzo-tool-builder-runtime-'));
  roots.push(root);
  const outside = join(root, 'outside');
  const workspace = await createToolBuilderWorkspace(root);
  await symlink(outside, join(workspace.root, 'linked'));
  await expect(workspace.write('linked/file.mjs', 'x')).rejects.toThrow();
  await workspace.discard?.();
  await expect(readFile(workspace.root)).rejects.toThrow();
});
