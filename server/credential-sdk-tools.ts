import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import {
  checkSkillPolicy,
  effectivePermissionMode,
  type ManagedSession,
  type SessionRegistry,
} from '@mitzo/harness';
import {
  credentialConnectionSchemas,
  credentialConnectionToolDefinitions,
} from './credential-connection-tools.js';
import { sessionCredentialTools } from './session-credential-tools.js';

const prefix = 'mcp__mitzo-connections__';
/** Only this server's validated handlers bypass the SDK's generic MCP prompt; connection grants still force their own card. */
export function credentialSdkPermission(
  name: string,
  input: Record<string, unknown>,
  clientId: string,
  registry: SessionRegistry,
  session: ManagedSession,
) {
  if (!name.startsWith(prefix)) return undefined;
  const short = name.slice(prefix.length) as keyof typeof credentialConnectionSchemas;
  if (
    !Object.hasOwn(credentialConnectionSchemas, short) ||
    !credentialConnectionSchemas[short].safeParse(input).success ||
    registry.get(clientId) !== session ||
    session.abortController.signal.aborted ||
    checkSkillPolicy(registry, clientId, name) === 'deny'
  )
    return {
      behavior: 'deny' as const,
      message: 'Connection tool is unavailable under current session permissions',
    };
  if (
    short === 'ConnectionRequest' &&
    effectivePermissionMode(session) === 'ask' &&
    input.method !== undefined &&
    !['GET', 'HEAD'].includes(String(input.method))
  )
    return { behavior: 'deny' as const, message: 'Ask mode only permits connection reads' };
  return { behavior: 'allow' as const, updatedInput: input };
}
export function createCredentialSdkServer(
  sessionId: () => string | undefined,
  session: ManagedSession,
  registry: SessionRegistry,
) {
  let current: { id: string; tools: ReturnType<typeof sessionCredentialTools> } | undefined;
  return createSdkMcpServer({
    name: 'mitzo-connections',
    version: '1.0.0',
    tools: credentialConnectionToolDefinitions.map((definition) =>
      tool(
        definition.name,
        definition.description,
        credentialConnectionSchemas[definition.name as keyof typeof credentialConnectionSchemas]
          .shape,
        async (input, extra) => {
          const id = sessionId();
          if (!id)
            return {
              content: [{ type: 'text', text: 'Session is not ready; retry shortly' }],
              isError: true,
            };
          if (current?.id !== id)
            current = { id, tools: sessionCredentialTools(id, session, registry, prefix) };
          const callSignal =
            extra !== null &&
            typeof extra === 'object' &&
            'signal' in extra &&
            extra.signal instanceof AbortSignal
              ? extra.signal
              : undefined;
          const signal = callSignal
            ? AbortSignal.any([session.abortController.signal, callSignal])
            : session.abortController.signal;
          const result = await current.tools.execute(definition.name, input, signal);
          return {
            content: [{ type: 'text', text: result?.content ?? 'Connection tool unavailable' }],
            isError: result?.isError ?? true,
          };
        },
      ),
    ),
  });
}
