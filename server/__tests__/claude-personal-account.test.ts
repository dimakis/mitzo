import './fixtures/offline-user-home.js';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountProfiles } from '../account-profiles.js';
import { resolveNewOrdinarySessionRuntime } from '../ordinary-session-runtime.js';
import { discoverClaudeModels } from '../claude-model-discovery.js';
vi.mock('../claude-model-discovery.js', () => ({ discoverClaudeModels: vi.fn() }));
const warn = vi.hoisted(() => vi.fn());
vi.mock('../logger.js', () => ({
  createLogger: () => ({ warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
afterEach(() => vi.restoreAllMocks());

const personal = {
  id: 'claude-personal',
  label: 'Personal Claude',
  provider: 'anthropic-claude',
  credentialRef: '/private/tmp/claude-personal-account',
  email: 'person@example.test',
  planType: 'max',
  models: [{ id: 'claude-opus-4-8', label: 'Opus' }],
};
it('reuses sign-in evidence in the existing account catalog and reports loss of login without changing billing', async () => {
  const verify = vi.mocked(discoverClaudeModels).mockResolvedValue([{ id: 'opus', label: 'Opus' }]);
  const profiles = new AccountProfiles([personal]);
  await profiles.checkSignIn(new AbortController().signal);
  expect(profiles.catalog()[0]).toMatchObject({
    billing: 'claude-subscription',
    signIn: { status: 'verified', observedIdentity: { email: personal.email, planType: 'max' } },
  });
  verify.mockRejectedValue(new Error('Private provider diagnostic'));
  await profiles.checkSignIn(new AbortController().signal);
  expect(profiles.catalog()[0]).toMatchObject({
    billing: 'claude-subscription',
    signIn: { status: 'failed', observedIdentity: null },
  });
  expect(JSON.stringify(profiles.catalog())).not.toContain('Private provider diagnostic');
  expect(warn).toHaveBeenCalledWith(
    'Claude subscription sign-in verification failed',
    expect.objectContaining({
      code: 'claude_subscription_sign_in_unavailable',
      stage: 'claude_sign_in_verification',
      accountId: personal.id,
      diagnosticId: expect.any(String),
      reason: 'native_command_failed',
    }),
  );
  expect(JSON.stringify(warn.mock.calls)).not.toContain('Private provider diagnostic');
  const controller = new AbortController();
  const cause = Error('Private cancellation');
  controller.abort(cause);
  await expect(profiles.checkSignIn(controller.signal)).rejects.toBe(cause);
  expect(profiles.catalog()[0].signIn?.explanation).toContain('cancelled');
});
it('projects a subscription account through the existing Claude catalog without Vertex billing or secret paths', () => {
  const profiles = new AccountProfiles([personal]);
  expect(profiles.catalog()[0]).toMatchObject({
    provider: 'anthropic-claude',
    billing: 'claude-subscription',
  });
  expect(JSON.stringify(profiles.catalog())).not.toContain(personal.credentialRef);
  expect(profiles.ordinaryLocalVertexInventory()[0].account.provider).toBe('anthropic-claude');
});
it('isolates both auth modes and binds personal configuration changes to the saved routing revision', () => {
  const vertex = {
    id: 'work',
    label: 'Work',
    provider: 'anthropic-vertex',
    projectId: 'project',
    region: 'region',
    credentialRef: '/private/tmp/adc.json',
    models: personal.models,
  };
  const profiles = new AccountProfiles([personal, vertex]);
  expect(
    profiles.sdkEnv(profiles.resolve('work', personal.models[0].id), {
      CLAUDE_CONFIG_DIR: '/private/tmp/work-history',
    }).CLAUDE_CONFIG_DIR,
  ).toBe('/private/tmp/work-history');
  const base = {
    PATH: '/usr/bin',
    HOME: '/private/tmp/host',
    CLAUDE_CODE_USE_VERTEX: '1',
    GOOGLE_APPLICATION_CREDENTIALS: '/private/tmp/work.json',
    ANTHROPIC_API_KEY: 'secret',
    ANTHROPIC_AUTH_TOKEN: 'secret',
    CLAUDE_CODE_OAUTH_TOKEN: 'secret',
    ANTHROPIC_BASE_URL: 'https://other.test',
    CLAUDE_CONFIG_DIR: '/private/tmp/other',
    ANTHROPIC_PROFILE: 'other',
  };
  const binding = profiles.resolve(personal.id, personal.models[0].id);
  const env = profiles.sdkEnv(binding, base);
  expect(env.CLAUDE_CONFIG_DIR).toBe(personal.credentialRef);
  for (const key of [
    'CLAUDE_CODE_USE_VERTEX',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_PROFILE',
  ])
    expect(env[key]).toBeUndefined();
  expect(profiles.sdkEnv(profiles.resolve('work', personal.models[0].id), env)).toMatchObject({
    CLAUDE_CODE_USE_VERTEX: '1',
    GOOGLE_APPLICATION_CREDENTIALS: vertex.credentialRef,
  });
  expect(
    profiles.sdkEnv(profiles.resolve('work', personal.models[0].id), env).CLAUDE_CONFIG_DIR,
  ).toBeUndefined();
  expect(() =>
    new AccountProfiles([{ ...personal, email: 'other@example.test' }]).resumeRouting(binding),
  ).toThrow();
});
it('resolves personal Claude only on the existing local Claude SDK target', () => {
  const account = {
    accountId: personal.id,
    provider: 'anthropic-claude',
    profileRevision: 'revision',
  };
  const catalog = {
    deployment: 'ordinary',
    enabledHarnesses: ['claude-sdk'],
    accounts: [{ ...account, auth: { kind: 'claude-host-login' } }],
    targets: [
      { targetId: 'mac', targetRevision: 'host', location: 'local' },
      {
        targetId: 'sandbox',
        targetRevision: 'sandbox',
        location: 'openshell',
        ownership: 'dedicated-ordinary',
        openaiApi: 'disabled',
      },
    ],
  };
  expect(
    resolveNewOrdinarySessionRuntime(
      { account, harness: 'claude-sdk', targetId: 'mac', mode: 'agent' },
      catalog,
    ).status,
  ).toBe('compatible');
  expect(
    resolveNewOrdinarySessionRuntime(
      { account, harness: 'claude-sdk', targetId: 'sandbox', mode: 'agent' },
      catalog,
    ).status,
  ).toBe('rejected');
});
