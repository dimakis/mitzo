import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  buildPermissionHandler,
  checkSkillPolicy,
  runGuardedTool,
  ToolGuardTimeoutError,
  throwIfApprovalExpired,
  type ManagedSession,
  type SessionRegistry,
} from '@mitzo/harness';
import type { EventStore } from './event-store.js';
import { agentToolAllowed, filterAgentTools } from './agent-tool-selection.js';
import {
  captureAgentLibraryAuthorization,
  captureAgentLibraryOperation,
} from './agent-library-transport.js';
import { sessionToolOperatorConnection } from './native-host-tool-operator.js';
import { ordinaryOperatorOwnsConversation } from './ordinary-operator-identity.js';
import { getTelosMainPublicationRuntime } from './telos-main-publication-runtime.js';
import { executeTelosBacklogOperation, isTelosBacklogTool } from './telos-backlog-tools.js';
import { executeTelosArtifactTool, isTelosArtifactTool } from './telos-artifact-tools.js';
import { isTelosItemTool } from './telos-item-tools.js';
import { executeNativeTelosItemOperation } from './native-telos-item-operations.js';
import {
  executeTelosCreateOutcome,
  executeTelosAdoptSource,
  formatTelosPermissionDenial,
  type TelosToolResult,
} from './telos-tool.js';
import { executeTelosWorkTool } from './telos-work-tools.js';
import { executeTelosWorkControlTool } from './telos-work-control-tools.js';
import { resolveTelosWorkRoleContext } from './telos-work-role-context.js';
import { localHttpBaseUrl, localServerUsesTls } from './local-server-url.js';
import { INTERNAL_TOKEN } from './internal-token.js';
import { telosSdkDefinitions, telosSdkSchemas, telosSdkPrefix } from './telos-sdk-definitions.js';
import { copyCallbackOutcome, type TurnCallbackRunner } from './turn-callbacks.js';
import { qualifyToolResult, reportToolFailure } from './tool-failure-reporting.js';

/** The registered handler owns operation approval, just as other SDK helpers do. */
export function telosSdkPermission(
  name: string,
  input: Record<string, unknown>,
  clientId: string,
  registry: SessionRegistry,
  session: ManagedSession,
) {
  if (!name.startsWith(telosSdkPrefix)) return undefined;
  const schema = telosSdkSchemas[name.slice(telosSdkPrefix.length) as keyof typeof telosSdkSchemas];
  if (
    !schema ||
    !schema.safeParse(input).success ||
    !agentToolAllowed(session, name) ||
    registry.get(clientId) !== session ||
    session.abortController.signal.aborted ||
    checkSkillPolicy(registry, clientId, name) === 'deny'
  )
    return {
      behavior: 'deny' as const,
      message: 'Telos tool unavailable under current session permissions',
    };
  return { behavior: 'allow' as const, updatedInput: input };
}

