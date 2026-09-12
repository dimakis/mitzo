import type { GeminiOptions } from './gemini-session.js';
import { HOST_TOOL_INSTRUCTIONS } from './session-permission-policy.js';
import { createNativeHooks } from './native-hooks.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildPermissionHandler, type ManagedSession, type SessionRegistry } from '@mitzo/harness';
import type { AccountBinding } from '@mitzo/protocol';
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

let privateStore: NativeResponsesStore | undefined;
const runtimes = new WeakMap<ManagedSession, NativeResponsesRunner>();
export function getResponsesRuntime(session: ManagedSession) {
  return runtimes.get(session);
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
  input: AsyncIterable<{ message: { content: unknown }; mitzoMessageId?: string }> & {
    close(): void;
  };
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
    runtimes.delete(options.session);
    void hooks
      .run('SessionEnd', { reason: 'other' }, AbortSignal.timeout(5000))
      .catch(() => {})
      .finally(dispose);
    runner.interrupt();
    options.input.close();
    void mcp.close();
  }
  signal.addEventListener('abort', close, { once: true });
  return {
    async *[Symbol.asyncIterator]() {
      try {
        yield { type: 'system', subtype: 'init', session_id: options.conversationId };
        for await (const message of options.input) {
          signal.throwIfAborted();
          if (typeof message.message.content !== 'string')
            throw new Error('API chat currently supports text input');
          interrupted = false;
          try {
            for await (const event of runner.run(
              message.message.content,
              signal,
              message.mitzoMessageId,
            )) {
              if (event.type === 'result')
                await hooks.run('Stop', { stop_hook_active: false }, signal);
              yield { ...event };
            }
          } catch {
            if (!interrupted || signal.aborted)
              throw new Error(
                'API turn failed or was interrupted. Inspect the task before retrying.',
              );
            yield { type: 'result', session_id: options.conversationId, is_error: true };
          }
        }
      } finally {
        signal.removeEventListener('abort', close);
        close();
      }
    },
    interrupt: async () => {
      interrupted = true;
      runner.interrupt();
      await runner.waitUntilIdle();
    },
    close,
    stopTask: async () => {
      throw new Error('Native API subagents are unavailable');
    },
  };
}
