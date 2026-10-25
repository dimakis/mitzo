import { beforeEach, expect, it, vi } from 'vitest';
import { assertOwnedCodexQueueControl } from '../owned-codex-queue-control.js';
const auth = vi.hoisted(() => ({ revoked: false, persistent: true, primaryActor: false }));
vi.mock('../auth.js', () => ({
  hasPersistentRevocationAuthority: () => auth.persistent,
  isAuthenticatedOperatorSessionId: (id: string) => auth.primaryActor && id === 'web-login',
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
  auth.primaryActor = false;
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

it.each(['local', 'openshell'] as const)(
  'allows current primary-operator control of retained %s Codex queues across device logins only',
  (location) => {
    const local = { ...binding, execution: { ...binding.execution, location } };
    const f = {
      ...fixture(),
      runtimeBinding: () => local,
      custody: () => ({ authSessionId: 'phone-login', binding: local }),
    };
    const web = { id: 'web-login', expiresAt: Date.now() + 10000 };
    expect(() => assertOwnedCodexQueueControl(f, 'session', web)).toThrow();
    auth.primaryActor = true;
    expect(() => assertOwnedCodexQueueControl(f, 'session', web)).not.toThrow();
    const responses = { ...local, harness: { implementation: 'responses' as const } };
    expect(() =>
      assertOwnedCodexQueueControl(
        {
          ...f,
          runtimeBinding: () => responses,
          custody: () => ({ authSessionId: 'phone-login', binding: responses }),
        },
        'session',
        web,
      ),
    ).toThrow();
    auth.revoked = true;
    expect(() => assertOwnedCodexQueueControl(f, 'session', web)).toThrow();
  },
);
