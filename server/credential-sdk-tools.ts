import { randomUUID } from 'node:crypto';
import {
  TelosCreateSessionInputSchema,
  AgentReadTasksSchema,
  AgentTaskProposalInputSchema,
} from '@mitzo/protocol';
import { agentTaskToolDefinitions } from './session-agent-task-tools.js';
import {
  sessionHistoryToolSchemas,
  sessionHistoryToolDefinitions,
} from './session-history-tools.js';
import { sessionSdkHistoryTools } from './session-history-sdk.js';
import type { EventStore } from './event-store.js';
import { sessionLaunchTools } from './session-launch-tools.js';
import { telosSessionLaunchDefinition } from './telos-session-launch-tool.js';
import { learningToolSchemas, learningToolDefinitions } from './session-learning-tools.js';
import { qualifyToolResult, reportToolFailure } from './tool-failure-reporting.js';
import { findSessionRuntimeError, SessionRuntimeError } from './session-runtime-error.js';
import { sessionPromptSchemas, sessionPromptDefinitions } from './session-prompt-definitions.js';
import {
  copyCallbackOutcome,
  retainCallbackOutcome,
  type TurnCallbackRunner,
} from './turn-callbacks.js';
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
import { assertToolResultAuthority, copyToolResultAuthority } from './codex-tool-result.js';
import { isReadOnlyBuiltinToolCall } from './builtin-tool-behavior.js';

const prefix = 'mcp__mitzo-connections__';
/** Keep SDK auto-admission and the mandatory PreToolUse route fence aligned.
 * Every handler still enforces its profile, live authority and operation policy. */
export { ordinarySdkConnectionHelperTools as ordinarySdkHelperTools } from './ordinary-sdk-helper-registration.js';
/** A failed authority check cannot become a recoverable application failure. */
class SdkAuthorityFailure extends SessionRuntimeError {
  constructor(cause: unknown) {
    super('runtime_unavailable', { cause });
  }
}
const schemas = {
  AgentReadTasks: AgentReadTasksSchema,
  AgentProposeTask: AgentTaskProposalInputSchema,
  ...sessionHistoryToolSchemas,
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
/** Guidance follows the same captured selection as registration. */
export function sdkInformationInstructions(session: ManagedSession): string {
  const guidance = [
    [
      'AgentCommunication',
      'AgentCommunication list discovers owned ordinary chats and their current delivery capabilities; it is not a saved-history search.',
    ],
    [
      'SearchPastSessions',
      'SearchPastSessions searches authorized saved history. Follow its continuation fields; incomplete pages are not a full inventory.',
    ],
    [
      'ReadPastSession',
      'ReadPastSession reads public messages from an exact authorized saved conversation, preserving the returned snapshot while paging.',
    ],
    [
      'ReadKnowledge',
      'ReadKnowledge identifies accepted Knowledge Library documents and their exact revisions.',
    ],
    [
      'SaveKnowledgeDraft',
      'SaveKnowledgeDraft saves a proposal for existing accepted documents after reading them. A draft is not reviewed, accepted or published.',
    ],
    [
      'AgentReadTasks',
      'AgentReadTasks lists or reads saved Agent Library task definitions and exact revisions.',
    ],
    [
      'AgentProposeTask',
      'AgentProposeTask retains the expected revision and exact profile pin for user review; it never runs or schedules a task.',
    ],
  ];
  return guidance
    .filter(([name]) => agentToolAllowed(session, name))
    .map(([, text]) => '\n' + text)
    .join('');
}
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
    historyEvents?: EventStore;
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
            ...knowledgeToolDefinitions,
            ...agentTaskToolDefinitions,
          ]
        : definitions),
      ...(boundary?.agentCommunication ? agentCommunicationDefinitions : []),
      ...(boundary?.historyEvents ? sessionHistoryToolDefinitions : []),
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
          const assertDelivery = (result: object) => {
            try {
              assertToolResultAuthority(result);
            } catch (error) {
              // A withheld read is a settled observation, never an uncertain
              // write. Runtime refusal/cancellation still takes the throw path.
              if (
                !signal.aborted &&
                error instanceof Error &&
                isReadOnlyBuiltinToolCall(definition.name, input)
              )
                retainCallbackOutcome(error, 'settled');
              throw error;
            }
          };
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
                if (
                  boundary?.historyEvents &&
                  Object.hasOwn(sessionHistoryToolSchemas, definition.name)
                ) {
                  await authority!.assertCurrent(signal);
                  const result = await sessionSdkHistoryTools({
                    events: boundary.historyEvents,
                    session,
                    registry,
                    signal,
                    ...authority!,
                  }).execute(definition.name, input, signal, {
                    turnId: runtimeId,
                    callId: String(
                      (extra as { requestId?: unknown } | undefined)?.requestId ?? randomUUID(),
                    ),
                  });
                  await authority!.assertCurrent(signal);
                  if (!result) throw Error('History handler unavailable');
                  assertDelivery(result);
                  qualifyToolResult(definition.name, input, signal, result);
                  return copyToolResultAuthority(
                    result,
                    copyCallbackOutcome(result, {
                      content: [{ type: 'text' as const, text: result.content }],
                      isError: result.isError,
                    }),
                  );
                }
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
                      !!boundary?.profilesOnly,
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
                if (rawResult) assertDelivery(rawResult);
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
                return result
                  ? copyToolResultAuthority(result, copyCallbackOutcome(result, delivered))
                  : delivered;
              },
            )
              .then((result) => {
                // Guard cleanup may await too. Recheck the canonical source and
                // caller immediately before returning the MCP payload.
                assertDelivery(result);
                return result;
              })
              .catch((error: unknown) => {
                const authorityFailed = error instanceof SdkAuthorityFailure;
                const cause = authorityFailed ? error.cause : error;
                const failure = reportToolFailure(cause, {
                  sessionId: sessionId() ?? runtimeId,
                  tool: definition.name,
                  signal,
                });
                // Authority failures, cancellation and timeout retirement retain
                // their fences. Keep the original cause inside a safe runtime
                // wrapper: the SDK serializes thrown messages to the model.
                if (authorityFailed) throw findSessionRuntimeError(error) ?? error;
                if (cause instanceof ToolGuardTimeoutError) throw cause;
                if (signal.aborted || findSessionRuntimeError(cause))
                  throw (
                    findSessionRuntimeError(cause) ??
                    new SessionRuntimeError('runtime_unavailable', { cause })
                  );
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
