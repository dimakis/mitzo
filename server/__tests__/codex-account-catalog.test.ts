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
      modelDiscovery: { stale: false, updatedAt: undefined },
      capabilities: { streaming: true, tools: true, images: true },
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
it('accepts discovered models without changing account binding identity', async () => {
  const { refreshModels } = await import('../model-catalog.js');
  // Use a distinct profile so this test does not pollute other catalog tests.
  const configuration = { ...profile, id: 'discovered-account' };
  const profiles = new AccountProfiles([configuration], { codexEnabled: true });
  const binding = profiles.resolve(configuration.id, 'luna');
  // Discovery keys use the parsed profile's canonical field order.
  const key = JSON.stringify({
    id: configuration.id,
    label: configuration.label,
    provider: configuration.provider,
    credentialRef: configuration.credentialRef,
    email: configuration.email,
    planType: configuration.planType,
    models: configuration.models,
  });
  await refreshModels(key, async () => [
    {
      id: 'new-model',
      label: 'New model',
      reasoningEfforts: ['high'],
      defaultReasoningEffort: 'high',
    },
  ]);
  expect(profiles.resolve(configuration.id, 'new-model').profileRevision).toBe(
    binding.profileRevision,
  );
  expect(profiles.resume(binding)).toEqual(binding);
});
