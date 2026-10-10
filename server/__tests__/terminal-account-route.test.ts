import { it, expect } from 'vitest';
import { AccountProfiles } from '../account-profiles.js';
import { terminalAccountRoute } from '../terminal-account-route.js';
it('verifies native ChatGPT profile identity for a saved terminal without invoking an inference runtime', () => {
  const profiles = new AccountProfiles(
    [
      {
        id: 'personal',
        label: 'Personal ChatGPT',
        provider: 'openai-codex',
        email: 'operator@example.test',
        planType: 'plus',
        nativeAuth: 'sandbox-chatgpt',
        nativeCatalogRevision: 1,
        sandboxProvider: 'personal-provider',
        sandboxProviderId: 'physical-provider',
        sandboxProviderType: 'codex',
        models: [{ id: 'gpt-6-luna', label: 'Luna' }],
      },
    ],
    { codexEnabled: true },
  );
  const binding = profiles.resolve('personal', 'gpt-6-luna');
  expect(terminalAccountRoute(profiles, binding, 'gpt-6-luna')).toEqual({
    kind: 'chatgpt-subscription-native',
    provider: 'personal-provider',
    providerType: 'codex',
    providerId: 'physical-provider',
    model: 'gpt-6-luna',
  });
});
