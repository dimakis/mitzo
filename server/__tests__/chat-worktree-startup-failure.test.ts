import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../worktree.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../worktree.js')>()),
  createWorktreeAsync: vi.fn(async () => {
    throw Error('Upstream main is unavailable');
  }),
}));
let root: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
});
it('refuses startup when the shared worktree cannot fetch upstream instead of running in the base checkout', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-startup-failure-')));
  vi.stubEnv('REPO_PATH', root);
  const { createSessionWorktrees } = await import('../chat.js');
  const transport = { send: vi.fn(), isOpen: () => true };
  await expect(
    createSessionWorktrees(transport as never, root!, 'offline-session', { isolation: true }),
  ).rejects.toThrow('Upstream main is unavailable');
  expect(transport.send).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'error',
      error: expect.stringContaining('Upstream main is unavailable'),
    }),
  );
});
