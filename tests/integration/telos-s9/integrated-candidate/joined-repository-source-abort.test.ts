import { afterAll, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { createJoinedRepositoryEffects } from './joined-repository-source';

const root = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 's9-repository-abort-')));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', path.join(root, 'private'));
  vi.stubEnv('MITZO_INTERNAL_TOKEN_PATH', path.join(root, 'internal-token'));
  vi.stubEnv('TELOS_DB_PATH', path.join(root, 'canonical.db'));
  return root;
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
vi.mock('../../../../server/mcp-config.js', () => ({
  loadMcpServers: () => ({}),
  getMcpConfigPaths: () => [],
  loadFromFile: () => ({}),
}));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
it('rejects pre-aborted repository fixture work before command execution or remote-effect recording', async () => {
  const h = await createJoinedRepositoryEffects(root, 'synthetic-repository-abort-account');
  try {
    vi.mocked(execFileSync).mockClear();
    const controller = new AbortController();
    const reason = Error('Synthetic pre-aborted repository operation');
    controller.abort(reason);
    await expect(h.run('git', ['status'], controller.signal)).rejects.toBe(reason);
    await expect(
      h.run(
        'gh',
        ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/example/acceptance'],
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(h.externalCalls).toEqual([]);
  } finally {
    await h.close();
  }
});
