import { beforeEach, expect, it, vi } from 'vitest';
import { assertOwnedCodexQueueControl } from '../owned-codex-queue-control.js';
const auth = vi.hoisted(() => ({ revoked: false, persistent: true }));
vi.mock('../auth.js', () => ({
  hasPersistentRevocationAuthority: () => auth.persistent,
  registerAuthSession: (_session: unknown, callback: () => void) => {
    if (auth.revoked) callback();
    return () => {};
  },
}));
const binding = {
  version: 2 as const,
  account: { accountId: 'account', provider: 'openai-codex' as const, profileRevision: 'revision' },
  harness: { implementation: 'codex' as const },
  execution: { location: 'openshell' as const, targetId: 'target', targetRevision: 'revision' },
};
function fixture() {
  return {
    runtimeBinding: () => binding,
    accountBinding: () => ({ ...binding.account, accountLabel: 'Account', model: 'original' }),
    custody: vi.fn(() => ({ authSessionId: 'original', binding })),
  };
}
beforeEach(() => {
  auth.revoked = false;
  auth.persistent = true;
});
it('authorizes cold queue controls only with the original current signed login and custody', () => {
  const f = fixture();
  const original = { id: 'original', expiresAt: Date.now() + 10000 };
  expect(() => assertOwnedCodexQueueControl(f, 'session', original)).not.toThrow();
  for (const operator of [undefined, { ...original, id: 'other' }, { ...original, expiresAt: 0 }])
    expect(() => assertOwnedCodexQueueControl(f, 'session', operator)).toThrow();
  auth.revoked = true;
  expect(() => assertOwnedCodexQueueControl(f, 'session', original)).toThrow();
  auth.revoked = false;
  auth.persistent = false;
  expect(() => assertOwnedCodexQueueControl(f, 'session', original)).toThrow();
});
it('refuses missing or changed cold custody rather than inferring authority from a current browser', () => {
  const f = fixture(),
    original = { id: 'original', expiresAt: Date.now() + 10000 };
  f.custody.mockReturnValueOnce(undefined as never);
  expect(() => assertOwnedCodexQueueControl(f, 'session', original)).toThrow();
  f.custody.mockReturnValueOnce({
    authSessionId: 'original',
    binding: { ...binding, execution: { ...binding.execution, targetId: 'changed' } },
  });
  expect(() => assertOwnedCodexQueueControl(f, 'session', original)).toThrow();
});
it('retains legacy control behavior for conversations without an explicit binding', () => {
  const f = { ...fixture(), runtimeBinding: () => undefined };
  expect(() => assertOwnedCodexQueueControl(f, 'legacy', undefined)).not.toThrow();
  expect(f.custody).not.toHaveBeenCalled();
});
