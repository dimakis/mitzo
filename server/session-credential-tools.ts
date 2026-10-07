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

export const CONNECTION_TOOL_INSTRUCTIONS =
  '\nFor authenticated service access, first call ListConnections to discover configured connections and their permissions, then RequestConnectionAccess if needed and ConnectionRequest. Mitzo asks for approval scoped to this session and injects credentials privately. Never search workspace files for tokens or request passwords in chat. If a connection is missing, direct the user to Connections. HTTP reachability alone is not proof of authenticated access.\n';
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
        name === 'ConnectionRequest' &&
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
  const tools = currentService
    ? createCredentialConnectionTools(
        currentService,
        sessionId,
        (name, input, opts) => {
          const current = owner();
          if (!current || !stillAllowed(name))
            return Promise.resolve({ behavior: 'deny', message: 'Session unavailable' });
          return buildPermissionHandler(current.clientId, registry)(toolPrefix + name, input, opts);
        },
        stillAllowed,
      )
    : undefined;
  return {
    definitions: credentialConnectionToolDefinitions,
    async execute(name: string, input: Record<string, unknown>, signal: AbortSignal) {
      if (!credentialConnectionToolDefinitions.some((t) => t.name === name)) return undefined;
      if (signal.aborted || !stillAllowed(name)) return unavailable();
      const combined = AbortSignal.any([signal, session.abortController.signal]);
      const parsed =
        credentialConnectionSchemas[name as keyof typeof credentialConnectionSchemas].safeParse(
          input,
        );
      if (!parsed.success) return { content: 'Invalid connection tool input', isError: true };
      const method = 'method' in parsed.data ? parsed.data.method : undefined;
      if (!stillAllowed(name, method)) return unavailable();
      if (name === 'ListConnections')
        return {
          content: JSON.stringify({
            connections: [
              ...(currentService
                ?.catalog(sessionId)
                .map((c) => ({ ...c, transport: 'keychain-https' })) ?? []),
              ...(integrations?.providers() ?? []),
            ],
            keychainConfigured: !!currentService,
          }),
          isError: false,
        };
      if ('connectionId' in parsed.data) {
        const provider = integrations?.providers().find((p) => p.id === parsed.data.connectionId);
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
      return tools.execute(name, input, combined);
    },
  };
}
