import { JIRA_API_ENDPOINT } from './connections-gateway.js';
import { HOST_TOOL_INSTRUCTIONS } from './session-permission-policy.js';
import { createNativeHooks } from './native-hooks.js';
import { requestCodexUserInput } from './codex-user-input.js';
import { loadAccountProfiles } from './account-profiles.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { codexPrivateDirectory } from './codex-private-path.js';
import type { AccountBinding, ProviderAttemptToken } from '@mitzo/protocol';
import { buildPermissionHandler, type ManagedSession, type SessionRegistry } from '@mitzo/harness';
import { connectCodexMcpTools } from './codex-mcp-tools.js';
import { AsyncQueue } from './async-queue.js';
import {
  CodexAppServerClient,
  CodexRequestError,
  SUPPORTED_CODEX_CLI_VERSION,
} from './codex-app-server-client.js';
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
import { sharedOpenShellLifecycleCoordinator } from './openshell-lifecycle.js';
import {
  registerOpenShellLifecycle,
  registerOpenShellLifecycleProvisional,
  restoreOpenShellLifecycleIfNeeded,
  touchOpenShellLifecycle,
  markOpenShellLifecycleIdle,
} from './openshell-lifecycle-controller.js';
import { requestedIntegrationProviders } from './integration-intent.js';
import { createLogger } from './logger.js';
import { providerFailureTelemetry, ProviderFailureError } from './provider-failure.js';
import type { EventStore } from './event-store.js';
import { codexRolloverHistory } from './codex-rollover-context.js';
import type { ProviderDispatchAdmission } from './provider-execution.js';
import { INTERNAL_TOKEN } from './internal-token.js';
import { localHttpBaseUrl, localServerUsesTls } from './local-server-url.js';
import {
  executeTelosCreateOutcome,
  telosCreateOutcomeDefinition,
  TelosOutcomeInput,
  TELOS_CREATE_OUTCOME_TOOL,
} from './telos-tool.js';

const runtimes = new WeakMap<ManagedSession, CodexConversation>();
interface PendingProviderAdmission {
  admission: ProviderDispatchAdmission;
  eventStore: EventStore;
  attempt?: ProviderAttemptToken;
}
const pendingAdmissions = new WeakMap<ManagedSession, Map<string, PendingProviderAdmission>>();
const log = createLogger('codex-chat-session');
const GRANT_INTEGRATION_TOOL = 'GrantIntegrationAccess';
const INTEGRATION_PROVIDER_LABELS: Record<string, string> = {
  'google-workspace': 'Google Workspace',
  github: 'GitHub',
};

function grantIntegrationTools(providers: string[]) {
  if (!providers.length) return [];
  return [
    {
      name: GRANT_INTEGRATION_TOOL,
      description:
        'Attach one administrator-reviewed integration provider to this conversation sandbox after explicit Mitzo approval. Call this before using a service that is not already attached, including before gws, Gmail, Drive, Docs, Sheets, or Calendar access. This does not change OAuth consent.',
      input_schema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            enum: providers,
            description: 'The reviewed integration provider to attach to this chat.',
          },
        },
        required: ['provider'],
        additionalProperties: false,
      },
    },
  ];
}
/** Only transport safe, stable runtime diagnostics to the client. */
export function publicCodexRuntimeError(error: Error): string {
  if (error instanceof ProviderFailureError) return error.failure.message;
  const message = error.message;
  if (
    message ===
      'OpenShell denied the provider request because its credential-bearing body could not be inspected.' ||
    message === 'The provider stream disconnected before completion.' ||
    message === 'The provider rejected the turn because its context is too large.' ||
    message === 'The provider request timed out.'
  )
    return message;
  return 'Codex turn failed. Inspect queued work before retrying.';
}
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
export function trackCodexProviderAdmission(
  session: ManagedSession,
  messageId: string,
  admission: ProviderDispatchAdmission,
  eventStore: EventStore,
): void {
  let pending = pendingAdmissions.get(session);
  if (!pending) {
    pending = new Map();
    pendingAdmissions.set(session, pending);
  }
  pending.set(messageId, { admission, eventStore });
}

function beginTrackedProviderAttempt(session: ManagedSession, messageId: string): void {
  const pending = pendingAdmissions.get(session)?.get(messageId);
  if (!pending || pending.attempt) return;
  const attempt = pending.eventStore.beginProviderAttempt(
    pending.admission.token,
    pending.admission.providerAttemptId,
  );
  if (attempt.duplicate) throw new Error('Closeout provider attempt was already dispatched');
  pending.attempt = attempt.token;
}

