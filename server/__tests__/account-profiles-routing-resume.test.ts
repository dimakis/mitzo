import { expect, it } from 'vitest';
import { AccountProfiles } from '../account-profiles.js';
const account = {
  id: 'personal',
  label: 'Personal',
  provider: 'openai-codex',
  credentialRef: '/offline/login',
  email: 'person@example.test',
  planType: 'plus',
  models: [{ id: 'old-model', label: 'Old' }],
};
it('retains account/native routing after a historical model disappears while requiring explicit valid inference selection', () => {
  const original = new AccountProfiles([account], { codexEnabled: true });
  const binding = original.resolve('personal', 'old-model');
  const current = new AccountProfiles(
    [{ ...account, models: [{ id: 'new-model', label: 'New', reasoningEfforts: ['low'] }] }],
    { codexEnabled: true },
  );
  expect(current.resumeRouting(binding)).toEqual(binding);
  expect(current.codexRoutingProfile(binding).model).toBe('old-model');
  expect(() => current.resume(binding)).toThrow();
  expect(() => current.codexProfile(binding)).toThrow();
  expect(() => current.validateModelSelection(binding, 'old-model', null)).toThrow();
  expect(() => current.validateModelSelection(binding, 'new-model', 'low')).not.toThrow();
  expect(() => current.validateModelSelection(binding, 'new-model', 'high')).toThrow();
});
it.each(['account', 'source', 'provider', 'disabled'] as const)(
  'routing-only resume still refuses %s drift',
  (reason) => {
    const binding = new AccountProfiles([account], { codexEnabled: true }).resolve(
      'personal',
      'old-model',
    );
    const current = new AccountProfiles(
      [{ ...account, ...(reason === 'source' ? { credentialRef: '/other/login' } : {}) }],
      { codexEnabled: reason !== 'disabled' },
    );
    expect(() =>
      current.resumeRouting({
        ...binding,
        ...(reason === 'account' ? { accountId: 'other' } : {}),
        ...(reason === 'provider' ? { provider: 'openai' } : {}),
      }),
    ).toThrow();
  },
);
