import {
  apiHarnessConnection,
  ApiHarnessConnectionSchema,
  OPENAI_RESPONSES_ENDPOINT,
  type ApiHarnessConnection,
} from './account-harness-connection.js';
import { z } from 'zod';

export interface CodexApiProvider {
  readonly modelProvider: 'openai' | 'mitzo_api';
  readonly configuration: Readonly<Record<string, string | boolean>>;
}

/** Native provider selection is separate from the account's billing identity.
 * Custom Responses endpoints are qualified for HTTP streaming, not OpenAI's
 * WebSocket extension. Both routes retain the existing private API-key login.
 */
export function codexApiProvider(connection?: ApiHarnessConnection): CodexApiProvider {
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

/** Check the effective native config before a workspace can start a thread.
 * Native optional provider fields default to null. Non-null extensions could
 * introduce another credential source, catalog URL or unqualified transport.
 */
export function assertCodexApiProviderConfiguration(
  configuration: unknown,
  provider: CodexApiProvider,
) {
  if (provider.modelProvider !== 'mitzo_api') return;
  const parsed = z
    .object({
      model_provider: z.literal('mitzo_api'),
      model_providers: z.object({
        mitzo_api: z
          .object({
            name: z.literal('Configured API'),
            base_url: z.literal(provider.configuration['model_providers.mitzo_api.base_url']),
            wire_api: z.literal('responses'),
            requires_openai_auth: z.literal(true),
            supports_websockets: z.literal(false),
            supports_standalone_web_search: z.literal(false).optional(),
          })
          .catchall(z.null()),
      }),
    })
    .safeParse(configuration);
  if (!parsed.success)
    throw Error('Custom Codex provider configuration does not match the selected API connection');
}
