import './fixtures/offline-user-home.js';
import { afterEach, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSubscriptionCustody } from '../claude-subscription-custody.js';
import { discoverClaudeModels, claudeModelLabel } from '../claude-model-discovery.js';
import { AccountProfiles } from '../account-profiles.js';
const warn = vi.hoisted(() => vi.fn());
vi.mock('../logger.js', () => ({
  createLogger: () => ({ warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('../credential-sdk-boundary.js', () => ({ credentialSdkBoundary: () => undefined }));
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const env = {
    CLAUDE_CONFIG_DIR: '/private/tmp/test-claude',
    MITZO_CLAUDE_EXPECTED_EMAIL: 'person@example.test',
    MITZO_CLAUDE_EXPECTED_PLAN: 'max',
  };
  const verify = vi.fn(async () => {});
  const assertCurrent = vi.fn();
  vi.spyOn(ClaudeSubscriptionCustody, 'capture').mockReturnValue({
    verify,
    assertCurrent,
    snapshot: () => ({ executable: { path: '/fixture/claude' } }),
  } as never);
  const supportedModels = vi.fn(async () => [
    {
      value: 'opus',
      displayName: 'Claude Opus',
      description: '',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high', 'max'],
    },
    { value: 'haiku', displayName: 'Claude Haiku', description: '', supportsEffort: false },
  ]);
  const accountInfo = vi.fn(async () => ({
    apiProvider: 'firstParty',
    email: env.MITZO_CLAUDE_EXPECTED_EMAIL,
    subscriptionType: 'max',
    apiKeySource: 'none',
  }));
  const close = vi.fn();
  vi.mocked(query).mockReturnValue({ supportedModels, accountInfo, close } as never);
  return { env, verify, assertCurrent, supportedModels, accountInfo, close };
}
it('reads native model capabilities without a prompt and closes its isolated metadata query', async () => {
  const f = fixture();
  const result = await discoverClaudeModels(f.env, new AbortController().signal);
  expect(result).toEqual([
    { id: 'opus', label: 'Claude Opus', reasoningEfforts: ['low', 'high', 'max'] },
    { id: 'haiku', label: 'Claude Haiku' },
  ]);
  const request = vi.mocked(query).mock.calls.at(-1)![0];
  expect(request.options).toMatchObject({
    env: f.env,
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    settings: { disableAllHooks: true },
  });
  expect(typeof request.prompt).not.toBe('string');
  const messages = [];
  for await (const message of request.prompt as AsyncIterable<unknown>) messages.push(message);
  expect(messages).toEqual([]);
  expect(f.verify).toHaveBeenCalledTimes(2);
  expect(f.close).toHaveBeenCalledOnce();
  expect(existsSync(request.options!.cwd!)).toBe(false);
});
it.each(['identity', 'custody', 'cancelled'])(
  'rejects %s changes and closes the metadata query',
  async (failure) => {
    const f = fixture();
    const controller = new AbortController();
    if (failure === 'identity')
      f.accountInfo.mockResolvedValueOnce({
        apiProvider: 'firstParty',
        email: 'wrong@example.test',
        subscriptionType: 'max',
        apiKeySource: 'none',
      });
    if (failure === 'custody') f.verify.mockRejectedValueOnce(new Error('custody changed'));
    if (failure === 'cancelled')
      f.supportedModels.mockImplementationOnce(async () => {
        controller.abort();
        return [];
      });
    await expect(discoverClaudeModels(f.env, controller.signal)).rejects.toThrow();
    if (failure !== 'custody') expect(f.close).toHaveBeenCalledOnce();
  },
);
it('publishes discovered choices consistently, scopes refresh, and retains stale metadata on failure', async () => {
  const f = fixture();
  const profile = {
    id: 'discovery-claude',
    label: 'Personal Claude',
    provider: 'anthropic-claude',
    credentialRef: f.env.CLAUDE_CONFIG_DIR,
    email: f.env.MITZO_CLAUDE_EXPECTED_EMAIL,
    planType: 'max',
    models: [{ id: 'sonnet', label: 'Sonnet' }],
  };
  const profiles = new AccountProfiles([profile, { ...profile, id: 'other-claude' }]);
  await profiles.refresh(true, { accountId: profile.id });
  expect(f.supportedModels).toHaveBeenCalledOnce();
  const model = profiles.catalog()[0].models[0];
  expect(model).toMatchObject({ id: 'opus', reasoningEfforts: ['low', 'high', 'max'] });
  expect(profiles.ordinaryLocalVertexInventory()[0].models[0]).toEqual(model);
  const binding = profiles.resolve(profile.id, 'opus');
  expect(() => profiles.validateModelSelection(binding, 'opus', 'high')).not.toThrow();
  expect(() => profiles.validateModelSelection(binding, 'haiku', 'high')).toThrow('Thinking');
  f.supportedModels.mockRejectedValueOnce(new Error('private provider response'));
  await profiles.refresh(true, { accountId: profile.id });
  expect(profiles.catalog()[0].modelDiscovery.stale).toBe(true);
  expect(profiles.catalog()[0].models[0]).toEqual(model);
  expect(warn).toHaveBeenCalledWith(
    'Claude model discovery failed',
    expect.objectContaining({ accountId: profile.id, code: 'claude_model_discovery_failed' }),
  );
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private provider response');
});

it('bounds a stalled native model read and retains an explicit stale fallback', async () => {
  const f = fixture();
  f.supportedModels.mockImplementationOnce(() => new Promise(() => {}));
  const profiles = new AccountProfiles(
    [
      {
        id: 'timeout-claude',
        label: 'Claude',
        provider: 'anthropic-claude',
        credentialRef: f.env.CLAUDE_CONFIG_DIR,
        email: f.env.MITZO_CLAUDE_EXPECTED_EMAIL,
        planType: 'max',
        models: [{ id: 'sonnet', label: 'Sonnet' }],
      },
    ],
    { modelDiscoveryTimeoutMs: 10 },
  );
  await profiles.refresh(true);
  expect(f.close).toHaveBeenCalledOnce();
  expect(profiles.catalog()[0]).toMatchObject({
    models: [{ id: 'sonnet' }],
    modelDiscovery: { stale: true },
  });
});

it('keeps configured model order and supported thinking defaults when native metadata refreshes', async () => {
  const f = fixture();
  const profiles = new AccountProfiles([
    {
      id: 'configured-claude',
      label: 'Claude',
      provider: 'anthropic-claude',
      credentialRef: f.env.CLAUDE_CONFIG_DIR,
      email: f.env.MITZO_CLAUDE_EXPECTED_EMAIL,
      planType: 'max',
      models: [
        { id: 'haiku', label: 'Haiku', defaultReasoningEffort: 'high' },
        { id: 'opus', label: 'Opus', defaultReasoningEffort: 'high' },
      ],
    },
  ]);
  await profiles.refresh(true);
  expect(profiles.catalog()[0].models).toEqual([
    { id: 'haiku', label: 'Claude Haiku' },
    {
      id: 'opus',
      label: 'Claude Opus',
      reasoningEfforts: ['low', 'high', 'max'],
      defaultReasoningEffort: 'high',
    },
  ]);
});

it.each([
  [
    { value: 'opus', displayName: 'Opus', description: 'Opus 5.5 · Most capable for complex work' },
    'Claude Opus 5.5',
  ],
  [
    { value: 'opus[1m]', displayName: 'Opus (1M context)', description: 'Opus 5.5 · Long context' },
    'Claude Opus 5.5 (1M context)',
  ],
  [
    { value: 'claude-sonnet-4-6-20260101', displayName: 'Claude Sonnet', description: '' },
    'Claude Sonnet 4.6',
  ],
  [
    {
      value: 'default',
      displayName: 'Default (recommended)',
      description: 'Sonnet 4.6 · Recommended',
    },
    'Claude Sonnet 4.6 · Default (recommended)',
  ],
  [{ value: 'opus', displayName: 'Claude Opus 5.5', description: '' }, 'Claude Opus 5.5'],
  [
    { value: 'opus', displayName: 'Claude Opus', description: 'Fast alternative to Sonnet 4.6' },
    'Claude Opus',
  ],
])(
  'shows versions reported by native metadata without guessing alias mappings: %j',
  (model, expected) => {
    expect(claudeModelLabel(model)).toBe(expected);
  },
);
