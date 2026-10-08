import { expect, it } from 'vitest';
import { AccountProfiles } from '../account-profiles.js';
it('exposes server-only OpenAI key bindings including unbound consumers for shared-key detection', () => {
  const ref = { provider: 'keychain', service: 'test', account: 'work' };
  const profiles = new AccountProfiles([
    {
      id: 'work',
      label: 'Work API',
      provider: 'openai',
      credentialRef: ref,
      sandboxProvider: 'work-api',
      sandboxProviderId: 'provider-id',
      models: [{ id: 'gpt-6-luna', label: 'Luna 6' }],
    },
    {
      id: 'host',
      label: 'Host API',
      provider: 'openai',
      credentialRef: ref,
      models: [{ id: 'gpt-6-luna', label: 'Luna 6' }],
    },
  ]);
  expect(profiles.openAIKeyManagementAccounts()).toEqual([
    {
      id: 'work',
      label: 'Work API',
      credentialRef: ref,
      providerName: 'work-api',
      providerId: 'provider-id',
    },
    { id: 'host', label: 'Host API', credentialRef: ref, providerName: '', providerId: '' },
  ]);
  expect(JSON.stringify(profiles.catalog())).not.toContain('credentialRef');
});
