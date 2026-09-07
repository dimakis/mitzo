import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AccountBinding } from '@mitzo/protocol';
import type { ManagedSession, SessionRegistry } from '@mitzo/harness';
import { AsyncQueue } from './async-queue.js';
import { CodexAppServerClient } from './codex-app-server-client.js';
import { CodexConversation } from './codex-conversation.js';
import { CodexConversationStore } from './codex-conversation-store.js';
import type { CodexAccountProfile } from './codex-account.js';
import { createNativeToolExecutor, nativeToolDefinitions } from './native-tool-executor.js';
import type { McpServerConfig } from './mcp-config.js';

const runtimes = new WeakMap<ManagedSession, CodexConversation>();
let privateStore: CodexConversationStore | undefined;
export function codexPrivateDirectory() {
  return process.env.MITZO_CODEX_PRIVATE_DIR || join(homedir(), '.mitzo', 'private', 'codex');
}
function store() {
  if (!privateStore) {
    const dir = codexPrivateDirectory();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    privateStore = new CodexConversationStore(join(dir, 'conversations.db'));
    privateStore.recoverAtStartup();
  }
  return privateStore;
}
export function getCodexRuntime(session: ManagedSession) {
  return runtimes.get(session);
}
interface Options {
  conversationId: string;
  binding: AccountBinding;
  profile: CodexAccountProfile;
  session: ManagedSession;
  registry: SessionRegistry;
  prompt: string;
  messageId: string;
  systemPrompt: string;
  env: Record<string, string>;
  mcpServers: Record<string, McpServerConfig>;
}
/** Shared chat adapter. Execution remains gated by the account catalog and unsupported capabilities fail explicitly. */
export async function openCodexChat(options: Options) {
  if (Object.keys(options.mcpServers).length)
    throw new Error('Codex MCP execution wiring is not yet available');
  const events = new AsyncQueue<Record<string, unknown>>();
  const runtime = new CodexConversation({
    conversationId: options.conversationId,
    cwd: options.session.cwd!,
    profile: options.profile,
    storedBinding: options.binding,
    store: store(),
    systemPrompt: options.systemPrompt,
    tools: nativeToolDefinitions,
    createClient: (callbacks) =>
      CodexAppServerClient.launch(options.profile.credentialRef, process.env, callbacks),
    emit: (event) => events.push(event),
    executeTool: async (name, input, signal) => {
      const owner = options.registry.findBySessionId(options.conversationId);
      if (!owner) throw new Error('Codex session unavailable');
      const execute = createNativeToolExecutor(owner.clientId, options.registry, {
        env: options.env,
      });
      const result = await execute({ type: 'tool_use', id: randomUUID(), name, input }, signal);
      return { content: result.content, isError: !!result.is_error };
    },
    onQueueChange: () => {
      const message = {
        type: 'codex_queue',
        sessionId: options.conversationId,
        items: runtime.queue().map(({ id, status }) => ({ id, status })),
      };
      if (options.session.transport?.isOpen()) options.session.transport.send(message);
    },
    onError: () => {
      if (options.session.transport?.isOpen())
        options.session.transport.send({
          type: 'error',
          sessionId: options.conversationId,
          error: 'Codex turn failed. Inspect queued work before retrying.',
        });
    },
  });
  const close = () => {
    runtime.close();
    events.close();
    runtimes.delete(options.session);
  };
  try {
    await runtime.initialize();
    runtimes.set(options.session, runtime);
    await runtime.send({ id: options.messageId, prompt: options.prompt });
  } catch (error) {
    close();
    throw error;
  }
  options.session.abortController.signal.addEventListener('abort', close, { once: true });
  return {
    [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
    interrupt: () => runtime.interrupt(),
    close,
    stopTask: async () => {
      throw new Error('Codex subagents are unavailable');
    },
  };
}
