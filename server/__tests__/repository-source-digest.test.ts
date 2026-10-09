import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const guard = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<object>()),
  readFile: guard.readFile,
}));
import { repositorySourceDigest } from '../repository-workspaces.js';
const roots: string[] = [];
afterEach(async () => {
  guard.readFile.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('verifies a large source without whole-file reads and preserves the frozen digest format', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-stream-digest-')));
  roots.push(root);
  const file = join(root, 'blob.bin');
  await writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 17, 37));
  await chmod(file, 0o600);
  guard.readFile.mockRejectedValue(new Error('Whole-file verification exceeds the memory budget'));
  expect(await repositorySourceDigest(root)).toBe(
    'e457fe9c6792b07c18da5a7e4bc188ecb3af65249f4633900c9cdfcef64bd268',
  );
});
