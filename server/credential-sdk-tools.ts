import { randomUUID } from 'node:crypto';
import { TelosCreateSessionInputSchema } from '@mitzo/protocol';
import { sessionLaunchTools } from './session-launch-tools.js';
import { telosSessionLaunchDefinition } from './telos-session-launch-tool.js';
import { learningToolSchemas, learningToolDefinitions } from './session-learning-tools.js';
import { qualifyToolResult, reportToolFailure } from './tool-failure-reporting.js';
import { findSessionRuntimeError, SessionRuntimeError } from './session-runtime-error.js';
import { sessionPromptSchemas, sessionPromptDefinitions } from './session-prompt-definitions.js';
import { copyCallbackOutcome, type TurnCallbackRunner } from './turn-callbacks.js';
import {
  AgentCommunicationSdkInput,
  agentCommunicationDefinitions,
  executeAgentCommunicationTool,
  type sessionAgentCommunicationTools,
} from './agent-communication-tools.js';
import type { ConnectionBoundary } from './session-connection-tools.js';
import { knowledgeToolSchemas, knowledgeToolDefinitions } from './session-knowledge-tools.js';
import { profileToolSchemas, profileToolDefinitions } from './session-profile-tools.js';
import { repositoryChatSchemas, repositoryChatToolDefinitions } from './repository-chat-tools.js';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import {
  checkSkillPolicy,
  effectivePermissionMode,
  runGuardedTool,
  ToolGuardTimeoutError,
  type ToolGuardPolicy,
  type ManagedSession,
  type SessionRegistry,
} from '@mitzo/harness';
import {
  credentialConnectionSchemas,
  credentialConnectionToolDefinitions,
} from './credential-connection-tools.js';
import { sessionCredentialTools } from './session-credential-tools.js';
import { agentToolAllowed, filterAgentTools } from './agent-tool-selection.js';

const prefix = 'mcp__mitzo-connections__';
/** Keep SDK auto-admission and the mandatory PreToolUse route fence aligned.
 * Every handler still enforces its profile, live authority and operation policy. */