/** Thin SDK adapter. Canonical owners retain review, revisions, receipts and effects. */
export function createTelosSdkServer(owners: {
  session: ManagedSession;
  registry: SessionRegistry;
  events: EventStore;
  assertCurrent(signal: AbortSignal): Promise<void>;
  assertCurrentSync(signal: AbortSignal): void;
  runCallback?: TurnCallbackRunner;
}) {
  const { session, registry, events } = owners;
  const runtimeId = randomUUID();
  const server = createSdkMcpServer({ name: 'telos', version: '1.0.0', tools: [] });
  const definitions = filterAgentTools(session, telosSdkDefinitions);
  // SDK tool() accepts only object shapes. MCP's public request handlers retain
  // the canonical discriminated unions and refinements without a second schema.
  server.instance.server.registerCapabilities({ tools: {} });
  server.instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: definitions.map(({ name, description, input_schema }) => ({
      name,
      description,
      inputSchema: { type: 'object' as const, ...input_schema },
    })),
  }));
  server.instance.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const definition = definitions.find((tool) => tool.name === request.params.name);
    if (!definition)
      return {
        content: [{ type: 'text' as const, text: 'Telos tool is not selected for this profile.' }],
        isError: true,
      };
    const input = request.params.arguments ?? {};
    const signal = AbortSignal.any([session.abortController.signal, extra.signal]);
    return (owners.runCallback ?? ((work) => work()))(async () => {
      try {
        const result = await runGuardedTool(
          {
            signal,
            onSettled: (observation) => {
              if (observation.outcome === 'timeout')
                session.abortController.abort(new ToolGuardTimeoutError(observation.phase));
            },
          },
          async (signal) => {
            await owners.assertCurrent(signal);
            const id = session.sessionId;
            const owner = id && registry.findBySessionId(id);
            if (!id || !owner || owner.session !== session)
              throw Error('Original Telos SDK owner unavailable');
            const name = definition.name;
            const wireName = telosSdkPrefix + name;
            const connection = sessionToolOperatorConnection(session, owner.clientId);
            const authorization = captureAgentLibraryAuthorization(connection);
            const operation = captureAgentLibraryOperation(connection);
            const joined = AbortSignal.any([signal, operation.signal]);
            const current = () => {
              joined.throwIfAborted();
              owners.assertCurrentSync(joined);
              operation.assertCurrent();
              authorization.assertCurrent();
              if (
                registry.findBySessionId(id)?.session !== session ||
                sessionToolOperatorConnection(session, owner.clientId) !== connection ||
                (session.ownedLocalAuthSessionId !== undefined &&
                  !ordinaryOperatorOwnsConversation(
                    session.ownedLocalAuthSessionId,
                    authorization.auth.id,
                  )) ||
                !agentToolAllowed(session, wireName) ||
                checkSkillPolicy(registry, owner.clientId, wireName) === 'deny'
              )
                throw Error('Original Telos SDK operator, profile or skill authority unavailable');
            };
            const assertCurrent = async () => {
              await owners.assertCurrent(joined);
              current();
            };
            const approve = (exact: Record<string, unknown>) =>
              buildPermissionHandler(owner.clientId, registry)(wireName, exact, {
                signal: joined,
                toolUseID: `${runtimeId}:${extra.requestId ?? randomUUID()}`,
                forcePrompt: true,
                allowSessionGrant: false,
                approvalScope: 'request',
              });
            try {
              current();
              if (isTelosBacklogTool(name) || isTelosItemTool(name)) {
                const runtime = getTelosMainPublicationRuntime();
                if (!runtime?.supportsHost(registry, events))
                  throw Error('Canonical Telos backlog owner unavailable');
                const context = {
                  operatorId: authorization.auth.id,
                  conversationId: id,
                  toolName: name,
                  requestHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
                  signal: joined,
                  assertCurrentSync: current,
                  assertCurrent,
                };
                return await runtime.withBacklog(
                  context,
                  (data) =>
                    isTelosItemTool(name)
                      ? executeNativeTelosItemOperation(
                          {
                            context: {
                              ...data.context,
                              selectedRole: resolveTelosWorkRoleContext(
                                events,
                                id,
                                events.getSession(id)?.accountBinding ?? undefined,
                              ),
                            },
                            get items() {
                              return data.items;
                            },
                            get work() {
                              return data.work;
                            },
                            approve: (_name, exact) => approve(exact),
                          },
                          name,
                          input,
                        )
                      : executeTelosBacklogOperation(
                          {
                            context: data.context,
                            get items() {
                              return data.items;
                            },
                            get work() {
                              return data.work;
                            },
                            events,
                            isConversationLive: (id) =>
                              !!registry.findBySessionId(id)?.session.ordinaryRuntimeOwner,
                            approve: (_name, exact) => approve(exact),
                          },
                          name,
                          input,
                        ),
                  name !== 'TelosCreateChild' &&
                    name !== 'TelosCreateFeature' &&
                    name !== 'TelosUpdateItem' &&
                    (name !== 'TelosManageItem' || input.operation === 'read'),
                );
              }
              const schema = telosSdkSchemas[name as keyof typeof telosSdkSchemas];
              const parsed = schema.parse(input) as Record<string, unknown>;
              const role = resolveTelosWorkRoleContext(
                events,
                id,
                events.getSession(id)?.accountBinding ?? undefined,
              );
              if (name === 'TelosStartSlice' && role?.role !== 'lead')
                return {
                  content:
                    'Current retained Telos lead role required; no allocation or update started.',
                  isError: true,
                };
              if (name === 'TelosWorkControl' && !role)
                return {
                  content:
                    'Current retained Telos lead or worker role required; no control applied.',
                  isError: true,
                };
              const permission = await approve(parsed);
              await assertCurrent();
              throwIfApprovalExpired(permission);
              if (permission.behavior !== 'allow')
                return formatTelosPermissionDenial(
                  permission.message,
                  permission.decisionClassification === 'user_reject',
                );
              const source = name === 'TelosCreateOutcome' || name === 'TelosAdoptSource';
              const { __mitzoTelosApproval, ...proposal } = permission.updatedInput;
              if (
                !isDeepStrictEqual(source ? proposal : permission.updatedInput, parsed) ||
                (source && typeof __mitzoTelosApproval !== 'string')
              )
                throw Error('Exact Telos request approval required');
              const base = localHttpBaseUrl(
                Number.parseInt(process.env.PORT || '3100', 10),
                localServerUsesTls(),
              );
              if (source)
                return await (
                  name === 'TelosCreateOutcome'
                    ? executeTelosCreateOutcome
                    : executeTelosAdoptSource
                )(base, owner.clientId, INTERNAL_TOKEN, permission.updatedInput, joined);
              if (isTelosArtifactTool(name)) {
                const result = await executeTelosArtifactTool(
                  base,
                  owner.clientId,
                  INTERNAL_TOKEN,
                  name,
                  parsed,
                  joined,
                );
                // Reads must not disclose retained material after authority is
                // revoked during I/O. Writes retain their known canonical ACK.
                if (name !== 'TelosSaveArtifact') await assertCurrent();
                return result;
              }
              if (name === 'TelosStartSlice')
                return await executeTelosWorkTool(
                  base,
                  owner.clientId,
                  id,
                  INTERNAL_TOKEN,
                  name,
                  parsed,
                  joined,
                );
              return await executeTelosWorkControlTool(
                base,
                owner.clientId,
                id,
                INTERNAL_TOKEN,
                parsed,
                joined,
              );
            } finally {
              operation.dispose();
            }
          },
        );
        return deliver(qualifyToolResult(definition.name, input, signal, result));
      } catch (error) {
        return deliver(
          reportToolFailure(error, {
            sessionId: session.sessionId ?? 'unresolved',
            tool: definition.name,
            signal,
          }),
        );
      }
    });
  });
  return server;
}
function deliver(result: TelosToolResult) {
  return copyCallbackOutcome(result, {
    content: [{ type: 'text' as const, text: result.content }],
    isError: result.isError,
  });
}
