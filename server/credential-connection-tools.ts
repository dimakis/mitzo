import { WebSocketRequestSchema, ConnectionWebSocketError } from './credential-websocket.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { PrepareConnectionSetupSchema } from './credential-setup.js';
import { connectionGuide } from './connection-guide.js';
import {
  DashboardRequestSchema,
  validateDashboardRequest,
  DashboardRequestError,
} from './home-assistant-dashboard.js';
import type { buildPermissionHandler, ToolDefinition } from '@mitzo/harness';
import {
  CredentialConnections,
  ConnectionRequestSchema,
  requestTarget,
  dashboardRequestTarget,
  websocketRequestTarget,
} from './credential-connections.js';

const id = z.string().min(1).max(128);
export const credentialConnectionSchemas = {
  ListConnections: z.object({}).strict(),
  RequestConnectionAccess: z.object({ connectionId: id }).strict(),
  ConnectionRequest: ConnectionRequestSchema.extend({ connectionId: id }).strict(),
  ConnectionWebSocket: WebSocketRequestSchema.extend({ connectionId: id }).strict(),
  HomeAssistantDashboard: DashboardRequestSchema.extend({ connectionId: id }).strict(),
  GetConnectionGuide: z
    .object({ topic: z.enum(['connect', 'use', 'troubleshoot']).default('connect') })
    .strict(),
  PrepareConnectionSetup: PrepareConnectionSetupSchema,
  GetConnectionSetup: z.object({ setupId: id }).strict(),
};
const descriptions = {
  ListConnections:
    'Discover configured service connections and access for this chat. Never returns credentials. If the needed service is missing, use GetConnectionGuide and PrepareConnectionSetup to help the user connect it within this task.',
  GetConnectionGuide:
    'Load current Mitzo instructions for connecting services, using approved connections, or troubleshooting. Use when service setup is needed; keeps detailed guidance out of the initial context. Returns no credentials.',
  PrepareConnectionSetup:
    'Prepare a service connection for this chat without credentials. For Home Assistant provide its HTTPS origin and intended read or read-write access; Mitzo configures authentication and transport. For custom services provide authentication and request scope established from official documentation, with evidenceUrl. Returns a secure setup card/link where the user enters only their credential. Never put keys, passwords, or tokens in chat or tool input. Setup does not grant session access or execute the original task.',
  GetConnectionSetup:
    'Read progress for a setup prepared by this chat. Returns non-secret pending, verifying, ready, cancelled, or expired status and connectionId when ready. Use once when checking secure completion; do not repeatedly poll. Continue the original task after readiness, request session access, and avoid repeating completed actions.',
  RequestConnectionAccess:
    'Request explicit approval to use one connection in this session. Approval persists across reconnects of this session only. The credential remains in Apple Keychain.',
  ConnectionWebSocket:
    'Send one bounded command through an approved service WebSocket. Mitzo injects authentication privately; never supply credentials, destination URLs, or authentication frames. Treated as a write and never replayed. An unconfirmed command may have applied; inspect state before retrying. Load GetConnectionGuide for usage details.',
  HomeAssistantDashboard:
    'Read, list, or update Home Assistant dashboards using private authentication. Read before saving and supply returned configHash as expectedConfigHash. Never save redacted reads. Mitzo checks concurrent changes and verifies saves; after an unconfirmed save, read again before retrying. Load GetConnectionGuide for usage details.',
  ConnectionRequest:
    'Make an authenticated HTTPS request through a configured connection after session approval. Supply only a relative path within its permissions. Use for Home Assistant and other configured APIs. Authentication is injected by Mitzo; do not ask for or supply a password or token.',
};
export const credentialConnectionToolDefinitions: ToolDefinition[] = Object.entries(
  credentialConnectionSchemas,
).map(([name, schema]) => ({
  name,
  description: descriptions[name as keyof typeof credentialConnectionSchemas],
  input_schema: z.toJSONSchema(schema),
}));
type Approve = ReturnType<typeof buildPermissionHandler>;
export function createCredentialConnectionTools(
  service: CredentialConnections,
  sessionId: string,
  approve: Approve,
  stillAllowed: (tool: string, method?: string) => boolean,
) {
  const pending = new Map<string, Promise<{ content: string; isError: boolean }>>();
  const requestAccess = async (connectionId: string, signal: AbortSignal) => {
    if (!stillAllowed('RequestConnectionAccess'))
      return {
        content: 'Connection access is unavailable under current session permissions',
        isError: true,
      };
    const c = service.connection(connectionId);
    if (
      service
        .catalog(sessionId)
        .some((item) => item.id === connectionId && item.access === 'approved')
    )
      return { content: 'Connection is approved for this session', isError: false };
    const input = { connectionId, revision: c.revision };
    const decision = await approve(
      'RequestConnectionAccess',
      { ...input },
      {
        signal,
        toolUseID: randomUUID(),
        forcePrompt: true,
        approvalScope: 'conversation',
        title: `Allow ${c.label} in this chat?`,
        description: `${c.methods.some((method) => !['GET', 'HEAD'].includes(method)) || c.websocket || c.homeAssistantDashboards === 'read-write' ? 'Read and make changes' : 'Read information'} at ${c.endpoint}. Your key stays private. Access lasts only for this chat until you revoke it. Other chats ask separately.`,
      },
    );
    signal.throwIfAborted();
    if (decision.behavior !== 'allow') return { content: decision.message, isError: true };
    if (
      !stillAllowed('RequestConnectionAccess') ||
      !isDeepStrictEqual(decision.updatedInput, input)
    )
      return { content: 'Connection approval changed; retry', isError: true };
    service.grant(sessionId, connectionId, input.revision);
    return { content: 'Connection is approved for this session', isError: false };
  };
  return {
    definitions: credentialConnectionToolDefinitions,
    async execute(
      name: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<{ content: string; isError: boolean } | undefined> {
      if (!Object.hasOwn(credentialConnectionSchemas, name)) return undefined;
      try {
        signal.throwIfAborted();
        if (
          !stillAllowed(
            name,
            name === 'ConnectionWebSocket'
              ? 'POST'
              : name === 'HomeAssistantDashboard'
                ? input.operation === 'save'
                  ? 'POST'
                  : 'GET'
                : typeof input.method === 'string'
                  ? input.method
                  : 'GET',
          )
        )
          return {
            content: 'Connection tool is unavailable under current session permissions',
            isError: true,
          };
        const parsed =
          credentialConnectionSchemas[name as keyof typeof credentialConnectionSchemas].safeParse(
            input,
          );
        if (!parsed.success) return { content: 'Invalid connection tool input', isError: true };
        if (name === 'ListConnections')
          return {
            content: JSON.stringify({ connections: service.catalog(sessionId) }),
            isError: false,
          };
        if (name === 'GetConnectionGuide')
          return {
            content: JSON.stringify(
              connectionGuide(
                credentialConnectionSchemas.GetConnectionGuide.parse(input).topic,
                credentialConnectionToolDefinitions,
              ),
            ),
            isError: false,
          };
        if (name === 'PrepareConnectionSetup')
          return {
            content: JSON.stringify({ setup: service.setups.prepare(sessionId, parsed.data) }),
            isError: false,
          };
        if (name === 'GetConnectionSetup')
          return {
            content: JSON.stringify({
              setup: service.setups.status(
                sessionId,
                credentialConnectionSchemas.GetConnectionSetup.parse(input).setupId,
              ),
            }),
            isError: false,
          };
        if (!('connectionId' in parsed.data))
          return { content: 'Invalid connection tool input', isError: true };
        const connectionId = parsed.data.connectionId;
        const request =
          name === 'ConnectionRequest'
            ? ConnectionRequestSchema.parse({
                path: input.path,
                method: input.method,
                ...(input.body === undefined ? {} : { body: input.body }),
              })
            : undefined;
        const dashboard =
          name === 'HomeAssistantDashboard'
            ? validateDashboardRequest({
                operation: input.operation,
                ...(input.urlPath === undefined ? {} : { urlPath: input.urlPath }),
                ...(input.config === undefined ? {} : { config: input.config }),
                ...(input.expectedConfigHash === undefined
                  ? {}
                  : { expectedConfigHash: input.expectedConfigHash }),
              })
            : undefined;
        const websocket =
          name === 'ConnectionWebSocket'
            ? WebSocketRequestSchema.parse({
                message: input.message,
                ...(input.responseMatch === undefined
                  ? {}
                  : { responseMatch: input.responseMatch }),
              })
            : undefined;
        if (websocket) websocketRequestTarget(service.connection(connectionId));
        if (dashboard)
          dashboardRequestTarget(service.connection(connectionId), dashboard.operation);
        if (request) {
          const connection = service.connection(connectionId);
          requestTarget(connection, request.path);
          if (
            !connection.methods.includes(request.method) ||
            (['GET', 'HEAD'].includes(request.method) && request.body !== undefined)
          )
            return { content: 'Request is outside configured connection access', isError: true };
        }
        // Coalesce simultaneous approval requests without allowing another session to join them.
        let approval = pending.get(connectionId);
        if (!approval) {
          approval = requestAccess(connectionId, signal);
          pending.set(connectionId, approval);
        }
        let access;
        try {
          access = await approval;
        } finally {
          if (pending.get(connectionId) === approval) pending.delete(connectionId);
        }
        signal.throwIfAborted();
        const method = websocket
          ? 'POST'
          : dashboard
            ? dashboard.operation === 'save'
              ? 'POST'
              : 'GET'
            : request?.method;
        if (!stillAllowed(name, method))
          return {
            content: 'Connection tool is unavailable under current session permissions',
            isError: true,
          };
        if (access.isError || (!request && !dashboard && !websocket)) return access;
        if (websocket) {
          const content = await service.websocketRequest(
            sessionId,
            connectionId,
            websocket,
            signal,
            () => stillAllowed(name, 'POST'),
          );
          return { content, isError: false };
        }
        if (dashboard) {
          const content = await service.dashboardRequest(
            sessionId,
            connectionId,
            dashboard,
            signal,
            () => stillAllowed(name, method),
          );
          return { content, isError: false };
        }
        const response = await service.request(sessionId, connectionId, request!, signal, () =>
          stillAllowed(name, request!.method),
        );
        return { content: JSON.stringify(response), isError: false };
      } catch (error) {
        if (error instanceof ConnectionWebSocketError)
          return {
            content: error.mayHaveApplied
              ? 'WebSocket command is unconfirmed and may have applied. Verify service state before retrying; do not automatically repeat it.'
              : 'WebSocket request failed before sending the command. Check connection authentication and service availability.',
            isError: true,
          };
        if (error instanceof DashboardRequestError)
          return {
            content:
              error.code === 'DASHBOARD_CHANGED'
                ? 'Dashboard changed since the last read. Read it again and apply your edits to the new configuration.'
                : error.code === 'DASHBOARD_SAVE_UNCONFIRMED'
                  ? 'Dashboard save is unconfirmed and may have applied. Read the dashboard to verify; do not automatically repeat the save.'
                  : error.code === 'DASHBOARD_REDACTED'
                    ? 'This dashboard contains a protected credential and cannot be saved through this connection.'
                    : 'Dashboard WebSocket request failed. Check the HA account permissions and connection.',
            isError: true,
          };
        return {
          content: signal.aborted
            ? 'Connection request cancelled'
            : error instanceof Error && error.name === 'KeychainUnavailableError'
              ? error.message
              : 'Connection access failed. Check Connections and retry.',
          isError: true,
        };
      }
    },
  };
}
