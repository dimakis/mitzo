import { z } from 'zod';
import {
  ApiHarnessConnectionSchema,
  apiHarnessConnection,
  PublicApiEndpointSchema,
} from './account-harness-connection.js';
import { AnthropicApiConnectionSchema } from './anthropic-api-connection.js';
import { sendConnectionRequest } from './credential-http.js';
import type { ConnectionSender } from './credential-connections.js';
import {
  CredentialVerificationError,
  verificationTransportError,
} from './credential-verification-error.js';

export const ApiProviderEndpointSchema = PublicApiEndpointSchema;

const QualifiedResponsesConnectionSchema = ApiHarnessConnectionSchema.extend({
  endpoint: ApiProviderEndpointSchema,
  protocol: z.literal('responses'),
}).superRefine((connection, ctx) => {
  try {
    apiHarnessConnection(connection);
  } catch {
    ctx.addIssue({
      code: 'custom',
      message:
        'Confirm Responses streaming, tool calls, continuation and cancellation compatibility with Codex',
    });
  }
});
export const QualifiedApiConnectionSchema = z.union([
  QualifiedResponsesConnectionSchema,
  AnthropicApiConnectionSchema,
]);
export type QualifiedApiConnection = z.infer<typeof QualifiedApiConnectionSchema>;
export interface ApiDiscoveryOptions {
  protocol?: 'responses' | 'messages';
  authentication?: 'api-key' | 'bearer';
}
export const ApiAccountModelsSchema = z
  .array(
    z
      .object({
        id: z.string().trim().min(1).max(256).regex(/^\S+$/),
        label: z.string().trim().min(1).max(256),
      })
      .strict(),
  )
  .min(1)
  .max(200)
  .refine(
    (models) => new Set(models.map((m) => m.id)).size === models.length,
    'Model IDs must be unique',
  );

export interface ApiModelDiscovery {
  models: { id: string; label: string }[];
  partial: boolean;
}
export class ApiAccountSetupError extends Error {
  constructor(
    readonly code: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'ApiAccountSetupError';
  }
}
/** Metadata only. Reuse the credential transport's checked DNS, TLS, size bound
 * and refusal to forward credentials across redirects. Catalogs are advisory:
 * exact working models may be pinned even when omitted from discovery.
 */
export async function discoverApiAccountModels(
  endpoint: string,
  key: string,
  callerSignal: AbortSignal,
  send?: ConnectionSender,
  options: ApiDiscoveryOptions = {},
): Promise<ApiModelDiscovery> {
  const selected = ApiProviderEndpointSchema.parse(endpoint);
  if (!key.trim() || key.length > 16384)
    throw new ApiAccountSetupError('INVALID_KEY', 'Enter a complete API key.');
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(15000)]);
  signal.throwIfAborted();
  try {
    const result = await sendConnectionRequest(
      {
        url: new URL(selected + (options.protocol === 'messages' ? '/v1/models' : '/models')),
        method: 'GET',
        headers:
          options.protocol === 'messages' && options.authentication !== 'bearer'
            ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
            : {
                Authorization: `Bearer ${key}`,
                ...(options.protocol === 'messages' ? { 'anthropic-version': '2023-06-01' } : {}),
              },
        allowPrivateNetwork: false,
      },
      signal,
      send,
    );
    if (result.status < 200 || result.status >= 300) {
      const reason =
        result.status === 401
          ? 'credential_rejected'
          : result.status === 403
            ? 'access_denied'
            : 'unexpected_response';
      throw new CredentialVerificationError(reason);
    }
    const catalog = z.object({
      data: z
        .array(
          z.object({
            id: z.string().min(1).max(256),
            name: z.string().max(256).optional(),
            display_name: z.string().max(256).optional(),
          }),
        )
        .max(2000),
      has_more: z.boolean().optional(),
      next_cursor: z.string().nullable().optional(),
    });
    let value: unknown;
    try {
      value = JSON.parse(result.body);
    } catch (cause) {
      throw new ApiAccountSetupError(
        'unexpected_response',
        new CredentialVerificationError('unexpected_response').message,
        cause,
      );
    }
    const checked = catalog.safeParse(value);
    if (!checked.success) throw new CredentialVerificationError('unexpected_response');
    const parsed = checked.data;
    const models = [
      ...new Map(
        parsed.data.map((model) => {
          const label = model.display_name || model.name || model.id;
          if (model.id.includes(key) || label.includes(key) || /\s/.test(model.id))
            throw new CredentialVerificationError('unexpected_response');
          return [model.id, { id: model.id, label }];
        }),
      ).values(),
    ];
    return { models, partial: parsed.has_more === true || !!parsed.next_cursor };
  } catch (cause) {
    if (cause instanceof ApiAccountSetupError) throw cause;
    const safe =
      cause instanceof CredentialVerificationError
        ? cause
        : verificationTransportError(cause, signal);
    throw new ApiAccountSetupError(safe.code, safe.message, cause);
  }
}
