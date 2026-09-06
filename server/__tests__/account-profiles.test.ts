import { describe, it, expect } from 'vitest';
import { AccountProfiles } from '../account-profiles.js';
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
  it('rejects an explicit account or model switch in a bound conversation', async () => {
    const { resolveAccountSelection } = await import('../account-profiles.js');
    const binding = new AccountProfiles([profile]).resolve('work', 'claude-sonnet-4-6');
    expect(() => resolveAccountSelection({ accountId: 'other' }, binding, true)).toThrow(
      /original account/i,
    );
    expect(() =>
      resolveAccountSelection({ accountId: 'work', model: 'other' }, binding, true),
    ).toThrow(/original account/i);
  });
});
