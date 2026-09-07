import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildPermissionHandler, type ManagedSession, type SessionRegistry } from '@mitzo/harness';
import type { AccountBinding } from '@mitzo/protocol';
import { NativeResponsesRunner } from './native-responses-runner.js';
import { NativeResponsesStore } from './native-responses-store.js';
import { codexPrivateDirectory } from './codex-private-path.js';
import { connectCodexMcpTools } from './codex-mcp-tools.js';
import { createNativeToolExecutor, nativeToolDefinitions } from './native-tool-executor.js';
import type { McpServerConfig } from './mcp-config.js';

let privateStore: NativeResponsesStore | undefined;
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
  conversationId: string;
  binding: AccountBinding;
  apiKey: string;
  session: ManagedSession;
  registry: SessionRegistry;
  input: AsyncIterable<{ message: { content: unknown } }> & { close(): void };
  systemPrompt: string;
  env: Record<string, string>;
  mcpServers: Record<string, McpServerConfig>;
  store?: NativeResponsesStore;
}
/** API execution uses the shared interaction policy and a private continuation store. */
export async function openResponsesChat(options: Options) {
  const signal = options.session.abortController.signal;
  signal.throwIfAborted();
  const mcp = await connectCodexMcpTools(options.mcpServers, {
    cwd: options.session.cwd!,
    env: options.env,
    signal,
  });
  let interrupted = false;
  const runner = new NativeResponsesRunner({
    conversationId: options.conversationId,
    binding: options.binding,
    apiKey: options.apiKey,
    store: options.store ?? store(),
    systemPrompt: options.systemPrompt,
    maxTokens: 8192,
    tools: [...nativeToolDefinitions, ...mcp.definitions],
    executeTool: async (block, signal) => {
      const owner = options.registry.findBySessionId(options.conversationId);
      if (!owner) throw new Error('Session unavailable');
      if (mcp.definitions.some((t) => t.name === block.name)) {
        const result = await mcp.execute(
          block.name,
          block.input,
          (name, input, signal) =>
            buildPermissionHandler(owner.clientId, options.registry)(name, input, {
              signal,
              toolUseID: randomUUID(),
            }),
          signal,
        );
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.content,
          is_error: result.isError,
        };
      }
      return createNativeToolExecutor(owner.clientId, options.registry, { env: options.env })(
        block,
        signal,
      );
    },
  });
  function close() {
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
            yield* runner.run(message.message.content, signal);
          } catch {
            if (!interrupted || signal.aborted)
              throw new Error(
                'OpenAI API turn failed or was interrupted. Inspect the task before retrying.',
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
    },
    close,
    stopTask: async () => {
      throw new Error('OpenAI API subagents are unavailable');
    },
  };
}
