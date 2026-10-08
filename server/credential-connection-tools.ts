import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { buildPermissionHandler, ToolDefinition } from '@mitzo/harness';
import {
  CredentialConnections,
  ConnectionRequestSchema,
  requestTarget,
} from './credential-connections.js';

const id = z.string().min(1).max(128);
export const credentialConnectionSchemas = {
  ListConnections: z.object({}).strict(),
  RequestConnectionAccess: z.object({ connectionId: id }).strict(),
  ConnectionRequest: ConnectionRequestSchema.extend({ connectionId: id }).strict(),
};
const descriptions = {
  ListConnections:
    'Discover configured service connections, approved destinations, request permissions, and access for this session. Never returns credentials. Use this before searching workspace files for passwords or tokens. If the needed service is missing, direct the user to Connections.',
  RequestConnectionAccess:
    'Request explicit approval to use one connection in this session. Approval persists across reconnects of this session only. The credential remains in Apple Keychain.',
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
        title: `Allow ${c.label} in this session?`,
        description: `${c.endpoint} · ${c.methods.join(', ')} · ${c.paths.join(', ')}. Access lasts for this session, including reconnects, until revoked. Other sessions require separate approval.`,
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
        if (!stillAllowed(name, typeof input.method === 'string' ? input.method : 'GET'))
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
        if (!stillAllowed(name, request?.method))
          return {
            content: 'Connection tool is unavailable under current session permissions',
            isError: true,
          };
        if (access.isError || !request) return access;
        const response = await service.request(sessionId, connectionId, request, signal, () =>
          stillAllowed(name, request.method),
        );
        return { content: JSON.stringify(response), isError: false };
      } catch (error) {
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
