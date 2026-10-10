import { describe, expect, it } from 'vitest';
import { SessionRuntimeBindingV1Schema } from '../src/index.js';

const runtimeBinding = {
  version: 1,
  account: {
    accountId: 'personal',
    provider: 'openai-codex',
    profileRevision: 'profile-1',
  },
  harness: { implementation: 'codex' },
  execution: { location: 'local' },
} as const;

describe('dormant session runtime binding v1', () => {
  it('separates the agent implementation from execution location', () => {
    expect(SessionRuntimeBindingV1Schema.parse(runtimeBinding)).toEqual(runtimeBinding);
    expect(
      SessionRuntimeBindingV1Schema.parse({
        ...runtimeBinding,
        execution: { location: 'openshell' },
      }).harness,
    ).toEqual(runtimeBinding.harness);
  });

  it.each([
    ['codex', 'openai-codex'],
    ['codex', 'openai'],
    ['claude-sdk', 'anthropic-vertex'],
    ['responses', 'openai'],
    ['gemini', 'google-vertex'],
  ])('describes %s/%s without admitting execution', (implementation, provider) => {
    for (const location of ['local', 'openshell']) {
      expect(
        SessionRuntimeBindingV1Schema.safeParse({
          ...runtimeBinding,
          account: { ...runtimeBinding.account, provider },
          harness: { implementation },
          execution: { location },
        }).success,
      ).toBe(true);
    }
  });

  it.each([
    { ...runtimeBinding, harness: { implementation: 'claude-sdk' } },
    { ...runtimeBinding, version: 2 },
    { ...runtimeBinding, apiKey: 'never-persist-credentials' },
    { ...runtimeBinding, account: { ...runtimeBinding.account, token: 'secret' } },
    { ...runtimeBinding, account: { ...runtimeBinding.account, provider: 'unknown' } },
    { ...runtimeBinding, account: { ...runtimeBinding.account, profileRevision: '' } },
    { ...runtimeBinding, harness: { implementation: 'unknown' } },
    { ...runtimeBinding, execution: { location: 'cloud' } },
    { ...runtimeBinding, execution: { location: 'local', targetId: 'not-owned-here' } },
    { ...runtimeBinding, execution: { ...runtimeBinding.execution, isolated: true } },
  ])('rejects unsupported or credential-bearing runtime metadata: %j', (binding) => {
    expect(SessionRuntimeBindingV1Schema.safeParse(binding).success).toBe(false);
  });
});
