import { admitApiTools } from './api-tool-execution.js';
import { getApiToolCatalog } from './api-tool-runtime.js';
import type { ApiToolCatalog } from './api-tool-catalog.js';
import { getCredentialConnectionsRuntime } from './credential-connections-runtime.js';
import { checkSkillPolicy } from '@mitzo/harness';
import { admitConfiguredTools } from './configured-tool-admission.js';
import { getConfiguredToolCatalog } from './configured-tool-runtime.js';
import type { ConfiguredToolCatalog, ConfiguredCatalogOptions } from './configured-tool-catalog.js';
import { loadMcpServers } from './mcp-config.js';
import {
  assertAgentToolAvailability,
  assertAgentToolRoute,
  bindAgentToolSelection,
  bindConfiguredAgentTools,
  hasAgentToolSelection,
  filterAgentTools,
  agentToolAllowed,
} from './agent-tool-selection.js';
import {
  sessionCredentialTools,
  CONNECTION_TOOL_INSTRUCTIONS,
  API_CONNECTION_INSTRUCTIONS,
} from './session-credential-tools.js';
import {
  createGithubPublishingTool,
  githubPublishingDefinition,
  GITHUB_PUBLISHING_INSTRUCTIONS,
  REQUEST_GITHUB_PUBLISH,
  hostGithubPublishingSource,
} from './github-publishing-tool.js';
import type { GeminiOptions } from './gemini-session.js';
import {
  webAccessDefinition,
  REQUEST_WEB_ACCESS,
  WEB_ACCESS_INSTRUCTIONS,
} from './request-web-access.js';
import { createWebAccessTool } from './web-access-tool.js';
import { searchOpenAI, searchGemini } from './web-search-adapters.js';
import { HOST_TOOL_INSTRUCTIONS } from './session-permission-policy.js';
import { createNativeHooks } from './native-hooks.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildPermissionHandler, type ManagedSession, type SessionRegistry } from '@mitzo/harness';
import type { AccountBinding, AgentContextSnapshot, AgentLibraryVersion } from '@mitzo/protocol';
import type {
  ExecutionTerminalReason,
  ProviderAttemptTerminalReason,
  ProviderAttemptToken,
} from '@mitzo/protocol';
import type { ResponsesCommandAuthority } from './native-responses-runner.js';
import { NativeResponsesRunner } from './native-responses-runner.js';
import { responsesUserContent } from './responses-input.js';
import { NativeResponsesStore } from './native-responses-store.js';
import { codexPrivateDirectory } from './codex-private-path.js';
import { connectCodexMcpTools } from './codex-mcp-tools.js';
import {
  createNativeToolExecutor,
  nativeToolDefinitions,
  type NativeToolOptions,
} from './native-tool-executor.js';
import type { McpServerConfig } from './mcp-config.js';
import { classifyProviderFailure } from './provider-failure.js';
import type { EventStore } from './event-store.js';
import type { ProviderDispatchAdmission } from './provider-execution.js';
import { createLogger } from './logger.js';

const log = createLogger('responses-chat-session');

let privateStore: NativeResponsesStore | undefined;
const runtimes = new WeakMap<ManagedSession, NativeResponsesRunner>();
interface PendingProviderAdmission {
  admission: ProviderDispatchAdmission;
  eventStore: EventStore;
  cancelled: boolean;
  cancellationPersisted: boolean;
}
const pendingAdmissions = new WeakMap<ManagedSession, Map<string, PendingProviderAdmission>>();
export function getResponsesRuntime(session: ManagedSession) {
  return runtimes.get(session);
}
export function trackResponsesProviderAdmission(
  session: ManagedSession,
  admission: ProviderDispatchAdmission,
  eventStore: EventStore,
): void {
  let pending = pendingAdmissions.get(session);
  if (!pending) {
    pending = new Map();
    pendingAdmissions.set(session, pending);
  }
  pending.set(admission.providerAttemptId, {
    admission,
    eventStore,
    cancelled: false,
    cancellationPersisted: false,
  });
}

