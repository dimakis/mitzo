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
import {
  OpenShellRuntimeManager,
  openShellCodexRuntimeConfig,
  openShellRuntimeConfig,
  type OpenShellAccountRoute,
  type OpenShellBootContext,
} from './openshell-runtime.js';
import type { Connection } from './connections-store.js';
import { getConnectionsRuntime } from './connections-runtime.js';

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
export async function waitForCodexRuntime(
  session: ManagedSession,
  timeoutMs = 5000,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + timeoutMs;
  let runtime = getCodexRuntime(session);
  while (!runtime && Date.now() < deadline && !signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (signal?.aborted) break;
    runtime = getCodexRuntime(session);
  }
  return runtime;
}
export async function waitForCodexRuntimeBySessionId(
  registry: SessionRegistry,
  sessionId: string,
  timeoutMs = 5000,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + timeoutMs;
  let session = registry.findBySessionId(sessionId)?.session;
  let runtime = session ? getCodexRuntime(session) : undefined;
  while (!runtime && Date.now() < deadline && !signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (signal?.aborted) break;
    session = registry.findBySessionId(sessionId)?.session;
    runtime = session ? getCodexRuntime(session) : undefined;
  }
  return runtime;
}
export function readCodexQueue(
  conversationId: string,
  binding: AccountBinding,
  session?: ManagedSession,
) {
  if (binding.provider !== 'openai-codex' && binding.provider !== 'openai') return undefined;
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
  reasoningEffort?: string | null;
  images?: Array<{ data: string; mediaType: string }>;
  messageId: string;
  systemPrompt: string;
  env: Record<string, string>;
  mcpServers: Record<string, McpServerConfig>;
  onDemandCreate?: NativeToolOptions['onDemandCreate'];
  onBootContext?: (context: OpenShellBootContext) => void;
}

