import { expect, it } from 'vitest';
import { codexApiProvider } from '../codex-api-provider.js';
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
