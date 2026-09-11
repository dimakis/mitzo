import { describe, it, expect } from 'vitest';
import { AccountProfiles, LEGACY_MODELS, resolveAccountSelection } from '../account-profiles.js';
import { V2SendMessage } from '@mitzo/protocol';

const profile = {
  id: 'work',
  label: 'Work Vertex',
  provider: 'anthropic-vertex',
  projectId: 'work-project',
  region: 'us-east5',
  credentialRef: '/server/credentials/work-adc.json',
  models: [{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }],
};

describe('explicit account binding', () => {
  it('resolves and constructs the SDK environment from one supplied profile snapshot', () => {
    const profiles = new AccountProfiles([profile]);
    const binding = resolveAccountSelection(
      { accountId: 'work', model: 'claude-sonnet-4-6' },
      null,
      false,
      profiles,
    )!;
    expect(profiles.sdkEnv(binding, {}).ANTHROPIC_VERTEX_PROJECT_ID).toBe('work-project');
  });
  it('sends only account IDs through the mobile protocol', () => {
    expect(
      V2SendMessage.parse({
        type: 'send',
        sessionId: null,
        prompt: 'hello',
        clientMsgId: 'm1',
        accountId: 'work',
        model: 'claude-sonnet-4-6',
      }).accountId,
    ).toBe('work');
  });
  it('exposes a public catalog without credential references or project configuration', () => {
    const catalog = new AccountProfiles([profile]).catalog();
    expect(catalog[0]).toMatchObject({
      id: 'work',
      provider: 'anthropic-vertex',
      billing: 'google-cloud',
      models: profile.models,
    });
    expect(JSON.stringify(catalog)).not.toContain('/server/credentials');
    expect(JSON.stringify(catalog)).not.toContain('work-project');
  });
  it('validates account and model without fallback', () => {
    const profiles = new AccountProfiles([profile]);
    expect(() => profiles.resolve('personal', 'claude-sonnet-4-6')).toThrow(/account/i);
    expect(() => profiles.resolve('work', 'gpt-5')).toThrow(/model/i);
    expect(() => profiles.resolve('work')).toThrow(/model/i);
  });
  it('pins billing and credentials and rejects changed configuration on resume', () => {
    const profiles = new AccountProfiles([profile]);
    const binding = profiles.resolve('work', 'claude-sonnet-4-6');
    expect(binding).toMatchObject({
      accountId: 'work',
      provider: 'anthropic-vertex',
      model: 'claude-sonnet-4-6',
    });
    expect(profiles.resume(binding)).toEqual(binding);
    expect(() =>
      new AccountProfiles([{ ...profile, projectId: 'personal' }]).resume(binding),
    ).toThrow(/changed/i);
    expect(() =>
      new AccountProfiles([{ ...profile, credentialRef: '/other.json' }]).resume(binding),
    ).toThrow(/changed/i);
  });
  it('constructs SDK environment with explicit credentials and removes alternate billing routes', () => {
    const profiles = new AccountProfiles([profile]);
    const binding = profiles.resolve('work', 'claude-sonnet-4-6');
    const env = profiles.sdkEnv(binding, {
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'secret',
      ANTHROPIC_AUTH_TOKEN: 'secret',
      ANTHROPIC_BASE_URL: 'http://proxy',
      CLAUDE_CODE_USE_BEDROCK: '1',
      OPENAI_API_KEY: 'personal',
      GOOGLE_APPLICATION_CREDENTIALS: '/wrong.json',
    });
    expect(env).toMatchObject({
      PATH: '/bin',
      CLAUDE_CODE_USE_VERTEX: '1',
      ANTHROPIC_VERTEX_PROJECT_ID: 'work-project',
      CLOUD_ML_REGION: 'us-east5',
      GOOGLE_APPLICATION_CREDENTIALS: profile.credentialRef,
    });
    for (const key of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_USE_BEDROCK',
      'OPENAI_API_KEY',
    ])
      expect(env[key]).toBeUndefined();
  });
  it('rejects duplicate IDs, inline secrets and unimplemented providers', () => {
    expect(() => new AccountProfiles([profile, profile])).toThrow();
    expect(() => new AccountProfiles([{ ...profile, apiKey: 'secret' }])).toThrow();
    expect(() => new AccountProfiles([{ ...profile, provider: 'openai' }])).toThrow();
  });
});

