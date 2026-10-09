import { sessionRepositoryTools, REPOSITORY_CHAT_INSTRUCTIONS } from './repository-chat-tools.js';
import {
  buildPermissionHandler,
  checkSkillPolicy,
  effectivePermissionMode,
  type ManagedSession,
  type SessionRegistry,
} from '@mitzo/harness';
import {
  createCredentialConnectionTools,
  credentialConnectionSchemas,
  credentialConnectionToolDefinitions,
} from './credential-connection-tools.js';
import { getCredentialConnectionsRuntime } from './credential-connections-runtime.js';
import { connectionGuide } from './connection-guide.js';

export const CONNECTION_TOOL_INSTRUCTIONS =
  '\nFor authenticated services, call ListConnections first. If setup or usage guidance is needed, call GetConnectionGuide. Prepare missing connections within this chat; the user enters only their credential through the secure setup card. Never ask for secrets in chat or search files for them. Request session access before use.\n' +
  REPOSITORY_CHAT_INSTRUCTIONS;
export function sessionCredentialTools(
  sessionId: string,
  session: ManagedSession,
  registry: SessionRegistry,
  toolPrefix = '',
  integrations?: {
    providers: () => Array<{
      id: string;
      label: string;
      endpoint?: string;
      provider: string;
      transport: string;
      access: string;
    }>;
    request: (
      provider: string,
      signal: AbortSignal,
    ) => Promise<{ content: string; isError: boolean }>;
  },
) {
  const repositoryTools = sessionRepositoryTools(sessionId, session, registry, toolPrefix);
  const currentService = getCredentialConnectionsRuntime();
  const owner = () => registry.findBySessionId(sessionId);
  const stillAllowed = (name: string, method?: string) => {
    const current = owner();
    return (
      !!current &&
      current.session === session &&
      !session.abortController.signal.aborted &&
      checkSkillPolicy(registry, current.clientId, toolPrefix + name) !== 'deny' &&
      !(
        (name === 'ConnectionRequest' ||
          name === 'HomeAssistantDashboard' ||
          name === 'ConnectionWebSocket') &&
        effectivePermissionMode(session) === 'ask' &&
        method &&
        !['GET', 'HEAD'].includes(method)
      )
    );
  };
  const unavailable = () => ({
    content: 'Connection tool is unavailable under current session permissions',
    isError: true,
  });
  const credentialAllowed = (name: string, method?: string) =>
    currentService === getCredentialConnectionsRuntime() && stillAllowed(name, method);
  const tools = currentService
    ? createCredentialConnectionTools(
        currentService,
        sessionId,
        (name, input, opts) => {
          const current = owner();
          if (!current || !credentialAllowed(name))
            return Promise.resolve({ behavior: 'deny', message: 'Session unavailable' });
          return buildPermissionHandler(current.clientId, registry)(toolPrefix + name, input, opts);
        },
        credentialAllowed,
      )
    : undefined;
  return {
    definitions: [...credentialConnectionToolDefinitions, ...repositoryTools.definitions],
    async execute(name: string, input: Record<string, unknown>, signal: AbortSignal) {
      const repositoryResult = await repositoryTools.execute(name, input, signal);
      if (repositoryResult) return repositoryResult;
      if (!credentialConnectionToolDefinitions.some((t) => t.name === name)) return undefined;
      if (signal.aborted || !stillAllowed(name)) return unavailable();
      const combined = AbortSignal.any([signal, session.abortController.signal]);
      const parsed =
        credentialConnectionSchemas[name as keyof typeof credentialConnectionSchemas].safeParse(
          input,
        );
      if (!parsed.success) return { content: 'Invalid connection tool input', isError: true };
      const method =
        name === 'ConnectionWebSocket'
          ? 'POST'
          : 'operation' in parsed.data
            ? parsed.data.operation === 'save'
              ? 'POST'
              : 'GET'
            : 'method' in parsed.data
              ? parsed.data.method
              : undefined;
      if (!stillAllowed(name, method)) return unavailable();
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
      if (name === 'ListConnections')
        return {
          content: JSON.stringify({
            connections: [
              ...(getCredentialConnectionsRuntime()
                ?.catalog(sessionId)
                .map((c) => ({ ...c, transport: 'keychain-https' })) ?? []),
              ...(integrations?.providers() ?? []),
            ],
            keychainConfigured: !!getCredentialConnectionsRuntime(),
          }),
          isError: false,
        };
      if ('connectionId' in parsed.data) {
        const connectionId = parsed.data.connectionId;
        const provider = integrations?.providers().find((p) => p.id === connectionId);
        if (provider) {
          if (name !== 'RequestConnectionAccess')
            return {
              content:
                'This connection uses its OpenShell provider client. Request session access, then use that client in the sandbox.',
              isError: true,
            };
          try {
            const result = await integrations!.request(provider.provider, combined);
            return combined.aborted || !stillAllowed(name) ? unavailable() : result;
          } catch {
            return {
              content: combined.aborted
                ? 'Connection request cancelled'
                : 'Connection access failed. Check Connections and retry.',
              isError: true,
            };
          }
        }
      }

      if (!tools)
        return {
          content: 'Apple Keychain connections are not configured. Open Connections for setup.',
          isError: true,
        };
      if (!credentialAllowed(name, method)) return unavailable();
      return tools.execute(name, input, combined);
    },
  };
}
