vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
import { afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
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
it('returns the exact existing real review owner already mounted by app, without constructing another owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'symposium-bootstrap-owner-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_OWNER', '1');
  const app = await import('../app.js');
  const first = app.getSymposiumBootstrapDependencies();
  const second = app.getSymposiumBootstrapDependencies();
  expect(captured.stores).toHaveLength(1);
  expect(first.reviews).toBeInstanceOf(SymposiumReviewStore);
  expect(first.reviews).toBe(captured.stores[0]);
  expect(second.reviews).toBe(first.reviews);
  expect(captured.effects).not.toHaveBeenCalled();
});
