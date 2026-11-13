import { expect, it } from 'vitest';
import { assertCodexApiProviderConfiguration, codexApiProvider } from '../codex-api-provider.js';
import type { ApiHarnessConnection } from '../account-harness-connection.js';

const qualification = {
  source: 'operator' as const,
  streaming: true,
  toolCalls: true,
  continuation: true,
  cancellation: true,
};
const connection: ApiHarnessConnection = {
  endpoint: 'https://gateway.example/v1',
  protocol: 'responses',
  qualification,
};
const nativeProvider = {
  name: 'Configured API',
  base_url: connection.endpoint,
  wire_api: 'responses',
  requires_openai_auth: true,
  supports_websockets: false,
  supports_standalone_web_search: false,
  env_key: null,
  http_headers: null,
};
const nativeConfiguration = (provider = nativeProvider) => ({
  model_provider: 'mitzo_api',
  model_providers: { mitzo_api: provider },
});

it('accepts the native HTTP provider defaults without accepting alternate credential sources', () => {
  expect(() =>
    assertCodexApiProviderConfiguration(nativeConfiguration(), codexApiProvider(connection)),
  ).not.toThrow();
  expect(() => assertCodexApiProviderConfiguration({}, codexApiProvider())).not.toThrow();
});

const providerOverrides: Array<[string, unknown]> = [
  ['base_url', 'https://another.example/v1'],
  ['requires_openai_auth', false],
  ['supports_websockets', true],
  ['env_key', 'ANOTHER_ACCOUNT_KEY'],
  ['experimental_bearer_token', 'synthetic-alternate-key'],
  ['http_headers', { 'x-api-key': 'synthetic-alternate-key' }],
  ['model_catalog_url', 'https://another.example/models'],
];
it.each(providerOverrides)(
  'rejects a workspace provider override of %s before any thread effect',
  (key, value) => {
    expect(() =>
      assertCodexApiProviderConfiguration(
        nativeConfiguration({ ...nativeProvider, [key]: value }),
        codexApiProvider(connection),
      ),
    ).toThrow('Custom Codex provider configuration does not match the selected API connection');
  },
);

it.each([
  undefined,
  { ...connection, endpoint: 'https://api.openai.com/v1' },
  { ...connection, endpoint: 'https://API.OPENAI.COM/v1/' },
])('retains the built-in OpenAI provider for official API accounts: %j', (selected) => {
  expect(codexApiProvider(selected)).toEqual({
    modelProvider: 'openai',
    configuration: { model_provider: 'openai', openai_base_url: 'https://api.openai.com/v1' },
  });
});

it('uses HTTP Responses and the existing private API login for a custom endpoint', () => {
  expect(codexApiProvider(connection)).toEqual({
    modelProvider: 'mitzo_api',
    configuration: {
      model_provider: 'mitzo_api',
      'model_providers.mitzo_api.name': 'Configured API',
      'model_providers.mitzo_api.base_url': connection.endpoint,
      'model_providers.mitzo_api.wire_api': 'responses',
      'model_providers.mitzo_api.supports_websockets': false,
      'model_providers.mitzo_api.requires_openai_auth': true,
    },
  });
});

it('keeps endpoint qualification and protocol validation before provider selection', () => {
  expect(() => codexApiProvider({ ...connection, qualification: undefined })).toThrow(
    'requires explicit operator qualification',
  );
  expect(() => codexApiProvider({ ...connection, protocol: 'messages' })).toThrow(
    'Codex requires the Responses protocol',
  );
});