export const ordinarySdkHelperTools: readonly string[] = Object.freeze(
  [
    'ListConnections',
    'SymposiumReadProfiles',
    'SymposiumProposeProfile',
    'AgentCommunication',
    'TelosCreateSession',
    'CaptureMemoryCandidate',
  ].map((name) => prefix + name),
);
/** A failed authority check cannot become a recoverable application failure. */
class SdkAuthorityFailure extends SessionRuntimeError {
  constructor(cause: unknown) {
    super('runtime_unavailable', { cause });
  }
}
const schemas = {
  TelosCreateSession: TelosCreateSessionInputSchema,
  AgentCommunication: AgentCommunicationSdkInput,
  ...sessionPromptSchemas,
  ...credentialConnectionSchemas,
  ...repositoryChatSchemas,
  ...profileToolSchemas,
  ...knowledgeToolSchemas,
  ...learningToolSchemas,
};
const definitions = [
  ...credentialConnectionToolDefinitions,
  ...repositoryChatToolDefinitions,
  ...profileToolDefinitions,
  ...knowledgeToolDefinitions,
  ...learningToolDefinitions,
  ...sessionPromptDefinitions,
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
    !agentToolAllowed(session, name) ||
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
      (short === 'CaptureMemoryCandidate' && input.action === 'capture') ||
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
    profilesOnly?: boolean;
    toolGuardPolicy?: Readonly<ToolGuardPolicy>;
    connectionBoundary?: ConnectionBoundary;
    assertCurrent(signal: AbortSignal): Promise<void>;
    assertCurrentSync(signal: AbortSignal): void;
    runCallback?: TurnCallbackRunner;
    agentCommunication?(): Pick<ReturnType<typeof sessionAgentCommunicationTools>, 'execute'>;
  },
) {
  const runtimeId = randomUUID();
  const authority = boundary && {
    async assertCurrent(signal: AbortSignal) {
      try {
        await boundary.assertCurrent(signal);
      } catch (cause) {
        throw new SdkAuthorityFailure(cause);
      }
    },
    assertCurrentSync(signal: AbortSignal) {
      try {
        boundary.assertCurrentSync(signal);
      } catch (cause) {
        throw new SdkAuthorityFailure(cause);
      }
    },
  };
  let current: { id: string; tools: ReturnType<typeof sessionCredentialTools> } | undefined;
  return createSdkMcpServer({
    name: 'mitzo-connections',
    version: '1.0.0',
    tools: filterAgentTools(session, [
      ...(boundary?.profilesOnly
        ? [
            ...credentialConnectionToolDefinitions.filter(
              (tool) => tool.name === 'ListConnections',
            ),
            ...profileToolDefinitions,
            ...sessionPromptDefinitions,
            ...learningToolDefinitions,
          ]
        : definitions),
      ...(boundary?.agentCommunication ? agentCommunicationDefinitions : []),
      ...(boundary ? [telosSessionLaunchDefinition] : []),
    ]).map((definition) =>
      tool(
        definition.name,
        boundary?.profilesOnly && definition.name === 'ListConnections'
          ? 'List configured Mitzo connections and their access state. Returns metadata only; this Claude route does not expose connection access requests or service requests. Credentials remain private. Open Connections to configure services.'
          : definition.description,
        schemas[definition.name as keyof typeof schemas].shape,
        async (input, extra) => {
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
          if (signal.aborted)
            return {
              content: [{ type: 'text' as const, text: 'Tool call cancelled before dispatch.' }],
              isError: true,
            };
          return (boundary?.runCallback ?? ((work) => work()))(() =>
            runGuardedTool(
              {
                signal,
                policy: boundary?.toolGuardPolicy,
                onSettled: (observation) => {
                  if (observation.outcome === 'timeout')
                    session.abortController.abort(new ToolGuardTimeoutError(observation.phase));
                },
              },
              async (signal) => {
                const id = sessionId();
                if (!id)
                  return {
                    content: [
                      { type: 'text' as const, text: 'Session is not ready; retry shortly' },
                    ],
                    isError: true,
                  };
                if (definition.name === 'TelosCreateSession' && authority) {
                  await authority.assertCurrent(signal);
                  const result = await sessionLaunchTools({
                    sessionId: id,
                    session,
                    registry,
                    permissionPrefix: prefix,
                    assertCurrent: () => authority.assertCurrent(signal),
                    assertCurrentSync: () => authority.assertCurrentSync(signal),
                  }).execute(
                    input,
                    signal,
                    {
                      turnId: runtimeId,
                      callId: String(
                        (extra as { requestId?: unknown } | undefined)?.requestId ?? randomUUID(),
                      ),
                    },
                    'TelosCreateSession',
                  );
                  await authority.assertCurrent(signal);
                  return {
                    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
                    isError: false,
                  };
                }
                if (definition.name === 'AgentCommunication' && boundary?.agentCommunication) {
                  await authority!.assertCurrent(signal);
                  const peerInput = AgentCommunicationSdkInput.parse(input);
                  const result = await executeAgentCommunicationTool(
                    () =>
                      boundary.agentCommunication!().execute(peerInput, signal, {
                        turnId: runtimeId,
                        callId: String(
                          (extra as { requestId?: unknown } | undefined)?.requestId ?? randomUUID(),
                        ),
                      }),
                    {
                      conversationId: id,
                      requestId: peerInput.requestId,
                      recipientConversationId: peerInput.recipientConversationId,
                    },
                  );
                  await authority!.assertCurrent(signal);
                  return copyCallbackOutcome(result, {
                    content: [{ type: 'text' as const, text: result.content }],
                    isError: result.isError,
                  });
                }
                if (current?.id !== id)
                  current = {
                    id,
                    tools: sessionCredentialTools(
                      id,
                      session,
                      registry,
                      prefix,
                      undefined,
                      authority
                        ? () => authority.assertCurrent(session.abortController.signal)
                        : undefined,
                      authority
                        ? () => authority.assertCurrentSync(session.abortController.signal)
                        : undefined,
                      false,
                      { boundary: boundary?.connectionBoundary },
                    ),
                  };
                await authority?.assertCurrent(signal);
                const rawResult = await current.tools.execute(definition.name, input, signal, {
                  turnId: runtimeId,
                  callId: String(
                    (extra as { requestId?: unknown } | undefined)?.requestId ?? randomUUID(),
                  ),
                });
                await authority?.assertCurrent(signal);
                const result =
                  rawResult && qualifyToolResult(definition.name, input, signal, rawResult);
                const delivered = {
                  content: [
                    {
                      type: 'text' as const,
                      text: result?.content ?? 'Connection tool unavailable',
                    },
                  ],
                  isError: result?.isError ?? true,
                };
                return result ? copyCallbackOutcome(result, delivered) : delivered;
              },
            ).catch((error: unknown) => {
              const authorityFailed = error instanceof SdkAuthorityFailure;
              const cause = authorityFailed ? error.cause : error;
              const failure = reportToolFailure(cause, {
                sessionId: sessionId() ?? runtimeId,
                tool: definition.name,
                signal,
              });
              // Authority failures, cancellation and timeout retirement retain
              // their fences. Report before propagating the original cause.
              if (
                authorityFailed ||
                signal.aborted ||
                cause instanceof ToolGuardTimeoutError ||
                findSessionRuntimeError(cause)
              )
                throw cause;
              return copyCallbackOutcome(failure, {
                content: [{ type: 'text' as const, text: failure.content }],
                isError: true,
              });
            }),
          );
        },
      ),
    ),
  });
}
