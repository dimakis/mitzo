vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
import { afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';
const captured = vi.hoisted(() => ({
  stores: [] as unknown[],
  effects: vi.fn(() => {
    throw Error('Process effects forbidden');
  }),
}));
vi.mock('../symposium-review-routes.js', async (original) => {
  const real = await original<typeof import('../symposium-review-routes.js')>();
  return {
    ...real,
    createSymposiumReviewRouter: (deps: Parameters<typeof real.createSymposiumReviewRouter>[0]) => {
      captured.stores.push(deps.store);
      return real.createSymposiumReviewRouter(deps);
    },
  };
});
vi.mock('../internal-token.js', () => ({
  INTERNAL_TOKEN: 'synthetic-bootstrap-test-only',
  isValidInternalToken: () => false,
  isValidSignalCallbackToken: () => false,
  createSignalCallbackToken: () => 'synthetic',
}));
vi.mock('../git-version.js', () => ({
  getLocalCommit: () => 'synthetic-bootstrap-test',
  isUpdateAvailable: () => false,
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<object>()),
  execSync: captured.effects,
  execFileSync: captured.effects,
  spawn: captured.effects,
  spawnSync: captured.effects,
  fork: captured.effects,
}));
afterAll(() => {
  vi.unstubAllEnvs();
});
it('returns the exact real review owner already mounted by the native service, without constructing another owner', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'symposium-bootstrap-owner-')));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_OWNER', '1');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private-codex'));
  const { createSymposiumCustodianService } = await import('../symposium-custodian-service.js');
  const service = createSymposiumCustodianService({ workspaceRoot: root });
  const first = service.getSymposiumBootstrapDependencies();
  const second = service.getSymposiumBootstrapDependencies();
  expect(captured.stores).toHaveLength(1);
  expect(first.reviews).toBeInstanceOf(SymposiumReviewStore);
  expect(first.reviews).toBe(captured.stores[0]);
  expect(second.reviews).toBe(first.reviews);
  expect(typeof first.readNativeObservation).toBe('function');
  expect(() => first.readNativeObservation('unknown')).toThrow(
    'Original native observation owner unavailable',
  );
  expect(captured.effects).not.toHaveBeenCalled();
  service.closeUninstalledService();
  rmSync(root, { recursive: true, force: true });
});
