import { afterEach, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, symlink, link, writeFile, rename, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolBuilderWorkspace } from '../tool-builder-workspace.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() {
  const value = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-builder-workspace-')));
  roots.push(value);
  return value;
}

it('creates a private isolated workspace, supports root files and snapshots the complete source set', async () => {
  const base = await root();
  const ws = await createToolBuilderWorkspace(base, new AbortController().signal);
  expect(ws.root.startsWith(base + '/')).toBe(true);
  await ws.write('README.md', 'review me');
  await ws.write('src/index.mjs', 'export const runTool = () => ({});');
  expect(await ws.read('README.md')).toBe('review me');
  expect(await ws.snapshot()).toEqual([
    { path: 'README.md', content: 'review me' },
    { path: 'src/index.mjs', content: 'export const runTool = () => ({});' },
  ]);
  await expect(ws.write('../escape', 'bad')).rejects.toThrow();
  await expect(ws.write('README.md', 'overwrite')).rejects.toThrow();
  await ws.discard();
  await expect(ws.snapshot()).rejects.toThrow();
});
it('snapshots and reads valid Unicode near the complete workspace byte limit', async () => {
  const base = await root();
  const ws = await createToolBuilderWorkspace(base, new AbortController().signal);
  const content = '//' + 'é'.repeat(119999) + '\n';
  expect(Buffer.byteLength(content) * 8).toBeLessThan(2_000_000);
  for (let index = 0; index < 8; index++) await ws.write(`source-${index}.mts`, content);
  expect(await ws.snapshot()).toHaveLength(8);
  expect(await ws.read('source-7.mts')).toBe(content);
  await ws.discard();
}, 20000);

it('rejects symlink and hardlink sources without following them during cleanup', async () => {
  const base = await root();
  const outside = join(base, 'outside');
  await writeFile(outside, 'keep');
  const ws = await createToolBuilderWorkspace(base, new AbortController().signal);
  await symlink(base, join(ws.root, 'alias'));
  await expect(ws.write('alias/escape', 'bad')).rejects.toThrow();
  await expect(ws.snapshot()).rejects.toThrow();
  await rm(join(ws.root, 'alias'));
  await link(outside, join(ws.root, 'hardlink'));
  await expect(ws.snapshot()).rejects.toThrow();
  await ws.discard();
  const { readFile } = await import('node:fs/promises');
  expect(await readFile(outside, 'utf8')).toBe('keep');
});

it('refuses a replaced workspace root and preserves replacement contents', async () => {
  const base = await root();
  const ws = await createToolBuilderWorkspace(base, new AbortController().signal);
  await rename(ws.root, ws.root + '-retained');
  await mkdir(ws.root);
  await writeFile(join(ws.root, 'retained'), 'keep');
  await expect(ws.write('escape', 'bad')).rejects.toThrow();
  await expect(ws.discard()).rejects.toThrow();
  const { readFile } = await import('node:fs/promises');
  expect(await readFile(join(ws.root, 'retained'), 'utf8')).toBe('keep');
});
