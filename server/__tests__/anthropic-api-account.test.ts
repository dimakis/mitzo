import './fixtures/offline-user-home.js';
import { describe, expect, it, vi } from 'vitest';
import { AccountProfiles } from '../account-profiles.js';
import { sessionHarnessForProvider } from '../session-harness-routing.js';
import { resolveOrdinarySessionRuntime } from '../ordinary-session-runtime.js';
import {
  captureClaudeSdkCredentials,
  reopenClaudeSdkCredentials,
  verifyClaudeSdkCredentials,
} from '../claude-sdk-credentials.js';
import { AnthropicApiCustody } from '../anthropic-api-custody.js';

const keychain = vi.hoisted(() => ({ read: vi.fn() }));
const enrollment = vi.hoisted(() => ({ manages: vi.fn(), resolveHostKey: vi.fn() }));
vi.mock('../keychain-rotation-credentials.js', () => ({
  KeychainRotationCredentials: class {
    read = keychain.read;
  },
}));
vi.mock('../connections-runtime.js', () => ({
  getConnectionsRuntime: () => ({ openAIEnrollmentAuthority: enrollment }),
}));

const profile = {
  id: 'enmaas-anthropic',
  label: 'EnMaaS Claude',
  provider: 'anthropic-api',
  connection: {
    endpoint: 'https://models.example.com/anthropic',
    protocol: 'messages',
    qualification: {
      source: 'operator',
      streaming: true,
      toolCalls: true,
      continuation: true,
      cancellation: true,
    },
  },
  credentialRef: { provider: 'keychain', service: 'mitzo.anthropic.test', account: 'api-key' },
  credentialVersion: 'eec02914-ac1f-4369-ab86-8e4f130abc92',
  models: [{ id: 'hosted/claude-sonnet', label: 'Hosted Sonnet' }],
};

describe('Anthropic Messages accounts', () => {
  it('projects an explicit Claude route without inherited Vertex or subscription credentials', () => {
    const profiles = new AccountProfiles([profile]);
    const binding = profiles.resolve(profile.id, profile.models[0].id);
    const env = profiles.sdkEnv(binding, {
      PATH: '/bin',
      CLAUDE_CODE_USE_VERTEX: '1',
      GOOGLE_APPLICATION_CREDENTIALS: '/private/adc',
      ANTHROPIC_AUTH_TOKEN: 'ambient',
      ANTHROPIC_API_KEY: 'ambient',
      CLAUDE_CONFIG_DIR: '/personal',
      CLAUDE_CODE_USE_BEDROCK: '1',
    });
    expect(sessionHarnessForProvider(binding.provider)).toBe('claude-sdk');
    expect(profiles.catalog()[0]).toMatchObject({
      provider: 'anthropic-api',
      billing: 'anthropic-api',
    });
    expect(env).toMatchObject({
      PATH: '/bin',
      ANTHROPIC_BASE_URL: profile.connection.endpoint,
      CLAUDE_CODE_USE_VERTEX: '0',
    });
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('GOOGLE_APPLICATION_CREDENTIALS');
    expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    const account = profiles.ordinaryLocalVertexInventory()[0].account;
    expect(
      resolveOrdinarySessionRuntime(
        { account, harness: 'claude-sdk', targetId: 'mac', mode: 'agent' },
        {
          deployment: 'ordinary',
          enabledHarnesses: ['claude-sdk'],
          accounts: [{ ...account, auth: { kind: 'anthropic-api-key' } }],
          targets: [{ targetId: 'mac', targetRevision: 'rev', location: 'local' }],
        },
      ).status,
    ).toBe('compatible');
  });

  it('pins endpoint, credential reference and version across resumes', () => {
    const profiles = new AccountProfiles([profile]);
    const binding = profiles.resolve(profile.id, profile.models[0].id);
    for (const changed of [
      { credentialVersion: 'eec02914-ac1f-4369-ab86-8e4f130abc93' },
      { connection: { ...profile.connection, endpoint: 'https://other.example.com' } },
      { credentialRef: { ...profile.credentialRef, account: 'other' } },
    ]) {
      expect(() =>
        new AccountProfiles([{ ...profile, ...changed }]).resumeRouting(binding),
      ).toThrow();
    }
    expect(
      () =>
        new AccountProfiles([
          { ...profile, connection: { ...profile.connection, protocol: 'responses' } },
        ]),
    ).toThrow();
    expect(
      () =>
        new AccountProfiles([
          { ...profile, connection: { ...profile.connection, endpoint: 'http://localhost' } },
        ]),
    ).toThrow();
  });

  it('checks versioned Keychain custody and never saves the key in its receipt', async () => {
    keychain.read.mockResolvedValue({
      value: 'fixture-key',
      version: profile.credentialVersion,
      managed: true,
    });
    const profiles = new AccountProfiles([profile]);
    const env = profiles.sdkEnv(profiles.resolve(profile.id, profile.models[0].id), {});
    const custody = captureClaudeSdkCredentials(env);
    const signal = new AbortController().signal;
    await verifyClaudeSdkCredentials(custody, env, signal);
    expect(JSON.stringify(custody.snapshot())).not.toContain('fixture-key');
    const reopened = reopenClaudeSdkCredentials(custody.snapshot(), env);
    if (!(reopened instanceof AnthropicApiCustody)) throw Error('Wrong credential authority');
    await expect(reopened.inferenceEnvironment(env, signal)).resolves.toMatchObject({
      ANTHROPIC_API_KEY: 'fixture-key',
      ANTHROPIC_BASE_URL: profile.connection.endpoint,
    });
    keychain.read.mockResolvedValue({
      value: 'different-key',
      version: 'eec02914-ac1f-4369-ab86-8e4f130abc93',
      managed: true,
    });
    await expect(verifyClaudeSdkCredentials(reopened, env, signal)).rejects.toThrow();
    expect(() => reopened.assertCurrent({ ...env, ANTHROPIC_AUTH_TOKEN: 'unexpected' })).toThrow();
  });

  it('requires the original enrollment controller for enrolled credentials and never falls back to direct Keychain access', async () => {
    const enrolled = {
      ...profile,
      credentialRef: {
        ...profile.credentialRef,
        service: 'mitzo.openai.enrollment.' + profile.credentialVersion,
      },
    };
    const profiles = new AccountProfiles([enrolled]);
    const env = profiles.sdkEnv(profiles.resolve(profile.id, profile.models[0].id), {});
    const custody = captureClaudeSdkCredentials(env);
    keychain.read.mockClear();
    enrollment.manages.mockReturnValue(true);
    enrollment.resolveHostKey.mockResolvedValue('controller-fixture-key');
    const signal = new AbortController().signal;
    await expect(verifyClaudeSdkCredentials(custody, env, signal)).resolves.toBeUndefined();
    expect(enrollment.resolveHostKey).toHaveBeenCalledWith(
      'openai-' + profile.credentialVersion,
      signal,
    );
    enrollment.manages.mockReturnValue(false);
    await expect(verifyClaudeSdkCredentials(custody, env, signal)).rejects.toMatchObject({
      code: 'ANTHROPIC_CREDENTIAL_UNAVAILABLE',
    });
    expect(keychain.read).not.toHaveBeenCalled();
  });
});
