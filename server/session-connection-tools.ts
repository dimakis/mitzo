import {
  buildPermissionHandler,
  checkSkillPolicy,
  effectivePermissionMode,
  type ManagedSession,
  type SessionRegistry,
} from '@mitzo/harness';
import { agentToolAllowed, filterAgentTools } from './agent-tool-selection.js';
import {
  createCredentialConnectionTools,
  credentialConnectionSchemas,
  credentialConnectionToolDefinitions,
  type ConnectionAccessPending,
} from './credential-connection-tools.js';
import { getCredentialConnectionsRuntime } from './credential-connections-runtime.js';
import { connectionGuide } from './connection-guide.js';

export interface SessionConnectionOptions {
  sessionId: string;
  session: ManagedSession;
  registry: SessionRegistry;
  toolPrefix?: string;
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
  };
  assertRuntimeCurrent?: () => Promise<void>;
  assertRuntimeCurrentSync?: () => void;
  enableOwnedFrames?: boolean;
  pendingAccess?: ConnectionAccessPending;
}
export const CONNECTION_ACCESS_INSTRUCTIONS =
  '\nListConnections first. Use attached/approved access directly; request access otherwise. GetConnectionGuide covers setup/use. Enter credentials only in secure setup cards.\n';

/** One service adapter shared by SDK, legacy host and owned-native callers. */
export function sessionConnectionTools(options: SessionConnectionOptions) {
  const {
    sessionId,
    session,
    registry,
    toolPrefix = '',
    integrations,
    assertRuntimeCurrent,
    assertRuntimeCurrentSync,
    enableOwnedFrames = false,
    pendingAccess,
  } = options;
  // Framed adapters require the qualified per-frame owner fence on this route.
  const credentialDefinitions = credentialConnectionToolDefinitions.filter(
    ({ name }) =>
      !assertRuntimeCurrent ||
      enableOwnedFrames ||
      (name !== 'ConnectionWebSocket' && name !== 'HomeAssistantDashboard'),
  );
  const currentService = getCredentialConnectionsRuntime();
  const owner = () => registry.findBySessionId(sessionId);
  const stillAllowed = (name: string, method?: string) => {
    assertRuntimeCurrentSync?.();
    const current = owner();
    return (
      agentToolAllowed(session, name) &&
      !!current &&
      current.session === session &&
      !session.abortController.signal.aborted &&
      checkSkillPolicy(registry, current.clientId, toolPrefix + name) !== 'deny' &&
      !(
        (name === 'ConnectionRequest' ||
          name === 'HomeAssistantDashboard' ||
          name === 'ConnectionWebSocket' ||
          name === 'ApplySecretRelay') &&
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
        async (name, input, opts) => {
          await assertRuntimeCurrent?.();
          const current = owner();
          if (!current || !credentialAllowed(name))
            return Promise.resolve({
              behavior: 'deny',
              message: 'Session unavailable',
            });
          const decision = await buildPermissionHandler(current.clientId, registry)(
            toolPrefix + name,
            input,
            opts,
          );
          await assertRuntimeCurrent?.();
          return decision;
        },
        credentialAllowed,
        assertRuntimeCurrent,
        pendingAccess,
      )
    : undefined;
  return {
    definitions: filterAgentTools(session, credentialDefinitions),
    handles: (name: string) => Object.hasOwn(credentialConnectionSchemas, name),
    async execute(name: string, input: Record<string, unknown>, signal: AbortSignal) {
      if (!Object.hasOwn(credentialConnectionSchemas, name)) return undefined;
      await assertRuntimeCurrent?.();
      if (
        assertRuntimeCurrent &&
        !enableOwnedFrames &&
        (name === 'ConnectionWebSocket' || name === 'HomeAssistantDashboard')
      )
        return unavailable();
      if (
        assertRuntimeCurrent &&
        (name === 'PrepareSecretRelay' || name === 'PrepareConnectionSetup') &&
        !session.ordinaryRuntimeOwner?.notifyCredentialSetup
      )
        return {
          content:
            'Private setup continuation is unavailable for this runtime. Use a supported originating chat before entering credentials.',
          isError: true,
        };
      if (!agentToolAllowed(session, name))
        return {
          content: 'Tool is not selected by this session’s published agent profile',
          isError: true,
        };
      if (signal.aborted || !stillAllowed(name)) return unavailable();
      const combined = AbortSignal.any([signal, session.abortController.signal]);
      const parsed =
        credentialConnectionSchemas[name as keyof typeof credentialConnectionSchemas].safeParse(
          input,
        );
      if (!parsed.success) return { content: 'Invalid connection tool input', isError: true };
      const method =
        name === 'ConnectionWebSocket' || name === 'ApplySecretRelay'
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
              filterAgentTools(session, credentialDefinitions),
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
                'This connection uses its OpenShell provider client, not ConnectionRequest. If ListConnections reports attached access, use that client directly in the sandbox; otherwise request session access first.',
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
