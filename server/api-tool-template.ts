import { createHash } from 'node:crypto';
import { z } from 'zod';
import { reviewedHandlerSourceArtifacts } from './connections/reviewed-handler-artifacts.js';
import type { ToolDefinition } from '@mitzo/harness';
import { requestTarget, type CredentialConnections } from './credential-connections.js';

/** Code-owned adapter. No executable expressions, URLs, methods or schemas from the caller. */
export const apiToolConfigurationSchema = z.strictObject({
  template: z.literal('home-assistant.state@1'),
  label: z.string().trim().min(1).max(100),
  connectionId: z.string().min(1).max(128),
  entityId: z
    .string()
    .max(128)
    .regex(/^[a-z][a-z0-9_]*\.[a-z0-9_]+$/),
});
export type ApiToolConfiguration = z.infer<typeof apiToolConfigurationSchema>;
export const apiToolInputSchema = z.strictObject({});
export const apiToolTemplate = Object.freeze({
  id: 'home-assistant.state@1',
  label: 'Home Assistant entity state',
  description: 'Read the current state of one configured Home Assistant entity.',
  method: 'GET',
  path: '/api/states/{entityId}',
  source: 'server/api-tool-template.ts',
  implementation: 'home-assistant-state-v1',
  documentation: 'https://developers.home-assistant.io/docs/api/rest/#get-apistatesentity_id',
  output: ['entity_id', 'state', 'last_changed'],
});
export function apiToolRequest(config: ApiToolConfiguration) {
  return { method: 'GET' as const, path: `/api/states/${config.entityId}` };
}
export function apiToolBinding(config: ApiToolConfiguration, service: CredentialConnections) {
  const c = service.connection(config.connectionId);
  if (c.serviceTemplate !== 'home-assistant' || !c.methods.includes('GET'))
    throw Error('An active Home Assistant connection with GET access is required');
  requestTarget(c, apiToolRequest(config).path);
  // Exclude verification time and presentation; bind every authority/transport input privately.
  const authority = {
    id: c.id,
    revision: c.revision,
    status: c.status,
    serviceTemplate: c.serviceTemplate,
    endpoint: c.endpoint,
    auth: c.auth,
    paths: c.paths,
    methods: c.methods,
    allowPrivateNetwork: c.allowPrivateNetwork,
    credentialRef: c.credentialRef,
    homeAssistantDashboards: c.homeAssistantDashboards,
    websocket: c.websocket,
  };
  return createHash('sha256')
    .update(
      JSON.stringify({
        authority,
        template: apiToolTemplate,
        implementation: reviewedHandlerSourceArtifacts['../api-tool-template.ts'],
      }),
    )
    .digest('hex');
}
export function apiToolDefinition(id: string, config: ApiToolConfiguration): ToolDefinition {
  return {
    name: `api_${id.replaceAll('-', '')}`,
    description: `${config.label}: ${apiToolTemplate.description} Requires current connection approval.`,
    input_schema: z.toJSONSchema(apiToolInputSchema),
  };
}
export function mapApiToolOutput(
  config: ApiToolConfiguration,
  response: { status: number; body: string },
) {
  if (response.status !== 200 || response.body.length > 1024 * 1024)
    throw Error('API tool verification failed');
  const parsed = z
    .object({
      entity_id: z.literal(config.entityId),
      state: z.string().max(4096),
      last_changed: z.iso.datetime({ offset: true }),
    })
    .parse(JSON.parse(response.body));
  return parsed;
}