function cancelPendingAdmissions(session: ManagedSession): void {
  let firstError: unknown;
  for (const pending of pendingAdmissions.get(session)?.values() ?? []) {
    if (pending.cancellationPersisted) continue;
    try {
      persistPendingCancellation(pending);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

function persistPendingCancellation(pending: PendingProviderAdmission): void {
  pending.cancelled = true;
  pending.eventStore.transitionExecution(pending.admission.token, 'TERMINAL', 'interrupted');
  pending.cancellationPersisted = true;
}
export function getNativeResponsesStore() {
  if (!privateStore) {
    const directory = codexPrivateDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privateStore = new NativeResponsesStore(join(directory, 'responses.db'));
    privateStore.recoverAtStartup();
  }
  return privateStore;
}
interface Options {
  agentProfile?: AgentLibraryVersion;
  /** Trusted offline seam, never client input. */
  apiTools?: { catalog: ApiToolCatalog };
  configuredTools?: Pick<
    ConfiguredCatalogOptions,
    'readSources' | 'connect' | 'assertRuntimeCurrent'
  > & { catalog: ConfiguredToolCatalog };
  /** Server-owned configured-source environment, independent of session variables. */
  configuredSourceEnv?: Record<string, string>;
  commandAuthority?: ResponsesCommandAuthority;
  /** Server-owned initial/retained command fence before the first active turn exists. */
  assertStartupCurrent?: () => void;
  publishingGitStorageRoots?: readonly string[];
  resume?: boolean;
  conversationId: string;
  binding: AccountBinding;
  apiKey?: string;
  getApiKey?: (signal?: AbortSignal) => Promise<string>;
  selectedModel?: string;
  reasoningEffort?: string | null;
  gemini?: GeminiOptions;
  session: ManagedSession;
  registry: SessionRegistry;
  input: AsyncIterable<{
    message: { content: unknown };
    mitzoMessageId?: string;
    mitzoImages?: Array<{ data: string; mediaType: string }>;
    providerAdmission?: ProviderDispatchAdmission;
  }> & {
    close(): void;
  };
  eventStore?: EventStore;
  systemPrompt: string;
  env: Record<string, string>;
  mcpServers: Record<string, McpServerConfig>;
  onDemandCreate?: NativeToolOptions['onDemandCreate'];
  store?: NativeResponsesStore;
  agentContext?: AgentContextSnapshot;
  prepareAgentContext?: (signal: AbortSignal) => Promise<void>;
  onAgentContextAccepted?: (
    commandId: string,
    threadId: string,
    turnId: string,
    contextSha256: string,
  ) => void;
}
/** API execution uses the shared interaction policy and a private continuation store. */
export async function openResponsesChat(options: Options) {
  const agentProfile =
    options.agentProfile ?? options.eventStore?.getSession(options.conversationId)?.agentProfile;
  assertAgentToolRoute(agentProfile?.definition, 'local-api');
  assertAgentToolAvailability(agentProfile?.definition, options.conversationId);
  if (agentProfile) bindAgentToolSelection(options.session, agentProfile.definition);

  let initializing = true;
  let publishingTurnId: string = randomUUID();
  const assertRuntimeCurrent = options.commandAuthority
    ? () => options.commandAuthority!.assertEffect(publishingTurnId)
    : undefined;
  const assertRuntimeCurrentSync = options.commandAuthority
    ? () => options.commandAuthority!.assertStart(publishingTurnId)
    : undefined;
  const assertMcpCurrent = options.commandAuthority
    ? () => {
        if (initializing) {
          if (!options.assertStartupCurrent)
            throw Error('Owned Responses startup authority unavailable');
          options.assertStartupCurrent();
        } else assertRuntimeCurrentSync!();
      }
    : undefined;
  const signal = options.session.abortController.signal;
  const connectionTools = sessionCredentialTools(
    options.conversationId,
    options.session,
    options.registry,
    '',
    undefined,
    assertRuntimeCurrent,
    assertRuntimeCurrentSync,
  );
  signal.throwIfAborted();
  const privateStorage = options.store ?? getNativeResponsesStore();
  const { hooks, dispose } = createNativeHooks(
    options.session.cwd!,
    options.conversationId,
    options.env,
    {
      trustProjectHooks:
        !hasAgentToolSelection(options.session) &&
        !options.commandAuthority &&
        process.env.MITZO_TRUST_PROJECT_HOOKS === '1',
    },
  );
  let startup;
  try {
    assertMcpCurrent?.();
    startup = options.agentContext
      ? {}
      : await hooks.run('SessionStart', { source: options.resume ? 'resume' : 'startup' }, signal);
    assertMcpCurrent?.();
  } catch (error) {
    dispose();
    throw error;
  }
  const configuredRefs =
    agentProfile?.definition.tools?.filter((ref) => ref.id.startsWith('mcp:')) ?? [];
  const configuredSourceEnv = options.configuredSourceEnv;
  if (configuredRefs.length && !configuredSourceEnv) {
    dispose();
    throw Error('Configured source launch environment is unavailable');
  }
  const configuredOptions: ConfiguredCatalogOptions = {
    cwd: options.session.cwd!,
    env: { ...(configuredSourceEnv ?? options.env) },
    signal,
    readSources: options.configuredTools?.readSources ?? loadMcpServers,
    connect: options.configuredTools?.connect,
    assertRuntimeCurrent: () => {
      signal.throwIfAborted();
      assertMcpCurrent?.();
      options.configuredTools?.assertRuntimeCurrent();
      if (options.registry.findBySessionId(options.conversationId)?.session !== options.session)
        throw Error('Configured tool session ownership changed');
    },
  };
  let configuredAdmissions: Awaited<ReturnType<typeof admitConfiguredTools>>['admitted'] = [];
  const mcp = await (
    configuredRefs.length
      ? admitConfiguredTools(
          options.configuredTools?.catalog ?? getConfiguredToolCatalog(),
          configuredRefs,
          configuredOptions,
        ).then((result) => {
          configuredAdmissions = result.admitted;
          return result;
        })
      : connectCodexMcpTools(hasAgentToolSelection(options.session) ? {} : options.mcpServers, {
          cwd: options.session.cwd!,
          env: options.env,
          signal,
          assertRuntimeCurrent: assertMcpCurrent,
        })
  ).catch((error) => {
    dispose();
    throw error;
  });
  let apiTools: ReturnType<typeof admitApiTools> | undefined;
  try {
    const apiRefs =
      agentProfile?.definition.tools?.filter((ref) => ref.id.startsWith('api:')) ?? [];
    if (apiRefs.length) {
      const service = getCredentialConnectionsRuntime();
      if (!service) throw Error('API tools require the existing connection runtime');
      const assertCurrent = () => {
        signal.throwIfAborted();
        assertMcpCurrent?.();
        if (
          getCredentialConnectionsRuntime() !== service ||
          options.registry.findBySessionId(options.conversationId)?.session !== options.session
        )
          throw Error('API tool session ownership changed');
      };
      apiTools = admitApiTools({
        catalog: options.apiTools?.catalog ?? getApiToolCatalog(),
        service,
        sessionId: options.conversationId,
        refs: apiRefs,
        assertCurrent,
        assertRuntimeCurrent,
        stillAllowed: (name) => {
          const owner = options.registry.findBySessionId(options.conversationId);
          return (
            !!owner &&
            (name === 'ConnectionRequest' || agentToolAllowed(options.session, name)) &&
            checkSkillPolicy(options.registry, owner.clientId, name) !== 'deny'
          );
        },
        approve: async (name, input, opts) => {
          assertCurrent();
          const owner = options.registry.findBySessionId(options.conversationId)!;
          const decision = await buildPermissionHandler(owner.clientId, options.registry)(
            name,
            input,
            opts,
          );
          assertCurrent();
          return decision;
        },
      });
    }
    if (configuredAdmissions.length || apiTools?.admitted.length)
      bindConfiguredAgentTools(options.session, [
        ...configuredAdmissions,
        ...(apiTools?.admitted ?? []),
      ]);
  } catch (error) {
    dispose();
    await mcp.close();
    throw error;
  }
  initializing = false;
  const githubPublishing = createGithubPublishingTool(
    options.conversationId,
    options.registry,
    () => hostGithubPublishingSource(options.session, options.publishingGitStorageRoots),
    options.session,
    assertRuntimeCurrent,
  );
  let interrupted = false;
  let activeTurnFinalized: Promise<void> | undefined;
  let completeActiveTurn: (() => void) | undefined;
  const systemPrompt =
    options.systemPrompt +
    CONNECTION_TOOL_INSTRUCTIONS +
    API_CONNECTION_INSTRUCTIONS +
    HOST_TOOL_INSTRUCTIONS +
    WEB_ACCESS_INSTRUCTIONS +
    GITHUB_PUBLISHING_INSTRUCTIONS +
    (startup.context ? `\n\n${startup.context}` : '');
  const definitions = structuredClone(
    filterAgentTools(options.session, [
      ...connectionTools.definitions,
      ...nativeToolDefinitions,
      ...mcp.definitions,
      ...(apiTools?.definitions ?? []),
      webAccessDefinition,
      githubPublishingDefinition,
    ]),
  );
  if (agentProfile?.definition.tools !== undefined) {
    try {
      privateStorage.bindAgentTools(
        options.conversationId,
        options.binding,
        {
          profileHash: agentProfile.contentHash,
          tools: definitions,
          ...(configuredAdmissions.length ? { configuredTools: configuredAdmissions } : {}),
          ...(apiTools?.admitted.length ? { apiTools: apiTools.admitted } : {}),
        },
        !!options.resume,
      );
    } catch (error) {
      githubPublishing.close();
      dispose();
      await mcp.close();
      throw error;
    }
  }
  const admittedNames = new Set(definitions.map((tool) => tool.name));
  const runner = new NativeResponsesRunner({
    commandAuthority: options.commandAuthority,
    conversationId: options.conversationId,
    binding: options.binding,
    apiKey: options.apiKey,
    getApiKey: options.getApiKey,
    gemini: options.gemini,
    store: privateStorage,
    systemPrompt,
    prepareAgentContext: options.prepareAgentContext,
    maxTokens: 8192,
    selectedModel: options.selectedModel,
    reasoningEffort: options.reasoningEffort ?? undefined,
    tools: definitions,
    executeTool: async (block, signal) => {
      if (
        hasAgentToolSelection(options.session) &&
        (!admittedNames.has(block.name) || !agentToolAllowed(options.session, block.name))
      )
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'Tool is not selected by this session’s published agent profile',
          is_error: true,
        };

      if (options.commandAuthority) await options.commandAuthority.assertEffect(publishingTurnId);
      const result = await hooks.executeTool(
        block.name,
        block.input,
        signal,
        async (input, forcePrompt) => {
          if (options.commandAuthority)
            await options.commandAuthority.assertEffect(publishingTurnId);
          const apiResult = await apiTools?.execute(
            block.name,
            input,
            AbortSignal.any([signal, options.session.abortController.signal]),
          );
          if (apiResult) return apiResult;
          const keychainResult = await connectionTools.execute(block.name, input, signal, {
            turnId: publishingTurnId,
            callId: block.id,
          });
          if (keychainResult) return keychainResult;
          if (block.name === REQUEST_GITHUB_PUBLISH)
            return githubPublishing(input, signal, { turnId: publishingTurnId, callId: block.id });
          if (block.name === REQUEST_WEB_ACCESS) {
            return createWebAccessTool(
              options.conversationId,
              options.registry,
              async (query, signal) =>
                options.gemini
                  ? searchGemini(query, signal, options.gemini, runner.getSelectedModel())
                  : searchOpenAI(
                      query,
                      signal,
                      options.getApiKey ? await options.getApiKey(signal) : options.apiKey!,
                      runner.getSelectedModel(),
                    ),
              assertRuntimeCurrent,
            )(input, signal);
          }
          const owner = options.registry.findBySessionId(options.conversationId);
          if (!owner) throw new Error('Session unavailable');
          if (mcp.definitions.some((t) => t.name === block.name)) {
            const result = await mcp.execute(
              block.name,
              input,
              async (name, input, signal, grant) => {
                const decision = await buildPermissionHandler(owner.clientId, options.registry, {
                  onDemandCreate: options.onDemandCreate,
                })(name, input, { ...grant, signal, toolUseID: randomUUID(), forcePrompt });
                if (options.commandAuthority)
                  await options.commandAuthority.assertEffect(publishingTurnId);
                return decision;
              },
              signal,
            );
            return result;
          }
          const result = await createNativeToolExecutor(owner.clientId, options.registry, {
            env: options.env,
            forcePrompt,
            assertRuntimeCurrentAsync: options.commandAuthority
              ? () => options.commandAuthority!.assertEffect(publishingTurnId)
              : undefined,
            assertRuntimeCurrent: options.commandAuthority
              ? () => options.commandAuthority!.assertStart(publishingTurnId)
              : undefined,
            onDemandCreate: options.onDemandCreate,
          })({ ...block, input }, signal);
          return { content: result.content, isError: !!result.is_error };
        },
      );
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: result.content,
        is_error: result.isError,
      };
    },
  });
  runtimes.set(options.session, runner);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    try {
      cancelPendingAdmissions(options.session);
    } catch {
      log.warn('could not persist queued cancellation; startup recovery required', {
        conversationId: options.conversationId,
      });
    } finally {
      githubPublishing.close();
      runtimes.delete(options.session);
      void hooks
        .run('SessionEnd', { reason: 'other' }, AbortSignal.timeout(5000))
        .catch(() => {})
        .finally(dispose);
      runner.interrupt();
      options.input.close();
      void mcp.close();
    }
  }
  signal.addEventListener('abort', close, { once: true });
  return {
    async *[Symbol.asyncIterator]() {
      try {
        yield { type: 'system', subtype: 'init', session_id: options.conversationId };
        for await (const message of options.input) {
          const providerAdmission = message.providerAdmission;
          if (providerAdmission && !options.eventStore) {
            throw new Error('Durable provider admission requires an EventStore');
          }
          const trackedAdmission = providerAdmission
            ? pendingAdmissions.get(options.session)?.get(providerAdmission.providerAttemptId)
            : undefined;
          if (trackedAdmission?.cancelled) {
            try {
              if (!trackedAdmission.cancellationPersisted) {
                persistPendingCancellation(trackedAdmission);
              }
            } catch {
              log.warn('could not persist skipped queued cancellation; startup recovery required', {
                conversationId: options.conversationId,
              });
            }
            if (trackedAdmission.cancellationPersisted) {
              pendingAdmissions.get(options.session)?.delete(providerAdmission!.providerAttemptId);
            }
            continue;
          }
          if (signal.aborted) {
            if (providerAdmission) {
              options.eventStore!.transitionExecution(
                providerAdmission.token,
                'TERMINAL',
                'interrupted',
              );
              pendingAdmissions.get(options.session)?.delete(providerAdmission.providerAttemptId);
            }
            signal.throwIfAborted();
          }
          if (typeof message.message.content !== 'string')
            throw new Error(
              'API chat requires a string prompt with optional Mitzo image attachments',
            );
          if (options.binding.provider === 'google-vertex' && message.mitzoImages?.length) {
            throw new Error('Google Vertex image attachments are not supported');
          }
          const content = responsesUserContent(message.message.content, message.mitzoImages);
          if (options.commandAuthority)
            options.commandAuthority.assertStart(message.mitzoMessageId!);
          let providerAttempt: ProviderAttemptToken | undefined;
          if (providerAdmission) {
            const attempt = options.eventStore!.beginProviderAttempt(
              providerAdmission.token,
              providerAdmission.providerAttemptId,
            );
            if (attempt.duplicate) {
              pendingAdmissions.get(options.session)?.delete(providerAdmission.providerAttemptId);
              continue;
            }
            providerAttempt = attempt.token;
            pendingAdmissions.get(options.session)?.delete(providerAdmission.providerAttemptId);
            activeTurnFinalized = new Promise<void>((resolve) => {
              completeActiveTurn = resolve;
            });
          }
          publishingTurnId = message.mitzoMessageId ?? randomUUID();
          interrupted = false;
          let contextAccepted = false;
          let providerTerminalized = false;
          let executionTerminalized = false;
          const terminalizeProvider = (reason: ProviderAttemptTerminalReason) => {
            if (!providerAttempt || providerTerminalized) return;
            options.eventStore!.transitionProviderAttempt(providerAttempt, 'TERMINAL', reason);
            providerTerminalized = true;
          };
          const terminalizeExecution = (reason: ExecutionTerminalReason) => {
            if (!providerAttempt || executionTerminalized) return;
            options.eventStore!.transitionExecution(providerAdmission!.token, 'TERMINAL', reason);
            executionTerminalized = true;
          };
          const terminalize = (
            providerReason: ProviderAttemptTerminalReason,
            executionReason: ExecutionTerminalReason,
          ) => {
            terminalizeProvider(providerReason);
            terminalizeExecution(executionReason);
          };
          try {
            await options.prepareAgentContext?.(signal);
            signal.throwIfAborted();
            for await (const event of runner.run(content, signal, message.mitzoMessageId)) {
              // The Responses adapter emits message_start only after response.created.
              // Local initialization and a failed request are not delivery evidence.
              if (
                !contextAccepted &&
                !interrupted &&
                !signal.aborted &&
                event.type === 'stream_event' &&
                event.event.type === 'message_start'
              ) {
                const providerId =
                  options.binding.provider === 'openai'
                    ? event.event.message.id
                    : options.binding.provider === 'google-vertex' &&
                        event.event.providerReceipt?.provider === 'google-vertex'
                      ? event.event.providerReceipt.responseId
                      : undefined;
                if (providerId) {
                  contextAccepted = true;
                  options.onAgentContextAccepted?.(
                    publishingTurnId,
                    options.conversationId,
                    providerId,
                    createHash('sha256').update(systemPrompt).digest('hex'),
                  );
                }
              }
              if (event.type === 'result') {
                if (interrupted || signal.aborted) {
                  terminalize('cancelled', 'interrupted');
                  yield { ...event, account_use_cancelled: true };
                  continue;
                }
                const result = event as typeof event & {
                  is_error?: boolean;
                  provider_failure?: { ambiguous?: boolean };
                };
                const isError = result.is_error === true;
                const failure = result.provider_failure;
                terminalizeProvider(
                  isError ? (failure?.ambiguous ? 'ambiguous' : 'failed') : 'completed',
                );
                await hooks.run('Stop', { stop_hook_active: false }, signal);
                if (interrupted || signal.aborted) {
                  terminalizeExecution('interrupted');
                  yield { ...event, account_use_cancelled: true };
                  continue;
                }
                terminalizeExecution(isError ? 'failed' : 'completed');
              }
              yield { ...event };
            }
            if (providerAttempt && (!providerTerminalized || !executionTerminalized)) {
              terminalize('failed', 'failed');
            }
          } catch (error) {
            if (!interrupted && !signal.aborted && options.binding.provider === 'openai') {
              const providerFailure = classifyProviderFailure(error, {
                correlationId: message.mitzoMessageId ?? randomUUID(),
              });
              terminalize(providerFailure.ambiguous ? 'ambiguous' : 'failed', 'failed');
              yield {
                type: 'result',
                session_id: options.conversationId,
                is_error: true,
                provider_failure: providerFailure,
              };
              return;
            }
            const wasInterrupted = interrupted || signal.aborted;
            terminalize(
              wasInterrupted ? 'cancelled' : 'failed',
              wasInterrupted ? 'interrupted' : 'failed',
            );
            if (!interrupted || signal.aborted)
              throw new Error(
                'API turn failed or was interrupted. Inspect the task before retrying.',
                { cause: error },
              );
            yield { type: 'result', session_id: options.conversationId, is_error: true };
          } finally {
            try {
              if (providerAttempt && (!providerTerminalized || !executionTerminalized)) {
                const wasInterrupted = interrupted || signal.aborted;
                terminalize(
                  wasInterrupted ? 'cancelled' : 'ambiguous',
                  wasInterrupted ? 'interrupted' : 'failed',
                );
              }
            } finally {
              completeActiveTurn?.();
              completeActiveTurn = undefined;
              activeTurnFinalized = undefined;
            }
          }
        }
      } finally {
        signal.removeEventListener('abort', close);
        close();
      }
    },
    interrupt: async () => {
      interrupted = true;
      let cancellationError: unknown;
      try {
        cancelPendingAdmissions(options.session);
      } catch (error) {
        cancellationError = error;
      } finally {
        runner.interrupt();
        await runner.waitUntilIdle();
        await activeTurnFinalized;
      }
      if (cancellationError) throw cancellationError;
    },
    close,
    stopTask: async () => {
      throw new Error('Native API subagents are unavailable');
    },
  };
}
