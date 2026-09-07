import { loadAccountProfiles } from './account-profiles.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { codexPrivateDirectory } from './codex-private-path.js';
import type { AccountBinding } from '@mitzo/protocol';
import { buildPermissionHandler, type ManagedSession, type SessionRegistry } from '@mitzo/harness';
import { connectCodexMcpTools } from './codex-mcp-tools.js';
import { AsyncQueue } from './async-queue.js';
import { CodexAppServerClient } from './codex-app-server-client.js';
import { CodexConversation } from './codex-conversation.js';
import { CodexConversationStore } from './codex-conversation-store.js';
import type { CodexAccountProfile } from './codex-account.js';
import { createNativeToolExecutor, nativeToolDefinitions } from './native-tool-executor.js';
import type { McpServerConfig } from './mcp-config.js';

const runtimes = new WeakMap<ManagedSession, CodexConversation>();
let privateStore: CodexConversationStore | undefined;
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
export function readCodexQueue(
  conversationId: string,
  binding: AccountBinding,
  session?: ManagedSession,
) {
  if (binding.provider !== 'openai-codex') return undefined;
  try {
    const live = session ? getCodexRuntime(session) : undefined;
    const commands = live?.queue() ?? store().commands(conversationId, binding);
    return {
      model: commands.at(-1)?.model ?? binding.model,
      paused: live?.isPaused() ?? true,
      connected: !!live,
      queued: commands.filter((c) => c.status === 'queued').length,
      interrupted: commands.filter((c) => c.status === 'interrupted' || c.status === 'failed')
        .length,
    };
  } catch {
    return { paused: true, connected: false, queued: 0, interrupted: 0 };
  }
}
interface Options {
  conversationId: string;
  binding: AccountBinding;
  profile: CodexAccountProfile;
  session: ManagedSession;
  registry: SessionRegistry;
  prompt: string;
  model?: string;
  messageId: string;
  systemPrompt: string;
  env: Record<string, string>;
  mcpServers: Record<string, McpServerConfig>;
}
/** Shared chat adapter. Execution remains gated by the account catalog and unsupported capabilities fail explicitly. */
export async function openCodexChat(options: Options) {
  const signal = options.session.abortController.signal;
  signal.throwIfAborted();
  const privateStorage = store();
  const mcp = await connectCodexMcpTools(options.mcpServers, {
    cwd: options.session.cwd!,
    env: options.env,
    signal: options.session.abortController.signal,
  });
  const events = new AsyncQueue<Record<string, unknown>>();
  let closed = false;
  function finish() {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', close);
    events.close();
    void mcp.close();
    runtimes.delete(options.session);
  }
  const runtime = new CodexConversation({
    conversationId: options.conversationId,
    cwd: options.session.cwd!,
    profile: options.profile,
    storedBinding: options.binding,
    store: privateStorage,
    systemPrompt: options.systemPrompt,
    validateModel: (model) => {
      const current = loadAccountProfiles().resolve(options.binding.accountId, model);
      if (
        current.provider !== options.binding.provider ||
        current.profileRevision !== options.binding.profileRevision
      )
        throw new Error('Account configuration changed');
    },
    tools: [...nativeToolDefinitions, ...mcp.definitions],
    displayToolName: mcp.displayName,
    createClient: (callbacks) =>
      CodexAppServerClient.launch(options.profile.credentialRef, process.env, callbacks),
    emit: (event) => events.push(event),
    onClosed: finish,
    executeTool: async (name, input, signal) => {
      const owner = options.registry.findBySessionId(options.conversationId);
      if (!owner) throw new Error('Codex session unavailable');
      if (mcp.definitions.some((t) => t.name === name))
        return mcp.execute(
          name,
          input,
          async (canonical, args, s) =>
            buildPermissionHandler(owner.clientId, options.registry)(canonical, args, {
              signal: s,
              toolUseID: randomUUID(),
            }),
          signal,
        );
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
  function close() {
    if (closed) return;
    runtime.close();
    finish();
  }
  signal.addEventListener('abort', close, { once: true });
  try {
    signal.throwIfAborted();
    await runtime.initialize();
    signal.throwIfAborted();
    runtimes.set(options.session, runtime);
    await runtime.send({ id: options.messageId, prompt: options.prompt, model: options.model });
  } catch (error) {
    close();
    throw error;
  }
  return {
    [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
    interrupt: () => runtime.interrupt(),
    close,
    stopTask: async () => {
      throw new Error('Codex subagents are unavailable');
    },
  };
}