function finishTrackedProviderAttempt(
  session: ManagedSession,
  messageId: string,
  status: 'completed' | 'interrupted' | 'failed',
): void {
  const tracked = pendingAdmissions.get(session)?.get(messageId);
  if (!tracked) return;
  const providerReason =
    status === 'completed' ? 'completed' : status === 'interrupted' ? 'cancelled' : 'ambiguous';
  const executionReason =
    status === 'completed' ? 'completed' : status === 'interrupted' ? 'interrupted' : 'failed';
  if (tracked.attempt)
    tracked.eventStore.transitionProviderAttempt(tracked.attempt, 'TERMINAL', providerReason);
  tracked.eventStore.transitionExecution(tracked.admission.token, 'TERMINAL', executionReason);
  pendingAdmissions.get(session)?.delete(messageId);
}

function cancelTrackedProviderAdmissions(session: ManagedSession): void {
  for (const messageId of pendingAdmissions.get(session)?.keys() ?? [])
    finishTrackedProviderAttempt(session, messageId, 'interrupted');
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
export function readCodexQueueOverview(conversationId: string, binding: AccountBinding) {
  return store().queueOverview(conversationId, binding);
}
export function cancelCodexQueuedCommand(
  conversationId: string,
  binding: AccountBinding,
  commandId: string,
  session?: ManagedSession,
) {
  // Verify the persisted binding even when the live runtime is available.
  store().read(conversationId, binding);
  const live = session ? getCodexRuntime(session) : undefined;
  return live
    ? live.cancelQueued(commandId)
    : store().cancelQueued(conversationId, binding, commandId);
}
export function readCodexQueue(
  conversationId: string,
  binding: AccountBinding,
  session?: ManagedSession,
) {
  if (binding.provider !== 'openai-codex' && binding.provider !== 'openai') return undefined;
  try {
    const live = session ? getCodexRuntime(session) : undefined;
    const summary = store().queueSummary(conversationId, binding);
    return {
      model: summary.model,
      reasoningEffort: summary.reasoningEffort,
      paused: live?.isPaused() ?? true,
      connected: !!live,
      recovering: live?.isRecovering() ?? false,
      recoveryPhase: live?.getRecoveryPhase(),
      queued: summary.queued,
      interrupted: summary.interrupted,
      failed: summary.failed,
      retryAvailableAt: summary.retryAvailableAt,
      retryable: summary.retryable,
      requiresRetryConfirmation: summary.requiresRetryConfirmation,
    };
  } catch {
    return {
      paused: true,
      connected: false,
      recovering: false,
      queued: 0,
      interrupted: 0,
      failed: 0,
    };
  }
}
/** Authoritative lifecycle snapshot. Errors deliberately escape to the caller,
 * where they become a preservation blocker. */
export function readCodexLifecycleQueue(conversationId: string, binding: AccountBinding) {
  return store().lifecycleQueue(conversationId, binding);
}
interface Options {
  resume?: boolean;
  conversationId: string;
  binding: AccountBinding;
  profile: CodexAccountProfile;
  session: ManagedSession;
  registry: SessionRegistry;
  prompt: string;
  intent?: string;
  model?: string;
  reasoningEffort?: string | null;
  images?: Array<{ data: string; mediaType: string }>;
  messageId: string;
  systemPrompt: string;
  env: Record<string, string>;
  mcpServers: Record<string, McpServerConfig>;
  eventStore: EventStore;
  onDemandCreate?: NativeToolOptions['onDemandCreate'];
  onBootContext?: (context: OpenShellBootContext) => void;
  /** Recreate the provider runtime without admitting or replaying user intent. */
  reattachOnly?: boolean;
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
  const startupReservation = runtimeManager
    ? await sharedOpenShellLifecycleCoordinator.reserve(options.conversationId)
    : undefined;
  let managedOpenShell;
  try {
    managedOpenShell = runtimeManager
      ? await runtimeManager.ensure(options.conversationId, options.session.abortController.signal)
      : undefined;
  } catch (error) {
    startupReservation?.();
    throw error;
  }
  const signal = options.session.abortController.signal;
  try {
    if (runtimeManager && managedOpenShell) {
      // A resumed conversation must validate its durable recovery record before
      // a first-launch provisional row can make a missing record look valid.
      await restoreOpenShellLifecycleIfNeeded(
        options.conversationId,
        managedOpenShell,
        signal,
        options.binding,
        selectedOpenShellAccountRoute(options),
        !!options.resume,
      );
      registerOpenShellLifecycleProvisional(
        options.conversationId,
        managedOpenShell,
        selectedOpenShellAccountRoute(options),
        options.registry.findBySessionId(options.conversationId)?.clientId,
      );
    }
  } catch (error) {
    startupReservation?.();
    throw error;
  }
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
            JIRA_URL: JIRA_API_ENDPOINT as typeof JIRA_API_ENDPOINT,
            JIRA_EMAIL: managedConnection.submittedEmail,
          },
        }
      : openShell;
  const grantableProviders = runtimeManager ? configuredRuntime!.grantableServiceProviders : [];
  const integrationTools = grantIntegrationTools(grantableProviders);
  const openShellHostTools = connectedOpenShell
    ? [telosCreateOutcomeDefinition, ...integrationTools]
    : [];
  let integrationTurn:
    | {
        id: string;
        denied: Set<string>;
        pending: Map<string, Promise<{ content: string; isError: boolean }>>;
      }
    | undefined;
  const requestIntegrationAccess = async (
    provider: string,
    signal: AbortSignal,
    controlPlane = false,
  ) => {
    // A cancelled approval can settle after the next queued turn has started.
    // Keep all coalescing and denial state bound to the initiating turn.
    const turn = integrationTurn;
    if (
      !openShell ||
      !runtimeManager ||
      !managedOpenShell ||
      !grantableProviders.includes(provider)
    )
      return { content: 'Integration provider is not grantable', isError: true };
    if (turn?.denied.has(provider))
      return {
        content: `Integration provider ${provider} was denied for this turn`,
        isError: true,
      };
    const pending = turn?.pending.get(provider);
    if (pending) return pending;
    const request = requestIntegrationAccessInner(provider, signal, turn, controlPlane);
    turn?.pending.set(provider, request);
    try {
      return await request;
    } finally {
      turn?.pending.delete(provider);
    }
  };
  const requestIntegrationAccessInner = async (
    provider: string,
    signal: AbortSignal,
    turn: typeof integrationTurn,
    controlPlane: boolean,
  ) => {
    if (!runtimeManager || !managedOpenShell)
      return { content: 'Integration provider is not grantable', isError: true };
    const access = await runtimeManager.hasServiceProviderAccess(
      options.conversationId,
      managedOpenShell,
      provider,
      signal,
    );
    if (access.state === 'available')
      return {
        content: `Integration provider ${provider} is already available to this chat`,
        isError: false,
      };
    if (access.state === 'indeterminate') throw access.error;
    const providerLabel = INTEGRATION_PROVIDER_LABELS[provider] ?? provider;
    const attachApprovedProvider = async () => {
      try {
        await runtimeManager.grantServiceProvider(
          options.conversationId,
          managedOpenShell,
          provider,
          signal,
        );
      } catch {
        signal.throwIfAborted();
        return false;
      }
      return true;
    };
    if (access.state === 'approved-detached') {
      if (!(await attachApprovedProvider()))
        return { content: 'Integration provider attachment failed', isError: true };
      return {
        content: `Integration provider ${provider} is now available to this chat`,
        isError: false,
      };
    }
    const approvedInput = { provider };
    const owner = options.registry.findBySessionId(options.conversationId);
    if (!owner) return { content: 'Codex session unavailable', isError: true };
    const decision = await buildPermissionHandler(owner.clientId, options.registry, {
      onDemandCreate: options.onDemandCreate,
    })(GRANT_INTEGRATION_TOOL, approvedInput, {
      signal,
      toolUseID: randomUUID(),
      forcePrompt: true,
      approvalScope: 'conversation',
      controlPlane,
      title: `Grant ${providerLabel} to this conversation?`,
      description: `This attaches the reviewed ${providerLabel} provider to the retained conversation sandbox across reconnects and Mitzo restarts, until the sandbox is deleted or access is revoked. It does not request or change external account consent.`,
    });
    signal.throwIfAborted();
    if (decision.behavior !== 'allow') {
      turn?.denied.add(provider);
      return { content: decision.message, isError: true };
    }
    if (!isDeepStrictEqual(decision.updatedInput, approvedInput))
      return { content: 'Provider grant changed during approval; retry', isError: true };
    if (!(await attachApprovedProvider()))
      return { content: 'Integration provider attachment failed', isError: true };
    return {
      content: `Integration provider ${provider} is now available to this chat`,
      isError: false,
    };
  };
  try {
    signal.throwIfAborted();
  } catch (error) {
    startupReservation?.();
    throw error;
  }
  let privateStorage: CodexConversationStore;
  try {
    privateStorage = store();
  } catch (error) {
    startupReservation?.();
    throw error;
  }
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
    startupReservation?.();
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
        startupReservation?.();
        throw error;
      });
  const events = new AsyncQueue<Record<string, unknown>>();
  let closed = false;
  function finish() {
    if (closed) return;
    closed = true;
    cancelTrackedProviderAdmissions(options.session);
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
    webSearchBackend: openShell ? 'openshell' : 'host',
    webSearchDeploymentRevision: openShell
      ? 'openshell-runtime-config-v1'
      : `codex-cli:${SUPPORTED_CODEX_CLI_VERSION}`,
    getMode: () => options.session.mode,
    systemPrompt:
      options.systemPrompt +
      (connectedOpenShell
        ? `\nOpenShell contains the provider loop and its built-in tools. Use those tools directly inside the supplied sandbox workspace. Current Mitzo mode: ${options.session.mode}. In Agent or Auto mode, a user request to edit that workspace is the required approval: execute it without asking again. Use ${TELOS_CREATE_OUTCOME_TOOL} for durable Telos capture; never use a sandbox-local todo script for persistent Telos work.${integrationTools.length ? ` Mitzo preflights explicit requests for grantable integrations before the turn begins. If you discover that you need a grantable service which the user did not request explicitly, call ${GRANT_INTEGRATION_TOOL} before using it. A CLI being installed does not mean its provider is attached, and a tunnel error from an unattached provider is not evidence of a gateway outage.` : ''}\n`
        : HOST_TOOL_INSTRUCTIONS) +
      (managedConnection
        ? '\nThis sandbox has verified read-only Jira access to https://redhat.atlassian.net. Use the scoped API base in JIRA_URL (not the browser site URL). Use the provider-approved /usr/bin/python3 or curl with JIRA_URL, JIRA_EMAIL, and the gateway-managed JIRA_API_TOKEN placeholder for Basic authorization. Never print credential values. Writes are denied by the gateway policy.\n'
        : '') +
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
            await sharedOpenShellLifecycleCoordinator.admit(options.conversationId, async () => {
              const recovered = await runtimeManager.ensure(options.conversationId, signal);
              await restoreOpenShellLifecycleIfNeeded(
                options.conversationId,
                recovered,
                signal,
                options.binding,
                selectedOpenShellAccountRoute(options),
                true,
              );
              Object.assign(managedOpenShell!, recovered);
            });
          },
        }
      : {}),
    validateModel: (model, reasoningEffort) => {
      loadAccountProfiles().validateModel(options.binding, model, reasoningEffort);
    },
    tools: connectedOpenShell ? openShellHostTools : [...nativeToolDefinitions, ...mcp.definitions],
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
    onProviderDispatch: (messageId) => beginTrackedProviderAttempt(options.session, messageId),
    onProviderComplete: (messageId, status) =>
      finishTrackedProviderAttempt(options.session, messageId, status),
    loadConversationHistory: () => codexRolloverHistory(options.eventStore, options.conversationId),
    onClosed: () => {
      if (runtimeManager) markOpenShellLifecycleIdle(options.conversationId);
      finish();
    },
    requestUserInput: async (params, signal) => {
      const owner = options.registry.findBySessionId(options.conversationId);
      if (!owner) throw new Error('Codex session unavailable');
      return requestCodexUserInput(params, signal, owner.clientId, options.registry);
    },
    ...(openShell && runtimeManager && managedOpenShell && grantableProviders.length
      ? {
          prepareTurn: async ({ providerPrompt, userIntent, turnId }, signal: AbortSignal) => {
            integrationTurn = { id: turnId, denied: new Set(), pending: new Map() };
            // Older persisted commands did not retain separate raw intent. Do
            // not infer approval from their assembled provider prompt.
            const rawUserIntent = userIntent ?? '';
            for (const provider of requestedIntegrationProviders(
              rawUserIntent,
              grantableProviders,
            )) {
              const access = await runtimeManager.hasServiceProviderAccess(
                options.conversationId,
                managedOpenShell,
                provider,
                signal,
              );
              if (access.state === 'available') continue;
              if (access.state === 'indeterminate') throw access.error;
              const providerLabel = INTEGRATION_PROVIDER_LABELS[provider] ?? provider;
              const result = await requestIntegrationAccess(provider, signal, true);
              if (result.isError)
                return `${providerPrompt}\n\n[Mitzo did not enable ${providerLabel} for this turn. Do not run its CLI or claim a gateway outage; explain that this chat does not have access.]`;
            }
          },
        }
      : {}),
    executeTool: async (name, input, signal) => {
      if (connectedOpenShell && name === TELOS_CREATE_OUTCOME_TOOL) {
        const parsed = TelosOutcomeInput.safeParse(input);
        if (!parsed.success) return { content: 'Invalid Telos outcome input', isError: true };
        const owner = options.registry.findBySessionId(options.conversationId);
        if (!owner) return { content: 'Codex session unavailable', isError: true };
        const permission = await buildPermissionHandler(owner.clientId, options.registry, {
          onDemandCreate: options.onDemandCreate,
        })(name, parsed.data, {
          signal,
          toolUseID: randomUUID(),
          forcePrompt: true,
          title: 'Create this outcome in live Telos?',
          description:
            'This writes the approved outcome and milestones to the host Telos store linked to this Mitzo session.',
        });
        signal.throwIfAborted();
        if (permission.behavior !== 'allow') return { content: permission.message, isError: true };
        if (!isDeepStrictEqual(permission.updatedInput, parsed.data))
          return { content: 'Telos input changed during approval; retry the tool', isError: true };
        if (options.registry.findBySessionId(options.conversationId)?.clientId !== owner.clientId)
          return { content: 'Session permissions changed; retry the tool', isError: true };
        const port = Number.parseInt(process.env.PORT || '3100', 10);
        return executeTelosCreateOutcome(
          localHttpBaseUrl(port, localServerUsesTls()),
          owner.clientId,
          INTERNAL_TOKEN,
          parsed.data,
          signal,
        );
      }
      if (openShell && runtimeManager && managedOpenShell && name === GRANT_INTEGRATION_TOOL) {
        const provider = typeof input.provider === 'string' ? input.provider : '';
        return requestIntegrationAccess(provider, signal);
      }
      return (
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
        }) ?? Promise.reject(new Error('Host tools are unavailable inside OpenShell'))
      );
    },
    onQueueChange: () => {
      const message = {
        type: 'codex_queue',
        sessionId: options.conversationId,
        items: runtime.queue().map(({ id, status }) => ({ id, status })),
      };
      if (options.session.transport?.isOpen()) options.session.transport.send(message);
    },
    ...(runtimeManager
      ? {
          onActivity: () => touchOpenShellLifecycle(options.conversationId),
          onThreadChanged: (threadId: string) => {
            registerOpenShellLifecycle(
              options.conversationId,
              managedOpenShell!,
              options.binding,
              selectedOpenShellAccountRoute(options),
              threadId,
              options.registry.findBySessionId(options.conversationId)?.clientId,
            );
          },
        }
      : {}),
    onError: (error) => {
      log.warn('Codex runtime reported an error', {
        conversationId: options.conversationId,
        ...(error instanceof CodexRequestError
          ? {
              requestMethod: error.method,
              requestErrorCategory: error.category,
              ...(error.code === undefined ? {} : { requestErrorCode: error.code }),
            }
          : {}),
        ...(error instanceof ProviderFailureError ? providerFailureTelemetry(error.failure) : {}),
        error: publicCodexRuntimeError(error),
      });
      // Failed provider turns are emitted by the query loop as durable v2 error
      // events. Sending here would race replay and show the same failure twice.
      if (!(error instanceof ProviderFailureError) && options.session.transport?.isOpen())
        options.session.transport.send({
          type: 'error',
          sessionId: options.conversationId,
          error: publicCodexRuntimeError(error),
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
    if (runtimeManager && managedOpenShell) {
      const threadId = runtime.getThreadId();
      if (!threadId) throw new Error('OpenShell provider thread was not initialized');
      registerOpenShellLifecycle(
        options.conversationId,
        managedOpenShell,
        options.binding,
        selectedOpenShellAccountRoute(options),
        threadId,
        options.registry.findBySessionId(options.conversationId)?.clientId,
      );
    }
    signal.throwIfAborted();
    runtimes.set(options.session, runtime);
    if (!options.reattachOnly)
      await runtime.send({
        id: options.messageId,
        prompt: options.prompt,
        intent: options.intent,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        images: options.images,
      });
  } catch (error) {
    close();
    throw error;
  } finally {
    startupReservation?.();
  }
  return {
    [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
    setPermissionMode: async (mode: ManagedSession['mode']) => {
      if (openShell && mode === 'ask')
        throw new Error(
          'OpenShell native tools do not yet support Mitzo Ask mode; select Agent or Auto mode.',
        );
      runtime.assertPermissionModeChange(mode);
    },
    setWebSearchGrant: (expectedRevision: number, grant: 'allowed' | 'denied') =>
      runtime.setWebSearchGrant(expectedRevision, grant),
    getWebSearchGrant: () => runtime.getWebSearchGrant(),
    canSetWebSearchGrant: () => runtime.canSetWebSearchGrant(),
    interrupt: () => runtime.interrupt(),
    close,
    stopTask: async () => {
      throw new Error('Codex subagents are unavailable');
    },
  };
}
