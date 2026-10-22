import { afterEach, expect, it, vi } from 'vitest';
import { ownedRuntimeFixture } from './fixtures/owned-local-codex-runtime.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
vi.mock('../auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth.js')>()),
  hasPersistentRevocationAuthority: () => true,
}));
vi.mock('../openai-account-key-authority.js', () => ({
  openAIAccountKeyAuthority: () => ({
    assertReady: async () => {},
    resolveKey: async () => 'synthetic-api-key',
  }),
}));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it('starts a real owned API Codex command in a worktree of an existing Mac repository', async () => {
  const f = await ownedRuntimeFixture(cleanups, { api: true, localRepository: true });
  const owner = f.create();
  await expect(owner.admit(f.request)).resolves.toEqual({ dispatched: true });
  const delivered = f.dispatch.mock.calls[0][0];
  expect(delivered.lease.binding.provider).toBe('openai');
  expect(delivered.profile.planType).toBe('api');
  expect(delivered.expected.binding.harness.implementation).toBe('codex');
  expect(delivered.workspace.localSource).toBeDefined();
  expect(readFileSync(join(delivered.workspace.directory!, '.git'), 'utf8')).toContain('gitdir:');
  expect(f.events.getOrdinaryLocalCommandAdmission(f.request.clientMsgId)?.state).toBe('consumed');
  expect(f.launch).not.toHaveBeenCalled();
  await expect(owner.admit(f.request)).resolves.toEqual({ dispatched: false });
  expect(f.dispatch).toHaveBeenCalledTimes(1);
});
