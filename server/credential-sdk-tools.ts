import { randomUUID } from 'node:crypto';
import type { TurnCallbackRunner } from './turn-callbacks.js';
import { knowledgeToolSchemas, knowledgeToolDefinitions } from './session-knowledge-tools.js';
import { profileToolSchemas, profileToolDefinitions } from './session-profile-tools.js';
import { repositoryChatSchemas, repositoryChatToolDefinitions } from './repository-chat-tools.js';
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
const schemas = {
  ...credentialConnectionSchemas,
  ...repositoryChatSchemas,
  ...profileToolSchemas,
  ...knowledgeToolSchemas,
};
const definitions = [
  ...credentialConnectionToolDefinitions,
  ...repositoryChatToolDefinitions,
  ...profileToolDefinitions,
  ...knowledgeToolDefinitions,
];
/** Only this server's validated handlers bypass the SDK's generic MCP prompt; connection grants still force their own card. */
export function credentialSdkPermission(
  name: string,
  input: Record<string, unknown>,
  clientId: string,
  registry: SessionRegistry,
  session: ManagedSession,
) {
  if (!name.startsWith(prefix)) return undefined;
  const short = name.slice(prefix.length) as keyof typeof schemas;
  if (
    !Object.hasOwn(schemas, short) ||
    !schemas[short].safeParse(input).success ||
    registry.get(clientId) !== session ||
    session.abortController.signal.aborted ||
    checkSkillPolicy(registry, clientId, name) === 'deny'
  )
    return {
      behavior: 'deny' as const,
      message: 'Connection tool is unavailable under current session permissions',
    };
  if (
    effectivePermissionMode(session) === 'ask' &&
    ((short === 'ConnectionRequest' &&
      input.method !== undefined &&
      !['GET', 'HEAD'].includes(String(input.method))) ||
      (short === 'HomeAssistantDashboard' && input.operation === 'save') ||
      short === 'ConnectionWebSocket' ||
      short === 'ApplySecretRelay' ||
      short === 'PrepareRepositoryChat' ||
      short === 'SaveKnowledgeDraft')
  )
    return { behavior: 'deny' as const, message: 'Ask mode only permits connection reads' };
  return { behavior: 'allow' as const, updatedInput: input };
}
export function createCredentialSdkServer(
  sessionId: () => string | undefined,
  session: ManagedSession,
  registry: SessionRegistry,
  boundary?: {
    profilesOnly: true;
    assertCurrent(signal: AbortSignal): Promise<void>;
    assertCurrentSync(signal: AbortSignal): void;
    runCallback?: TurnCallbackRunner;
  },
) {
  const runtimeId = randomUUID();
  let current: { id: string; tools: ReturnType<typeof sessionCredentialTools> } | undefined;
  return createSdkMcpServer({
    name: 'mitzo-connections',
    version: '1.0.0',
    tools: (boundary?.profilesOnly ? profileToolDefinitions : definitions).map((definition) =>
      tool(
        definition.name,
        definition.description,
        schemas[definition.name as keyof typeof schemas].shape,
        async (input, extra) =>
          (boundary?.runCallback ?? ((work) => work()))(async () => {
            const id = sessionId();
            if (!id)
              return {
                content: [{ type: 'text', text: 'Session is not ready; retry shortly' }],
                isError: true,
              };
            if (current?.id !== id)
              current = {
                id,
                tools: sessionCredentialTools(
                  id,
                  session,
                  registry,
                  prefix,
                  undefined,
                  boundary
                    ? () => boundary.assertCurrent(session.abortController.signal)
                    : undefined,
                  boundary
                    ? () => boundary.assertCurrentSync(session.abortController.signal)
                    : undefined,
                ),
              };
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
            await boundary?.assertCurrent(signal);
            const result = await current.tools.execute(definition.name, input, signal, {
              turnId: runtimeId,
              callId: String(
                (extra as { requestId?: unknown } | undefined)?.requestId ?? randomUUID(),
              ),
            });
            await boundary?.assertCurrent(signal);
            return {
              content: [{ type: 'text', text: result?.content ?? 'Connection tool unavailable' }],
              isError: result?.isError ?? true,
            };
          }),
      ),
    ),
  });
}