export function selectedOpenShellAccountRoute(
  options: Pick<Options, 'binding' | 'model' | 'profile'>,
): OpenShellAccountRoute {
  const model = options.model ?? options.binding.model;
  const provider = options.profile.sandboxProvider!;
  if (options.profile.planType === 'api') return { kind: 'api', provider, model };
  return {
    kind: 'chatgpt-subscription',
    provider,
    providerType: options.profile.sandboxProviderType!,
    providerId: options.profile.sandboxProviderId!,
    grantId: options.profile.sandboxGrantId!,
    model,
  };
}
/** Shared chat adapter. Execution remains gated by the account catalog and unsupported capabilities fail explicitly. */
export async function openCodexChat(options: Options) {
  const service = getConnectionsRuntime()?.service;
  if (service && openShellRuntimeConfig(process.env))
    return service.withAccountRuntime(
      options.binding.accountId,
      (connection) => openCodexChatBound(options, connection),
      options.session.abortController.signal,
    );
  return openCodexChatBound(options, null);
}
async function openCodexChatBound(options: Options, managedConnection: Connection | null) {
  const configuredRuntime = openShellRuntimeConfig(process.env);
  const connectionService = getConnectionsRuntime()?.service;
  const openShellName = process.env.MITZO_OPENSHELL_SANDBOX_NAME;
  if (openShellName && process.env.NODE_ENV === 'production')
    throw new Error('Legacy shared OpenShell sandboxes are disabled in production.');
  const accountProvider = options.profile.sandboxProvider;
  const openShellRequested = !!configuredRuntime || !!openShellName;
  if (!openShellRequested && !options.profile.credentialRef)
    throw new Error('ChatGPT host execution requires an explicit login binding.');
  const brokeredSubscription =
    options.profile.planType !== 'api' &&
    options.profile.sandboxProviderType === 'openai-codex-oauth' &&
    !!options.profile.sandboxProviderId &&
    !!options.profile.sandboxGrantId;
  if (openShellRequested && options.profile.planType !== 'api' && !brokeredSubscription)
    throw new Error('ChatGPT subscription requires a complete brokered Codex OAuth binding.');
  if (configuredRuntime && !accountProvider)
    throw new Error('OpenShell API accounts require an explicit sandbox provider binding.');
  if (openShellRequested && options.session.mode === 'ask')
    throw new Error(
      'OpenShell native tools do not yet support Mitzo Ask mode; select Agent or Auto mode.',
    );
  const runtimeManager = configuredRuntime
    ? new OpenShellRuntimeManager({
        ...configuredRuntime,
        serviceProviders: managedConnection
          ? [...configuredRuntime.serviceProviders, managedConnection.gatewayProviderName]
          : configuredRuntime.serviceProviders,
        account: selectedOpenShellAccountRoute(options),
        connectionAccountId: options.binding.accountId,
        enforceConnectionAttachments: !connectionService,
        verifyConnections: connectionService
          ? (name, signal) =>
              connectionService.verifyRuntimeSandbox(name, managedConnection, signal)
          : undefined,
      })
    : undefined;
  const managedOpenShell = runtimeManager
    ? await runtimeManager.ensure(options.conversationId, options.session.abortController.signal)
    : undefined;
  const openShell =
    managedOpenShell ??
    (openShellName
      ? {
          sandboxName: openShellName,
          workdir: process.env.MITZO_OPENSHELL_WORKDIR || '/sandbox/workspaces/mgmt',
        }
      : undefined);
  const connectedOpenShell =
    openShell && managedConnection
      ? {
          ...openShell,
          connectionEnv: {
            JIRA_URL: 'https://redhat.atlassian.net' as const,
            JIRA_EMAIL: managedConnection.submittedEmail,
          },
        }
      : openShell;
  const signal = options.session.abortController.signal;
  signal.throwIfAborted();
  const privateStorage = store();
  const hookRuntime = connectedOpenShell
    ? undefined
    : createNativeHooks(options.session.cwd!, options.conversationId, options.env, {
        trustProjectHooks: process.env.MITZO_TRUST_PROJECT_HOOKS === '1',
      });
  const hooks = hookRuntime?.hooks;
  const dispose = hookRuntime?.dispose ?? (() => {});
  let startup: { context?: string };
  try {
    if (runtimeManager) {
      const context = await runtimeManager.compileContext(managedOpenShell!, signal);
      options.onBootContext?.(context);
      startup = { context: context.fullMarkdown };
    } else {
      startup = hooks
        ? await hooks.run('SessionStart', { source: options.resume ? 'resume' : 'startup' }, signal)
        : {};
    }
  } catch (error) {
    dispose();
    throw error;
  }
  const mcp = connectedOpenShell
    ? {
        definitions: [],
        displayName: (name: string) => name,
        close: async () => {},
        execute: async () => {
          throw new Error('Host MCP tools are unavailable inside OpenShell');
        },
      }
    : await connectCodexMcpTools(options.mcpServers, {
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
    if (hooks)
      void hooks
        .run('SessionEnd', { reason: 'other' }, AbortSignal.timeout(5000))
        .catch(() => {})
        .finally(dispose);
    else dispose();
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
      (connectedOpenShell
        ? `\nOpenShell contains the provider loop and its built-in tools. Use those tools directly inside the supplied sandbox workspace. Current Mitzo mode: ${options.session.mode}. In Agent or Auto mode, a user request to edit that workspace is the required approval: execute it without asking again.\n`
        : HOST_TOOL_INSTRUCTIONS) +
      (startup.context ? `\n\n${startup.context}` : ''),
    beforeComplete: async (signal) => {
      await hooks?.run('Stop', { stop_hook_active: false }, signal);
    },
    ...(runtimeManager
      ? {
          reconnectGuard: connectionService
            ? (work: () => Promise<void>) =>
                connectionService.withAccountRuntime(
                  options.binding.accountId,
                  async (current) => {
                    if (
                      current?.id !== managedConnection?.id ||
                      current?.gatewayProviderId !== managedConnection?.gatewayProviderId
                    )
                      throw new Error('Connection permissions changed. Start a new conversation.');
                    await work();
                  },
                  signal,
                )
            : undefined,
          beforeReconnect: async () => {
            await runtimeManager.ensure(options.conversationId, signal);
          },
        }
      : {}),
    validateModel: (model, reasoningEffort) => {
      loadAccountProfiles().validateModel(options.binding, model, reasoningEffort);
    },
    tools: connectedOpenShell ? [] : [...nativeToolDefinitions, ...mcp.definitions],
    displayToolName: mcp.displayName,
    createClient: (callbacks) =>
      connectedOpenShell
        ? CodexAppServerClient.launchOpenShell(connectedOpenShell, process.env, callbacks)
        : CodexAppServerClient.launch(options.profile.credentialRef!, process.env, callbacks),
    ...(openShell
      ? {
          runtimeCwd: openShell.workdir,
          modelProvider: 'openshell',
          runtimeConfig: managedOpenShell
            ? openShellCodexRuntimeConfig(configuredRuntime!, options.mcpServers)
            : { web_search: 'disabled' },
          turnSandboxPolicy: { type: 'externalSandbox', networkAccess: 'restricted' },
          verifyBinding: async () => options.binding,
        }
      : {}),
    emit: (event) => events.push(event),
    onClosed: finish,
    requestUserInput: async (params, signal) => {
      const owner = options.registry.findBySessionId(options.conversationId);
      if (!owner) throw new Error('Codex session unavailable');
      return requestCodexUserInput(params, signal, owner.clientId, options.registry);
    },
    executeTool: async (name, input, signal) =>
      hooks?.executeTool(mcp.displayName(name), input, signal, async (input, forcePrompt) => {
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
      }) ?? Promise.reject(new Error('Host tools are unavailable inside OpenShell')),
    onQueueChange: () => {
      const message = {
        type: 'codex_queue',
        sessionId: options.conversationId,
        items: runtime.queue().map(({ id, status }) => ({ id, status })),
      };
      if (options.session.transport?.isOpen()) options.session.transport.send(message);
    },
    onError: (error) => {
      if (options.session.transport?.isOpen())
        options.session.transport.send({
          type: 'error',
          sessionId: options.conversationId,
          error: `Codex turn failed: ${error.message}`,
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
    setPermissionMode: async (mode: ManagedSession['mode']) => {
      if (openShell && mode === 'ask')
        throw new Error(
          'OpenShell native tools do not yet support Mitzo Ask mode; select Agent or Auto mode.',
        );
    },
    interrupt: () => runtime.interrupt(),
    close,
    stopTask: async () => {
      throw new Error('Codex subagents are unavailable');
    },
  };
}