describe('saved selection policy', () => {
  it('never upgrades a legacy session into a different billing account', async () => {
    const { resolveAccountSelection } = await import('../account-profiles.js');
    expect(() =>
      resolveAccountSelection({ accountId: 'work', model: 'sonnet' }, null, true),
    ).toThrow(/new task/i);
    expect(resolveAccountSelection({}, null, true)).toBeUndefined();
  });
  it('keeps the account bound while allowing a validated model switch', async () => {
    const { resolveAccountSelection } = await import('../account-profiles.js');
    const profiles = new AccountProfiles([
      { ...profile, models: [...profile.models, { id: 'other', label: 'Other' }] },
    ]);
    const binding = profiles.resolve('work', 'claude-sonnet-4-6');
    expect(() => resolveAccountSelection({ accountId: 'other' }, binding, true)).toThrow(
      /original account/i,
    );
    expect(
      resolveAccountSelection({ accountId: 'work', model: 'other' }, binding, true, profiles),
    ).toEqual(binding);
    expect(() =>
      resolveAccountSelection({ accountId: 'work', model: 'missing' }, binding, true, profiles),
    ).toThrow(/model/i);
  });
});

describe('work OpenAI API profile', () => {
  const api = {
    id: 'work-api',
    label: 'Work OpenAI',
    provider: 'openai',
    credentialRef: { provider: 'keychain', service: 'mitzo', account: 'work' },
    sandboxProvider: 'openai-work',
    models: [
      {
        id: 'test-model',
        label: 'Test model',
        reasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium',
      },
    ],
  };
  it('publishes API billing without exposing its secret-store reference', () => {
    const profiles = new AccountProfiles([api]);
    const binding = profiles.resolve('work-api', 'test-model');
    expect(profiles.apiCredential(binding)).toEqual(api.credentialRef);
    expect(profiles.catalog()[0]).toMatchObject({
      provider: 'openai',
      billing: 'openai-api',
      capabilities: { images: false },
      models: api.models,
    });
    expect(JSON.stringify(profiles.catalog())).not.toContain('keychain');
    expect(() => profiles.sdkEnv(binding, {})).toThrow('native');
    expect(() =>
      new AccountProfiles([
        { ...api, credentialRef: { ...api.credentialRef, account: 'other' } },
      ]).resume(binding),
    ).toThrow('changed');
    expect(() =>
      new AccountProfiles([{ ...api, sandboxProvider: 'openai-other' }]).resume(binding),
    ).toThrow('changed');
    const unbound: Record<string, unknown> = { ...api };
    delete unbound.sandboxProvider;
    expect(() => new AccountProfiles([unbound])).not.toThrow();
  });

  it('validates live native model and thinking changes against the bound catalog', () => {
    const profiles = new AccountProfiles([
      {
        ...api,
        models: [
          ...api.models,
          { id: 'other-model', label: 'Other model', reasoningEfforts: ['low'] },
        ],
      },
    ]);
    const binding = profiles.resolve('work-api', 'test-model');
    expect(() => profiles.validateModelSelection(binding, 'other-model', 'low')).not.toThrow();
    expect(() => profiles.validateModelSelection(binding, 'missing-model', 'low')).toThrow(
      /model/i,
    );
    expect(() => profiles.validateModelSelection(binding, 'other-model', 'high')).toThrow(
      /thinking/i,
    );
  });

  it('does not advertise or accept Nano while API sessions require tools', () => {
    const profiles = new AccountProfiles([
      {
        ...api,
        models: [
          { id: 'gpt-5.4-nano', label: 'GPT-5.4 Nano' },
          { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
        ],
      },
    ]);
    expect(profiles.catalog()[0].models.map((model) => model.id)).toEqual(['gpt-5.4-mini']);
    expect(() => profiles.resolve('work-api', 'gpt-5.4-nano')).toThrow(/model/i);
  });
});

describe('brokered ChatGPT subscription profile', () => {
  const subscription = {
    id: 'personal',
    label: 'Personal ChatGPT',
    provider: 'openai-codex',
    email: 'person@example.test',
    planType: 'pro',
    sandboxProvider: 'personal-chatgpt',
    sandboxProviderType: 'openai-codex-oauth',
    sandboxProviderId: 'provider-object-1',
    sandboxGrantId: 'grant-generation-1',
    models: [{ id: 'gpt-test', label: 'GPT test' }],
  };

  it('preserves subscription billing and binds only opaque broker identities', () => {
    const profiles = new AccountProfiles([subscription], { codexEnabled: true });
    const binding = profiles.resolve('personal', 'gpt-test');
    expect(profiles.catalog()[0]).toMatchObject({
      provider: 'openai-codex',
      billing: 'chatgpt-subscription',
    });
    expect(profiles.codexProfile(binding)).toMatchObject({
      accountId: 'personal',
      planType: 'pro',
      sandboxProvider: 'personal-chatgpt',
      sandboxProviderType: 'openai-codex-oauth',
      sandboxProviderId: 'provider-object-1',
      sandboxGrantId: 'grant-generation-1',
    });
    expect(JSON.stringify(binding)).not.toContain('provider-object-1');
    expect(JSON.stringify(binding)).not.toContain('grant-generation-1');
  });

  it('requires a complete broker binding and rejects grant changes on resume', () => {
    for (const field of [
      'sandboxProvider',
      'sandboxProviderType',
      'sandboxProviderId',
      'sandboxGrantId',
    ]) {
      const incomplete: Record<string, unknown> = { ...subscription };
      delete incomplete[field];
      expect(() => new AccountProfiles([incomplete], { codexEnabled: true })).toThrow();
    }
    const profiles = new AccountProfiles([subscription], { codexEnabled: true });
    const binding = profiles.resolve('personal', 'gpt-test');
    expect(() =>
      new AccountProfiles([{ ...subscription, sandboxGrantId: 'another-grant' }], {
        codexEnabled: true,
      }).resume(binding),
    ).toThrow('changed');
  });

  it('rejects mixed host-login and brokered subscription routes', () => {
    expect(
      () =>
        new AccountProfiles([{ ...subscription, credentialRef: '/private/codex' }], {
          codexEnabled: true,
        }),
    ).toThrow('Invalid account profiles configuration');
  });
});

describe('legacy model catalog', () => {
  it('uses only the allowlist matching the legacy Vertex route', () => {
    const profiles = new AccountProfiles([
      profile,
      {
        ...profile,
        id: 'other',
        projectId: 'other-project',
        models: [{ id: 'claude-sonnet-5', label: 'Sonnet 5' }],
      },
    ]);
    expect(profiles.legacyModels('work-project', 'us-east5', profile.credentialRef)).toEqual(
      profile.models,
    );
    expect(profiles.legacyModels('work-project', 'global', profile.credentialRef)).toBeUndefined();
    expect(profiles.legacyModels(undefined, 'us-east5', profile.credentialRef)).toBeUndefined();
  });
});

it('does not advertise unavailable newer models in the fallback Vertex catalog', () => {
  expect(LEGACY_MODELS.map((m) => m.id)).not.toContain('claude-sonnet-5');
  expect(LEGACY_MODELS.map((m) => m.id)).not.toContain('claude-opus-4-8');
});

it('never expands a Vertex project allowlist from SDK model discovery', async () => {
  const { refreshModels } = await import('../model-catalog.js');
  const restricted = { ...profile, id: 'restricted-discovery' };
  await refreshModels(JSON.stringify(restricted), async () => [
    ...profile.models,
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  ]);
  const profiles = new AccountProfiles([restricted]);
  expect(profiles.catalog()[0].models).toEqual(profile.models);
  expect(() => profiles.resolve(restricted.id, 'claude-sonnet-5')).toThrow(/unavailable/);
});

it('matches legacy credentials and rejects ambiguous route profiles', () => {
  const other = {
    ...profile,
    id: 'other-credentials',
    credentialRef: '/other/adc.json',
    models: [{ id: 'other-model', label: 'Other' }],
  };
  const profiles = new AccountProfiles([other, profile]);
  expect(profiles.legacyModels(profile.projectId, profile.region, profile.credentialRef)).toEqual(
    profile.models,
  );
  expect(
    profiles.legacyModels(profile.projectId, profile.region, '/missing/adc.json'),
  ).toBeUndefined();
  expect(profiles.legacyModels(profile.projectId, profile.region, undefined)).toBeUndefined();
  const ambiguous = new AccountProfiles([
    profile,
    { ...profile, id: 'duplicate-route', models: other.models },
  ]);
  expect(() =>
    ambiguous.legacyModels(profile.projectId, profile.region, profile.credentialRef),
  ).toThrow(/ambiguous/i);
});

it('binds Gemini to its explicit Google Vertex route without using the Claude SDK', () => {
  const google = {
    ...profile,
    id: 'google-work',
    provider: 'google-vertex',
    models: [{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }],
  };
  const profiles = new AccountProfiles([google]);
  const binding = profiles.resolve('google-work', 'gemini-3.8-flash');
  expect(profiles.googleProfile(binding)).toEqual({
    projectId: profile.projectId,
    region: profile.region,
    credentialRef: profile.credentialRef,
  });
  expect(profiles.catalog()[0]).toMatchObject({
    provider: 'google-vertex',
    billing: 'google-cloud',
    capabilities: { images: false, streaming: false },
  });
  expect(() => profiles.sdkEnv(binding, {})).toThrow(/native/);
  expect(
    profiles.legacyModels(profile.projectId, profile.region, profile.credentialRef),
  ).toBeUndefined();
});

it.each(['anthropic-vertex', 'google-vertex'])(
  'protects custom %s credential paths from native tools even after profile removal',
  async (provider) => {
    const { isPrivateCodexPath } = await import('../codex-private-path.js');
    const credentialRef = `/server/custom-${provider}/adc.json`;
    new AccountProfiles([{ ...profile, provider, credentialRef }]);
    expect(isPrivateCodexPath(credentialRef)).toBe(true);
    new AccountProfiles([]);
    expect(isPrivateCodexPath(credentialRef)).toBe(true);
  },
);
