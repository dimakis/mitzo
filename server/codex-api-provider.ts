import {
  apiHarnessConnection,
  ApiHarnessConnectionSchema,
  OPENAI_RESPONSES_ENDPOINT,
  type ApiHarnessConnection,
} from './account-harness-connection.js';

/** Native provider selection is separate from the account's billing identity.
 * Custom Responses endpoints are qualified for HTTP streaming, not OpenAI's
 * WebSocket extension. Both routes retain the existing private API-key login.
 */
export function codexApiProvider(connection?: ApiHarnessConnection) {
  const selected = apiHarnessConnection(
    connection ? ApiHarnessConnectionSchema.parse(connection) : undefined,
  );
  if (selected.endpoint === OPENAI_RESPONSES_ENDPOINT)
    return {
      modelProvider: 'openai',
      configuration: { model_provider: 'openai', openai_base_url: selected.endpoint },
    };
  return {
    modelProvider: 'mitzo_api',
    configuration: {
      model_provider: 'mitzo_api',
      'model_providers.mitzo_api.name': 'Configured API',
      'model_providers.mitzo_api.base_url': selected.endpoint,
      'model_providers.mitzo_api.wire_api': 'responses',
      'model_providers.mitzo_api.supports_websockets': false,
      'model_providers.mitzo_api.requires_openai_auth': true,
    },
  };
}
