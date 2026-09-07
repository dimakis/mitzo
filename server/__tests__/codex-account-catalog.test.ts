import { expect, it } from 'vitest';
import { AccountProfiles, resolveAccountSelection } from '../account-profiles.js';
const profile = {
  id: 'personal',
  label: 'Personal ChatGPT · subscription',
  provider: 'openai-codex',
  credentialRef: '/login',
  email: 'test@example.com',
  planType: 'test',
  models: [{ id: 'luna', label: 'Luna' }],
};
it('keeps Codex out of the catalog unless explicitly enabled for development', () => {
  const profiles = new AccountProfiles([profile]);
  expect(profiles.catalog()).toEqual([]);
  expect(() => profiles.resolve('personal', 'luna')).toThrow('not enabled');
});
it('binds the explicit subscription account without exposing credential references or allowing SDK fallback', () => {
  const profiles = new AccountProfiles([profile], { codexEnabled: true });
  expect(profiles.catalog()).toEqual([
    {
      id: 'personal',
      label: profile.label,
      provider: 'openai-codex',
      billing: 'chatgpt-subscription',
      models: profile.models,
      capabilities: { streaming: true, tools: true, images: false },
    },
  ]);
  expect(JSON.stringify(profiles.catalog())).not.toContain('/login');
  const binding = profiles.resolve('personal', 'luna');
  expect(profiles.codexProfile(binding)).toMatchObject({
    accountId: 'personal',
    credentialRef: '/login',
    model: 'luna',
  });
  expect(() => profiles.sdkEnv(binding, {})).toThrow('Codex');
  const changed = new AccountProfiles([{ ...profile, credentialRef: '/other' }], {
    codexEnabled: true,
  });
  expect(() => changed.resume(binding)).toThrow('configuration changed');
});

it('permits explicit Codex model changes in the same configured subscription only', () => {
  const profiles = new AccountProfiles(
    [{ ...profile, models: [...profile.models, { id: 'terra', label: 'Terra' }] }],
    { codexEnabled: true },
  );
  const binding = profiles.resolve('personal', 'luna');
  expect(
    resolveAccountSelection({ accountId: 'personal', model: 'terra' }, binding, true, profiles),
  ).toEqual(binding);
  expect(() =>
    resolveAccountSelection({ accountId: 'personal', model: 'missing' }, binding, true, profiles),
  ).toThrow(/unavailable/i);
  expect(() =>
    resolveAccountSelection({ accountId: 'other', model: 'terra' }, binding, true, profiles),
  ).toThrow(/original account/i);
});

it('requires a separate explicit activation flag for production subscription execution', async () => {
  const { vi } = await import('vitest');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { loadAccountProfiles } = await import('../account-profiles.js');
  const root = mkdtempSync(join(tmpdir(), 'mitzo-prod-accounts-'));
  writeFileSync(join(root, 'accounts.json'), JSON.stringify([profile]));
  vi.stubEnv('MITZO_ACCOUNT_PROFILES_FILE', join(root, 'accounts.json'));
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('MITZO_CODEX_DEV_ENABLED', '1');
  vi.stubEnv('MITZO_CODEX_ENABLED', '0');
  try {
    expect(loadAccountProfiles().catalog()).toEqual([]);
    vi.stubEnv('MITZO_CODEX_ENABLED', '1');
    expect(loadAccountProfiles().catalog()).toHaveLength(1);
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
