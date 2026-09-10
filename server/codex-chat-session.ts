import { HOST_TOOL_INSTRUCTIONS } from './session-permission-policy.js';
import { createNativeHooks } from './native-hooks.js';
import { requestCodexUserInput } from './codex-user-input.js';
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
import {
  createNativeToolExecutor,
  nativeToolDefinitions,
  type NativeToolOptions,
} from './native-tool-executor.js';
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
/** Cold reconnect creates the session before its app-server runtime is ready.
 * Bound queue continuation waits briefly for that registration instead of
 * exposing a timing-dependent 409 to the client. */
export async function waitForCodexRuntime(session: ManagedSession, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let runtime = getCodexRuntime(session);
  while (!runtime && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    runtime = getCodexRuntime(session);
  }
  return runtime;
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
      reasoningEffort: commands.at(-1)?.reasoningEffort,
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
  resume?: boolean;
  conversationId: string;
  binding: AccountBinding;
  profile: CodexAccountProfile;
  session: ManagedSession;
  registry: SessionRegistry;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  images?: Array<{ data: string; mediaType: string }>;
  messageId: string;
  systemPrompt: string;
  env: Record<string, string>;
  mcpServers: Record<string, McpServerConfig>;
  onDemandCreate?: NativeToolOptions['onDemandCreate'];
}
/** Shared chat adapter. Execution remains gated by the account catalog and unsupported capabilities fail explicitly. */
export async function openCodexChat(options: Options) {
  const signal = options.session.abortController.signal;
  signal.throwIfAborted();
  const privateStorage = store();
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
    signal: options.session.abortController.signal,
  }).catch((error) => {
    dispose();
    throw error;
  });
  const events = new AsyncQueue<Record<string, unknown>>();
  let closed = false;
  function finish() {
    if (closed) return;
    closed = true;
    void hooks
      .run('SessionEnd', { reason: 'other' }, AbortSignal.timeout(5000))
      .catch(() => {})
      .finally(dispose);
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
    systemPrompt:
      options.systemPrompt +
      HOST_TOOL_INSTRUCTIONS +
      (startup.context ? `\n\n${startup.context}` : ''),
    beforeComplete: async (signal) => {
      await hooks.run('Stop', { stop_hook_active: false }, signal);
    },
    validateModel: (model, reasoningEffort) => {
      const entry = loadAccountProfiles()
        .catalog()
        .find((a) => a.id === options.binding.accountId)
        ?.models.find((m) => m.id === model);
      if (
        reasoningEffort &&
        (!entry ||
          !('reasoningEfforts' in entry) ||
          !(entry.reasoningEfforts as string[] | undefined)?.includes(reasoningEffort))
      )
        throw new Error('Thinking level unavailable for this model');
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
    requestUserInput: async (params, signal) => {
      const owner = options.registry.findBySessionId(options.conversationId);
      if (!owner) throw new Error('Codex session unavailable');
      return requestCodexUserInput(params, signal, owner.clientId, options.registry);
    },
    executeTool: async (name, input, signal) =>
      hooks.executeTool(mcp.displayName(name), input, signal, async (input, forcePrompt) => {
        const owner = options.registry.findBySessionId(options.conversationId);
        if (!owner) throw new Error('Codex session unavailable');
        if (mcp.definitions.some((t) => t.name === name))
          return mcp.execute(
            name,
            input,
            async (canonical, args, s) =>
              buildPermissionHandler(owner.clientId, options.registry, {
                onDemandCreate: options.onDemandCreate,
              })(canonical, args, {
                signal: s,
                toolUseID: randomUUID(),
                forcePrompt,
              }),
            signal,
          );
        const execute = createNativeToolExecutor(owner.clientId, options.registry, {
          env: options.env,
          forcePrompt,
          onDemandCreate: options.onDemandCreate,
        });
        const result = await execute({ type: 'tool_use', id: randomUUID(), name, input }, signal);
        return { content: result.content, isError: !!result.is_error };
      }),
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
    await runtime.send({
      id: options.messageId,
      prompt: options.prompt,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      images: options.images,
    });
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
