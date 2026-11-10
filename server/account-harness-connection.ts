import { z } from 'zod';
import { isIP } from 'node:net';

export const OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1';

/** Operator evidence is a prerequisite, never a claim that saving configuration ran qualification. */
const Qualification = z
  .object({
    source: z.literal('operator'),
    streaming: z.boolean().optional(),
    /** Includes tool-call/result pairing across turns. */
    toolCalls: z.boolean().optional(),
    continuation: z.boolean().optional(),
    cancellation: z.boolean().optional(),
  })
  .strict();

export const ApiHarnessConnectionSchema = z
  .object({
    endpoint: z
      .string()
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === 'https:' &&
            !!url.hostname &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            !value.includes('?') &&
            !value.includes('#')
          );
        } catch {
          return false;
        }
      }, 'Endpoint must be an HTTPS URL without credentials, query or fragment')
      .transform((value) => new URL(value).toString().replace(/\/+$/, ''))
      // URL serialization expands Unicode. Accepted output must pass the same
      // bound when parsed again by the service, journal or account profile.
      .pipe(z.string().max(2048)),
    protocol: z.enum(['responses', 'chat-completions', 'messages']),
    qualification: Qualification.optional(),
  })
  .strict();

export type ApiHarnessConnection = z.infer<typeof ApiHarnessConnectionSchema>;
export const PublicApiEndpointSchema = ApiHarnessConnectionSchema.shape.endpoint.refine((value) => {
  const host = new URL(value).hostname.toLowerCase().replace(/\.+$/, '');
  return (
    !!host &&
    !isIP(host.replace(/^\[|\]$/g, '')) &&
    host !== 'localhost' &&
    !host.endsWith('.localhost')
  );
}, 'Use a public HTTPS provider hostname');
const officialCapabilities = {
  streaming: true,
  toolCalls: true,
  continuation: true,
  cancellation: true,
} as const;
export function qualifiedApiCapabilities(connection: ApiHarnessConnection, protocol: string) {
  if (!connection.qualification)
    throw Error(`${protocol} endpoint requires explicit operator qualification`);
  const { source, ...capabilities } = connection.qualification;
  for (const capability of Object.keys(
    officialCapabilities,
  ) as (keyof typeof officialCapabilities)[])
    if (capabilities[capability] !== true)
      throw Error(`${protocol} endpoint lacks qualified ${capability} capability`);
  return { qualification: source, capabilities: { ...officialCapabilities } };
}

/** Credential-free, target-independent supported Codex connection. */
export function apiHarnessConnection(connection?: ApiHarnessConnection) {
  if (!connection)
    return {
      harness: 'codex' as const,
      authentication: 'api-key' as const,
      endpoint: OPENAI_RESPONSES_ENDPOINT,
      protocol: 'responses' as const,
      qualification: 'official' as const,
      capabilities: { ...officialCapabilities },
    };
  if (connection.protocol !== 'responses')
    throw Error('Codex requires the Responses protocol; no legacy fallback is supported');
  return {
    harness: 'codex' as const,
    authentication: 'api-key' as const,
    endpoint: connection.endpoint,
    protocol: 'responses' as const,
    ...qualifiedApiCapabilities(connection, 'Responses'),
  };
}

export function subscriptionHarnessConnection() {
  return {
    harness: 'codex' as const,
    authentication: 'chatgpt-subscription' as const,
    protocol: 'responses' as const,
    qualification: 'official' as const,
    capabilities: { ...officialCapabilities },
  };
}

export type ApiHarnessProjection = ReturnType<typeof apiHarnessConnection>;
