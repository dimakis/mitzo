import { afterEach, expect, it, vi } from 'vitest';
import { ownedRuntimeFixture } from './fixtures/owned-local-codex-runtime.js';
import { revokeAuthSession } from '../auth.js';

// This isolated consumer regression uses only synthetic account/login files.
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, homedir: () => `${actual.tmpdir()}/mitzo-owned-auth-offline-home` };
});
vi.mock('../auth.js', async (original) => ({
  ...(await original<typeof import('../auth.js')>()),
  hasPersistentRevocationAuthority: () => true,
}));

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('retains authentication loss on the actual dispatched admission after runtime cleanup', async () => {
  const f = await ownedRuntimeFixture(cleanups);
  const runtime = f.create();
  await runtime.admit(f.request);
  const admission = f.dispatch.mock.calls[0][0].admission;
  revokeAuthSession(f.auth);
  expect(() => admission.assertCurrentSync()).toThrow('Owned local Codex chat unavailable');
  expect(admission.authenticationFailure()?.code).toBe('auth_revoked');
  admission.close();
  expect(admission.authenticationFailure()?.code).toBe('auth_revoked');
});
