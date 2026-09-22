import type { GeminiOptions } from './gemini-session.js';
import { HOST_TOOL_INSTRUCTIONS } from './session-permission-policy.js';
import { createNativeHooks } from './native-hooks.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildPermissionHandler, type ManagedSession, type SessionRegistry } from '@mitzo/harness';
import type { AccountBinding } from '@mitzo/protocol';
import type {
  ExecutionTerminalReason,
  ProviderAttemptTerminalReason,
  ProviderAttemptToken,
} from '@mitzo/protocol';
import { NativeResponsesRunner } from './native-responses-runner.js';
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
function store() {
  if (!privateStore) {
    const directory = codexPrivateDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privateStore = new NativeResponsesStore(join(directory, 'responses.db'));
    privateStore.recoverAtStartup();
  }
  return privateStore;
}
interface Options {
  resume?: boolean;
  conversationId: string;
  binding: AccountBinding;
  apiKey?: string;
  selectedModel?: string;
  reasoningEffort?: string | null;
  gemini?: GeminiOptions;
  session: ManagedSession;
  registry: SessionRegistry;
  input: AsyncIterable<{
    message: { content: unknown };
    mitzoMessageId?: string;
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
}
/** API execution uses the shared interaction policy and a private continuation store. */
export async function openResponsesChat(options: Options) {
  const signal = options.session.abortController.signal;
  signal.throwIfAborted();
  const privateStorage = options.store ?? store();
  const { hooks, dispose } = createNativeHooks(
    options.session.cwd!,
    options.conversationId,
    options.env,
    { trustProjectHooks: process.env.MITZO_TRUST_PROJECT_HOOKS === '1' },
  );
  let startup;
  try {
    startup = await hooks.run(
      'SessionStart',
      { source: options.resume ? 'resume' : 'startup' },
      signal,
    );
  } catch (error) {
    dispose();
    throw error;
  }
  const mcp = await connectCodexMcpTools(options.mcpServers, {
    cwd: options.session.cwd!,
    env: options.env,
    signal,
  }).catch((error) => {
    dispose();
    throw error;
  });
  let interrupted = false;
  let activeTurnFinalized: Promise<void> | undefined;
  let completeActiveTurn: (() => void) | undefined;
  const runner = new NativeResponsesRunner({
    conversationId: options.conversationId,
    binding: options.binding,
    apiKey: options.apiKey,
    gemini: options.gemini,
    store: privateStorage,
    systemPrompt:
      options.systemPrompt +
      HOST_TOOL_INSTRUCTIONS +
      (startup.context ? `\n\n${startup.context}` : ''),
    maxTokens: 8192,
    selectedModel: options.selectedModel,
    reasoningEffort: options.reasoningEffort ?? undefined,
    tools: [...nativeToolDefinitions, ...mcp.definitions],
    executeTool: async (block, signal) => {
      const result = await hooks.executeTool(
        block.name,
        block.input,
        signal,
        async (input, forcePrompt) => {
          const owner = options.registry.findBySessionId(options.conversationId);
          if (!owner) throw new Error('Session unavailable');
          if (mcp.definitions.some((t) => t.name === block.name)) {
            const result = await mcp.execute(
              block.name,
              input,
              (name, input, signal) =>
                buildPermissionHandler(owner.clientId, options.registry, {
                  onDemandCreate: options.onDemandCreate,
                })(name, input, {
                  signal,
                  toolUseID: randomUUID(),
                  forcePrompt,
                }),
              signal,
            );
            return result;
          }
          const result = await createNativeToolExecutor(owner.clientId, options.registry, {
            env: options.env,
            forcePrompt,
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
            throw new Error('API chat currently supports text input');
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
          interrupted = false;
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
            for await (const event of runner.run(
              message.message.content,
              signal,
              message.mitzoMessageId,
            )) {
              if (event.type === 'result') {
                if (interrupted || signal.aborted) {
                  terminalize('cancelled', 'interrupted');
                  yield { ...event };
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
