import type { RepositoryChatWorkspace } from './repository-chat-startup.js';
import { getRepositoryWorkspaces } from './repository-workspace-runtime.js';
import {
  sessionCredentialTools,
  CONNECTION_TOOL_INSTRUCTIONS,
} from './session-credential-tools.js';
import {
  createGithubPublishingTool,
  githubPublishingDefinition,
  GITHUB_PUBLISHING_INSTRUCTIONS,
  REQUEST_GITHUB_PUBLISH,
  hostGithubPublishingSource,
} from './github-publishing-tool.js';
import { KnowledgePublicationUnavailableError } from './knowledge-publication-bridge.js';
import { prepareRetainedRuntimeMigration } from './openshell-runtime-migration-adapter.js';
import {
  executeTelosArtifactTool,
  isTelosArtifactTool,
  telosArtifactDefinitions,
  telosArtifactSchemas,
  telosArtifactInstructions,
} from './telos-artifact-tools.js';
import { requireCustodianOrdinaryRuntime } from './custodian-ordinary-runtime.js';
import { custodianControllerMode, custodianOwnerMode } from './symposium-custodian-mode.js';
import { JIRA_API_ENDPOINT } from './connections-gateway.js';
import { HOST_TOOL_INSTRUCTIONS } from './session-permission-policy.js';
import { createNativeHooks } from './native-hooks.js';
import { requestCodexUserInput } from './codex-user-input.js';
import { loadAccountProfiles } from './account-profiles.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { codexPrivateDirectory } from './codex-private-path.js';
import type { AccountBinding, ProviderAttemptToken } from '@mitzo/protocol';
import type { AgentLibraryVersion, AgentContextSnapshot } from '@mitzo/protocol';
import {
  resolveSandboxAgentContext,
  SandboxAgentContextAdmissionError,
  sandboxAgentContextAdmissionFailure,
} from './agent-context-sandbox.js';
import { contextDigest } from './agent-context-compiler.js';
import { buildPermissionHandler, type ManagedSession, type SessionRegistry } from '@mitzo/harness';
import {
  webAccessDefinition,
  REQUEST_WEB_ACCESS,
  WEB_ACCESS_INSTRUCTIONS,
} from './request-web-access.js';
import { createWebAccessTool } from './web-access-tool.js';
import { connectCodexMcpTools } from './codex-mcp-tools.js';
import { AsyncQueue } from './async-queue.js';
import { CodexAppServerClient, SUPPORTED_CODEX_CLI_VERSION } from './codex-app-server-client.js';
import { CodexConversation } from './codex-conversation.js';
import {
  CodexConversationStore,
  type KnowledgeAdoptionSelection,
} from './codex-conversation-store.js';
import type { CodexAccountProfile } from './codex-account.js';
import {
  createNativeToolExecutor,
  nativeToolDefinitions,
  type NativeToolOptions,
} from './native-tool-executor.js';
import type { McpServerConfig } from './mcp-config.js';
import {
  OpenShellRuntimeManager,
  sandboxNameForConversation,
  openShellCodexRuntimeConfig,
  openShellRuntimeConfig,
  type OpenShellAccountRoute,
  type OpenShellRuntime,
  type OpenShellBootContext,
} from './openshell-runtime.js';
import type { Connection } from './connections-store.js';
import { getConnectionsRuntime } from './connections-runtime.js';
import { connectionTemplateRegistry } from './connections/registry.js';
import { capabilityApprovalForConversation } from './connections/capabilities/approval.js';
import {
  bindLiveCapabilityConversation,
  getLiveCapabilityConversationBinding,
  clearLiveCapabilityConversationBinding,
} from './capability-conversation-binding.js';
import { sharedOpenShellLifecycleCoordinator } from './openshell-lifecycle.js';
import {
  registerOpenShellLifecycle,
  registerMigratedOpenShellLifecycle,
  registerOpenShellLifecycleProvisional,
  restoreOpenShellLifecycleIfNeeded,
  touchOpenShellLifecycle,
  markOpenShellLifecycleIdle,
} from './openshell-lifecycle-controller.js';
import { requestedIntegrationProviders } from './integration-intent.js';
import { createLogger } from './logger.js';
import { canonicalJson } from './connections/capabilities/input-validation.js';
import { ProviderFailureError } from './provider-failure.js';
import { codexRuntimeDiagnostic, codexRuntimeErrorTelemetry } from './codex-runtime-diagnostics.js';
import { CodexStartupError, duringCodexStartup } from './codex-startup-error.js';
import type { EventStore } from './event-store.js';
import { codexRolloverHistory, codexRolloverSources } from './codex-rollover-context.js';
import type { ProviderDispatchAdmission } from './provider-execution.js';
import { INTERNAL_TOKEN } from './internal-token.js';
import { localHttpBaseUrl, localServerUsesTls } from './local-server-url.js';
import {
  executeTelosCreateOutcome,
  telosCreateOutcomeDefinition,
  TelosOutcomeInput,
  TELOS_CREATE_OUTCOME_TOOL,
} from './telos-tool.js';
import { SymposiumProfileProposalStore } from './symposium-profile-proposals.js';
import {
  proposeProfileFromTool,
  symposiumProposeProfileDefinition,
  SYMPOSIUM_PROPOSE_PROFILE_TOOL,
} from './symposium-profile-tool.js';

/** Assigned GitHub connections replace the legacy credential fallback. Retained
 * runtimes supply only their already attached managed connections here. */
export function ordinaryRuntimeServiceProviders(
  configured: readonly string[],
  managed: readonly Pick<Connection, 'templateId' | 'gatewayProviderName'>[],
): string[] {
  const managedGithub = managed.some((connection) => connection.templateId === 'github-readonly');
  return [
    ...new Set([
      ...configured.filter((provider) => provider !== 'github' || !managedGithub),
      ...managed.map((connection) => connection.gatewayProviderName),
    ]),
  ];
}

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

function isValidEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

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

type CapabilityToolBinding = {
  capabilityId: string;
  capabilityVersion: number;
  connectionId: string;
  connectionRevision: number;
};

/** Provider call IDs are only unique within a provider turn/thread. */
export function capabilityIdempotencyKey(
  conversationId: string,
  binding: CapabilityToolBinding,
  call: { turnId: string },
  input: unknown,
): string {
  return createHash('sha256')
    .update(
      `${conversationId}\u0000${binding.connectionId}\u0000${binding.connectionRevision}\u0000${binding.capabilityId}\u0000${binding.capabilityVersion}\u0000${call.turnId}\u0000${canonicalJson(input)}`,
    )
    .digest('hex');
}

/** Dynamic definitions bind a reviewed grant at startup; model input never picks an account or grant. */
function capabilityToolsForConversation(
  accountId: string,
  managedConnection: Pick<Connection, 'id' | 'revision'> | null,
) {
  const capabilityService = getConnectionsRuntime()?.capabilities;
  const bindings = new Map<string, CapabilityToolBinding>();
  if (!capabilityService || !managedConnection)
    return { definitions: [], bindings, service: undefined };
  const definitions = capabilityService
    .eligibleToolsForManagedConnection(accountId, managedConnection)
    .flatMap((grant) => {
      const template = connectionTemplateRegistry.getCapabilityTemplate(
        grant.capabilityId,
        grant.capabilityVersion,
      );
      if (!template) return [];
      const name = `Capability_${grant.capabilityId.replace(/[^A-Za-z0-9_]/g, '_')}_${grant.connectionId.replace(/[^A-Za-z0-9_]/g, '_')}_v${grant.capabilityVersion}`;
      // The dynamic tool list is provider-controlled code, but still prevent a
      // malformed persisted connection id from creating an unsafe tool name.
      if (name.length > 120 || bindings.has(name)) return [];
      bindings.set(name, grant);
      return [
        {
          name,
          description: `${template.label}. This always opens a Mitzo approval card before execution.`,
          input_schema: template.inputSchema as unknown as Record<string, unknown>,
        },
      ];
    });
  return { definitions, bindings, service: capabilityService };
}
/** Only transport safe, stable runtime diagnostics to the client. */
export function publicCodexRuntimeError(error: Error): string {
  if (error instanceof SandboxAgentContextAdmissionError)
    return error.message + ' No provider turn was started.';
  if (error instanceof CodexStartupError) {
    let cause = error.cause;
    while (cause instanceof CodexStartupError) cause = cause.cause;
    const causeDetail = cause instanceof Error ? publicCodexRuntimeError(cause) : undefined;
    // A diagnostic from a preparation hook cannot prove dispatch never happened
    // once the native turn/start boundary was crossed.
    const detail =
      error.phase === 'initial_turn_dispatch'
        ? causeDetail?.replace(' No provider turn was started.', '')
        : causeDetail;
    const inferredMigration =
      error.phase !== 'runtime_admission' &&
      detail?.startsWith('Retained sandbox migration is blocked.');
    const explanation =
      error.resourceErrorCode() ||
      inferredMigration ||
      !detail ||
      detail === 'Codex turn failed. Inspect queued work before retrying.'
        ? undefined
        : detail;
    return `${error.publicMessage(explanation)} Reference: ${error.diagnosticId}`;
  }
  const diagnostic = codexRuntimeDiagnostic(error);
  if (diagnostic) return diagnostic;
  if (error instanceof KnowledgePublicationUnavailableError)
    return 'Knowledge publication is unavailable. Check the knowledge publisher before retrying. No provider turn was started.';
  if (
    /^(Retained migration|Migration |Runtime (source|image)|OpenShell migration|Runtime migration)/.test(
      error.message,
    ) ||
    /unsupported provider state|writer is still open|execution process is still running|no space left/i.test(
      error.message,
    )
  ) {
    const reason = /no space left|capacity|disk.*full/i.test(error.message)
      ? 'There is insufficient sandbox storage capacity.'
      : /unsupported provider state|supported contract/i.test(error.message)
        ? 'The source runtime or provider layout is not supported.'
        : /policy/i.test(error.message)
          ? 'The observed sandbox policy differs from the reviewed contract.'
          : /writer|execution|activity/i.test(error.message)
            ? 'Provider activity has not reached a verified idle boundary.'
            : /blocked; inspect/i.test(error.message)
              ? 'A preserved migration diagnostic requires inspection or its retry interval has not elapsed.'
              : 'Runtime identity or checkpoint verification has not completed.';
    return `Retained sandbox migration is blocked. ${reason} Its task files and provider thread are preserved.`;
  }

  if (error instanceof ProviderFailureError) return error.failure.message;
  if (error.message === 'Codex transport disconnected; recovery is available')
    return 'The Codex connection was interrupted. The turn outcome is unknown; inspect saved work before continuing.';
  const message = error.message;
  if (
    message ===
      'OpenShell denied the provider request because its credential-bearing body could not be inspected.' ||
    message === 'The provider stream disconnected before completion.' ||
    message === 'The provider rejected the turn because its context is too large.' ||
    message === 'The provider request timed out.' ||
    message === 'Connection permissions changed. Start a new conversation.'
  )
    return message;
  return 'Codex turn failed. Inspect queued work before retrying.';
}
export function publicCodexStartupError(error: Error): string {
  const diagnostic = publicCodexRuntimeError(error);
  return diagnostic === 'Codex turn failed. Inspect queued work before retrying.'
    ? 'Codex could not start this chat. Check runtime and account configuration before continuing.'
    : diagnostic;
}
let privateStore: CodexConversationStore | undefined;
function store() {
  if (!privateStore) {
    const dir = codexPrivateDirectory();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    privateStore = new CodexConversationStore(join(dir, 'conversations.db'), {
      requireOwner: custodianControllerMode || custodianOwnerMode,
    });
    if (!custodianOwnerMode)
      privateStore.recoverAtStartup(custodianControllerMode ? 'ordinary' : undefined);
  }
  return privateStore;
}
/** Reuse the private native command ledger for session-scoped Symposium threads. */
export function getCodexConversationStore(): CodexConversationStore {
  return store();
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
type CodexQueueStatus = Pick<
  ReturnType<CodexConversationStore['queueSummary']>,
  'queued' | 'interrupted' | 'failed'
> &
  Partial<
    Pick<
      ReturnType<CodexConversationStore['queueSummary']>,
      | 'model'
      | 'reasoningEffort'
      | 'retryAvailableAt'
      | 'retryable'
      | 'requiresRetryConfirmation'
      | 'capacityRecovery'
    >
  > & {
    paused: boolean;
    connected: boolean;
    recovering: boolean;
    recoveryPhase?: ReturnType<CodexConversation['getRecoveryPhase']>;
  };
export function readCodexQueue(
  conversationId: string,
  binding: AccountBinding,
  session?: ManagedSession,
): CodexQueueStatus | undefined {
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
      ...(summary.capacityRecovery ? { capacityRecovery: summary.capacityRecovery } : {}),
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
export function readCodexCapacityRecovery(conversationId: string, binding: AccountBinding) {
  return store().capacityRecovery(conversationId, binding);
}
export async function stopCodexCapacityRecovery(
  conversationId: string,
  binding: AccountBinding,
  recoveryId: string,
  sourceCommandId: string,
  session?: ManagedSession,
) {
  const runtime = session ? getCodexRuntime(session) : undefined;
  if (runtime) return runtime.stopCapacityRetry(recoveryId, sourceCommandId);
  store().stopCapacityRecovery(conversationId, binding, recoveryId, sourceCommandId);
  return 'stopped' as const;
}
/** Authoritative lifecycle snapshot. Errors deliberately escape to the caller,
 * where they become a preservation blocker. */
export function readCodexLifecycleQueue(conversationId: string, binding: AccountBinding) {
  return store().lifecycleQueue(conversationId, binding);
}
interface Options {
  agentProfile?: AgentLibraryVersion;
  /** Captured from verified operator transport, never caller JSON; admission only. */
  assertAgentContextAuthorization?: () => void;
  repositoryWorkspace?: RepositoryChatWorkspace;
  publishingGitStorageRoots?: readonly string[];
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
  /** Already resolved, authorized and persisted by common chat admission. */
  agentContext?: AgentContextSnapshot;
  prepareAgentContext?: (signal: AbortSignal) => Promise<void>;
  onAgentContextAccepted?: (
    commandId: string,
    threadId: string,
    turnId: string,
    contextSha256: string,
  ) => void;
  /** Recreate the provider runtime without admitting or replaying user intent. */
  reattachOnly?: boolean;
}

export function selectedOpenShellAccountRoute(
  options: Pick<Options, 'binding' | 'model' | 'profile'>,
): OpenShellAccountRoute {
  if (options.profile.nativeAuth)
    throw new Error('Native personal ChatGPT accounts require the isolated Symposium runtime');
  if (
    options.profile.planType !== 'api' &&
    options.profile.sandboxProviderType !== 'openai-codex-oauth'
  )
    throw new Error('ChatGPT compatibility provider binding is unavailable');
  const model = options.model ?? options.binding.model;
  const provider = options.profile.sandboxProvider!;
  if (options.profile.planType === 'api') return { kind: 'api', provider, model };
  return {
    kind: 'chatgpt-subscription',
    provider,
    providerType: 'openai-codex-oauth',
    providerId: options.profile.sandboxProviderId!,
    grantId: options.profile.sandboxGrantId!,
    model,
  };
}

/** Only the reviewed Jira template may populate sandbox environment variables. */
export function managedJiraConnectionEnv(connection: Connection) {
  const email = connection.publicConfig.email;
  if (
    connection.templateId !== 'jira-readonly' ||
    connection.templateVersion !== 1 ||
    Object.keys(connection.publicConfig).length !== 1 ||
    typeof email !== 'string' ||
    !isValidEmailAddress(email)
  )
    throw new Error('Unsupported managed Jira connection configuration');
  return { JIRA_URL: JIRA_API_ENDPOINT as typeof JIRA_API_ENDPOINT, JIRA_EMAIL: email };
}
/** Shared chat adapter. Execution remains gated by the account catalog and unsupported capabilities fail explicitly. */
export async function openCodexChat(options: Options) {
  return duringCodexStartup('runtime_admission', () => openCodexChatAdmitted(options));
}
async function openCodexChatAdmitted(options: Options) {
  if (options.profile.nativeAuth)
    throw new Error('Native personal ChatGPT accounts require the isolated Symposium runtime');
  const service = getConnectionsRuntime()?.service;
  const configuredRuntime = openShellRuntimeConfig(process.env);
  const savedAgentContext = options.eventStore.getSession(options.conversationId)?.agentContext;
  const selectedRecipe = options.agentProfile?.definition.contextRecipe;
  if (
    [options.agentContext, savedAgentContext].some(
      (snapshot) => snapshot?.source === 'packs' && snapshot.sandbox,
    ) ||
    (savedAgentContext?.sandbox && (!configuredRuntime || selectedRecipe?.source === 'packs')) ||
    (configuredRuntime &&
      selectedRecipe &&
      selectedRecipe.source !== 'packs' &&
      savedAgentContext &&
      !savedAgentContext.sandbox)
  )
    throw Error('Agent context compilation scope differs; start a new chat');
  if (configuredRuntime && !options.resume)
    store().reserveStartup(options.conversationId, options.binding, options.session.cwd!);
  if (service && configuredRuntime) {
    // Setup holds the connection reservation through sandbox verification and
    // thread registration. First-turn admission reacquires it; release setup
    // before sending so the non-reentrant service gate cannot wait on itself.
    const query = await service.withAccountRuntimes(
      options.binding.accountId,
      (connections) =>
        openCodexChatBound(
          options,
          connections,
          service.onDemandForAccount(options.binding.accountId),
          true,
        ),
      options.session.abortController.signal,
      options.resume
        ? async (candidates) => {
            const routed = store().readArtifactRuntime(options.conversationId, options.binding);
            const names = routed
              ? [routed.runtime.sandboxName]
              : [
                  sandboxNameForConversation(
                    options.conversationId,
                    configuredRuntime.sandboxIdLength,
                  ),
                  `mitzo-${createHash('sha256').update(options.conversationId).digest('hex').slice(0, 24)}`,
                ];
            return service.retainedAutomaticConnections(
              names,
              candidates,
              options.session.abortController.signal,
            );
          }
        : undefined,
    );
    try {
      if (!options.reattachOnly) {
        const runtime = getCodexRuntime(options.session);
        if (!runtime) throw new Error('Codex conversation unavailable');
        await sendInitialCodexTurn(options, runtime);
      }
      return query;
    } catch (error) {
      query.close();
      throw error;
    }
  }
  return openCodexChatBound(options);
}
async function openCodexChatBound(
  options: Options,
  managedConnections: readonly Connection[] = [],
  onDemandConnections: readonly Connection[] = [],
  deferInitialSend = false,
) {
  const managedConnection =
    managedConnections.find((connection) => connection.templateId === 'jira-readonly') ??
    managedConnections[0] ??
    null;
  if (custodianControllerMode) requireCustodianOrdinaryRuntime(true, options.binding.provider);
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
  const routedRuntime = options.resume
    ? store().readArtifactRuntime(options.conversationId, options.binding)
    : null;
  let runtimeManager = configuredRuntime
    ? new OpenShellRuntimeManager({
        ...configuredRuntime,
        ...(routedRuntime ? { sandboxNameOverride: routedRuntime.runtime.sandboxName } : {}),
        serviceProviders: ordinaryRuntimeServiceProviders(
          configuredRuntime.serviceProviders,
          managedConnections,
        ),
        grantableServiceProviders: [
          ...configuredRuntime.grantableServiceProviders,
          ...onDemandConnections.map((connection) => connection.gatewayProviderName),
        ],
        account: selectedOpenShellAccountRoute(options),
        connectionAccountId: options.binding.accountId,
        enforceConnectionAttachments: !connectionService,
        connectionRuntimePolicies: connectionService
          ? (_name, signal, approvedGrantableProviders = []) =>
              connectionService.runtimePolicyContracts(
                managedConnections,
                options.binding.accountId,
                signal,
                approvedGrantableProviders,
              )
          : undefined,
        verifyConnections: connectionService
          ? (name, signal, approvedGrantableProviders = []) =>
              connectionService.verifyRuntimeSandbox(
                name,
                managedConnections,
                options.binding.accountId,
                signal,
                onDemandConnections,
                approvedGrantableProviders,
              )
          : undefined,
      })
    : undefined;
  const startupReservation = runtimeManager
    ? await sharedOpenShellLifecycleCoordinator.reserve(options.conversationId)
    : undefined;
  let managedOpenShell: OpenShellRuntime | undefined;
  try {
    if (runtimeManager) {
      store().assertStartupResumeSafe(options.conversationId, options.binding);
      const provisioning = store().startupNeedsProvisioning(
        options.conversationId,
        options.binding,
      );
      if (provisioning && options.reattachOnly) {
        // Queue attachment is observational. Keep the reserved startup for an
        // explicit send instead of creating an unacknowledged provider thread.
        const idle = new AsyncQueue<Record<string, unknown>>();
        idle.close();
        startupReservation?.();
        return {
          [Symbol.asyncIterator]: () => idle[Symbol.asyncIterator](),
          setPermissionMode: async () => {},
          interrupt: async () => {},
          close: () => {},
          stopTask: async () => {
            throw new Error('Codex subagents are unavailable');
          },
        };
      }
      if (provisioning) options = { ...options, resume: false };
      if (
        options.resume &&
        options.repositoryWorkspace &&
        (!routedRuntime?.runtime.sandboxName || !routedRuntime.runtime.sandboxId)
      )
        throw new Error('Repository sandbox identity is unavailable; preserve the conversation');
    }
    const repositorySeed =
      runtimeManager && !options.resume && options.repositoryWorkspace
        ? await getRepositoryWorkspaces(true).startupSeed(
            options.repositoryWorkspace.id,
            options.binding,
            options.conversationId,
            options.session.abortController.signal,
          )
        : undefined;
    managedOpenShell = runtimeManager
      ? await duringCodexStartup('sandbox_preparation', () =>
          runtimeManager!.ensure(
            options.conversationId,
            options.session.abortController.signal,
            options.resume && options.repositoryWorkspace && routedRuntime
              ? {
                  sandboxName: routedRuntime.runtime.sandboxName,
                  sandboxId: routedRuntime.runtime.sandboxId,
                }
              : undefined,
            repositorySeed ? { seed: repositorySeed, cleanup: () => {} } : undefined,
          ),
        )
      : undefined;
  } catch (error) {
    startupReservation?.();
    throw error;
  }
  const signal = options.session.abortController.signal;
  try {
    if (options.resume && runtimeManager && managedOpenShell?.sandboxId && configuredRuntime) {
      const selected = await prepareRetainedRuntimeMigration({
        conversationId: options.conversationId,
        binding: options.binding,
        store: store(),
        source: {
          runtime: { ...managedOpenShell, sandboxId: managedOpenShell.sandboxId },
          route: selectedOpenShellAccountRoute(options),
        },
        config: configuredRuntime,
        manager: runtimeManager,
        privateDirectory: codexPrivateDirectory(),
        signal,
      });
      managedOpenShell = selected.runtime;
      runtimeManager = runtimeManager!.forSandbox(selected.runtime.sandboxName);
      const migration = store().readRuntimeMigration(options.conversationId, options.binding);
      if (migration?.phase === 'committed')
        registerMigratedOpenShellLifecycle(options.conversationId, options.binding, migration);
    }
  } catch (error) {
    startupReservation?.();
    throw error;
  }
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
  const connectedOpenShell = !!openShell;
  const openShellClient =
    openShell && managedConnection?.templateId === 'jira-readonly'
      ? { ...openShell, connectionEnv: managedJiraConnectionEnv(managedConnection) }
      : openShell;
  const grantableProviders = runtimeManager
    ? [
        ...configuredRuntime!.grantableServiceProviders,
        ...onDemandConnections.map((connection) => connection.gatewayProviderName),
      ]
    : [];
  const integrationTools = grantIntegrationTools(grantableProviders);
  const openShellHostTools = connectedOpenShell
    ? [
        telosCreateOutcomeDefinition,
        ...telosArtifactDefinitions,
        symposiumProposeProfileDefinition,
        ...integrationTools,
      ]
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
    const access = await runtimeManager!.hasServiceProviderAccess(
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
    const providerLabel =
      INTEGRATION_PROVIDER_LABELS[provider] ??
      onDemandConnections.find((connection) => connection.gatewayProviderName === provider)
        ?.label ??
      provider;
    const attachApprovedProvider = async () => {
      try {
        const onDemand = onDemandConnections.find(
          (connection) => connection.gatewayProviderName === provider,
        );
        if (onDemand) {
          await connectionService?.grantOnDemand(
            onDemand.id,
            onDemand.revision,
            options.binding.accountId,
            signal,
            () =>
              runtimeManager!.grantServiceProvider(
                options.conversationId,
                managedOpenShell,
                provider,
                signal,
              ),
            () =>
              runtimeManager!.revokeServiceProvider(
                options.conversationId,
                managedOpenShell,
                provider,
                signal,
              ),
          );
          return true;
        }
        await runtimeManager!.grantServiceProvider(
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
    throw new CodexStartupError('conversation_storage', error);
  }
  function persistArtifactRuntime() {
    if (!runtimeManager || !managedOpenShell) return;
    if (!managedOpenShell.sandboxId) throw new Error('OpenShell resource identity is unavailable');
    privateStorage.setArtifactRuntime(options.conversationId, options.binding, {
      runtime: { ...managedOpenShell, sandboxId: managedOpenShell.sandboxId },
      route: selectedOpenShellAccountRoute(options),
    });
  }
  const hookRuntime = connectedOpenShell
    ? undefined
    : createNativeHooks(options.session.cwd!, options.conversationId, options.env, {
        trustProjectHooks: process.env.MITZO_TRUST_PROJECT_HOOKS === '1',
      });
  const hooks = hookRuntime?.hooks;
  const dispose = hookRuntime?.dispose ?? (() => {});
  let startup: { context?: string };
  let agentContext = options.agentContext;
  let admittingSandboxContext = false;
  try {
    const savedAgentContext = options.eventStore.getSession(options.conversationId)?.agentContext;
    admittingSandboxContext = !!(
      (options.agentProfile?.definition.contextRecipe &&
        options.agentProfile.definition.contextRecipe.source !== 'packs' &&
        connectedOpenShell) ||
      savedAgentContext?.sandbox
    );
    if (admittingSandboxContext) {
      if (!runtimeManager || !managedOpenShell || !options.assertAgentContextAuthorization)
        throw Error('Sandbox agent context requires an authenticated managed runtime');
      options.assertAgentContextAuthorization();
      // The startup reservation above already holds the owning lifecycle fence.
      agentContext = await resolveSandboxAgentContext({
        profile: options.agentProfile,
        stored: savedAgentContext,
        conversationId: options.conversationId,
        runtime: managedOpenShell!,
        manager: runtimeManager!,
        presets: configuredRuntime?.agentContextPresets,
        signal,
      });
      options.assertAgentContextAuthorization();
      signal.throwIfAborted();
      if (!agentContext?.sandbox) throw Error('Sandbox agent context snapshot is unavailable');
      options.eventStore.upsertSession({
        sessionId: options.conversationId,
        agentProfile: options.agentProfile,
        agentContext,
      });
      options.onBootContext?.({ ...agentContext.context, scope: 'sandbox' });
      startup = {};
    } else if (agentContext) {
      startup = {};
    } else if (runtimeManager) {
      // Enrolled sessions receive accepted guidance through prepareSystemPrompt
      // on each turn. A retained writable checkout can contain older guidance;
      // never install that context as persistent thread developer instructions.
      if (
        options.agentContext ||
        configuredRuntime?.knowledgeStore ||
        options.repositoryWorkspace
      ) {
        startup = {};
      } else {
        const context = await runtimeManager!.compileContext(managedOpenShell!, signal);
        options.onBootContext?.(context);
        startup = { context: context.fullMarkdown };
      }
    } else {
      startup = hooks
        ? await hooks.run('SessionStart', { source: options.resume ? 'resume' : 'startup' }, signal)
        : {};
    }
  } catch (error) {
    dispose();
    startupReservation?.();
    throw new CodexStartupError(
      'context_preparation',
      admittingSandboxContext ? sandboxAgentContextAdmissionFailure(error, signal.aborted) : error,
    );
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
  const connectionTools = sessionCredentialTools(
    options.conversationId,
    options.session,
    options.registry,
    '',
    {
      providers: () => [
        ...managedConnections.map((c) => ({
          id: `openshell:${c.gatewayProviderName}`,
          label: c.label,
          endpoint: c.endpoint,
          provider: c.gatewayProviderName,
          transport: 'openshell',
          access: 'attached',
        })),
        ...grantableProviders.map((provider) => ({
          id: `openshell:${provider}`,
          label:
            onDemandConnections.find((c) => c.gatewayProviderName === provider)?.label ??
            INTEGRATION_PROVIDER_LABELS[provider] ??
            provider,
          endpoint: onDemandConnections.find((c) => c.gatewayProviderName === provider)?.endpoint,
          provider,
          transport: 'openshell',
          access: 'request_session_access',
        })),
      ],
      request: requestIntegrationAccess,
    },
  );
  const managedCapabilityConnection = options.binding?.accountId
    ? (managedConnections.find((connection) => connection.templateId === 'github-readonly') ?? null)
    : null;
  const capabilityTools = capabilityToolsForConversation(
    options.binding?.accountId ?? '',
    managedCapabilityConnection,
  );
  const githubPublishing = createGithubPublishingTool(
    options.conversationId,
    options.registry,
    () =>
      connectedOpenShell
        ? managedOpenShell
          ? {
              runtime: 'openshell',
              workspace: managedOpenShell.workdir,
              sandboxName: managedOpenShell.sandboxName,
            }
          : undefined
        : hostGithubPublishingSource(options.session, options.publishingGitStorageRoots),
  );
  const events = new AsyncQueue<Record<string, unknown>>();
  let closed = false;
  function finish() {
    if (closed) return;
    closed = true;
    githubPublishing.close();
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
    const livePublishingOwner = getLiveCapabilityConversationBinding(
      options.conversationId,
    )?.runtimeOwnerId;
    if (
      managedCapabilityConnection &&
      (!livePublishingOwner || livePublishingOwner === githubPublishing.runtimeOwnerId)
    )
      clearLiveCapabilityConversationBinding(options.conversationId, {
        connectionId: managedCapabilityConnection.id,
        connectionRevision: managedCapabilityConnection.revision,
      });
  }
  const baseSystemPrompt =
    options.systemPrompt +
    CONNECTION_TOOL_INSTRUCTIONS +
    WEB_ACCESS_INSTRUCTIONS +
    GITHUB_PUBLISHING_INSTRUCTIONS +
    `\nWhen the user asks you to build a reusable Symposium agent profile in this conversation, use ${SYMPOSIUM_PROPOSE_PROFILE_TOOL} to submit portable guidance for review. The tool only drafts a proposal; tell the user to edit and save it in Mitzo. Do not include credentials, transcript text, session or machine paths, account bindings, or runtime grants.\n` +
    (connectedOpenShell
      ? `\nOpenShell contains the provider loop and its built-in tools. Use those tools directly inside the supplied sandbox workspace. Current Mitzo mode: ${options.session.mode}. In Agent or Auto mode, a user request to edit that workspace is the required approval: execute it without asking again. ${telosArtifactInstructions(!!agentContext)} Use ${TELOS_CREATE_OUTCOME_TOOL} for durable Telos capture; never use a sandbox-local todo script for persistent Telos work.${integrationTools.length ? ` Mitzo preflights explicit requests for grantable integrations before the turn begins. If you discover that you need a grantable service which the user did not request explicitly, call ${GRANT_INTEGRATION_TOOL} before using it. A CLI being installed does not mean its provider is attached, and a tunnel error from an unattached provider is not evidence of a gateway outage.` : ''}\n`
      : HOST_TOOL_INSTRUCTIONS) +
    (managedConnection?.templateId === 'jira-readonly'
      ? '\nThis sandbox has verified read-only Jira access to https://redhat.atlassian.net. Use the scoped API base in JIRA_URL (not the browser site URL). Use the provider-approved /usr/bin/python3 or curl with JIRA_URL, JIRA_EMAIL, and the gateway-managed JIRA_API_TOKEN placeholder for Basic authorization. Never print credential values. Writes are denied by the gateway policy.\n'
      : '');
  const persistentSystemPrompt =
    baseSystemPrompt + (startup.context ? `\n\n${startup.context}` : '');
  let pendingAdditionalContext: string | undefined;
  const suppliedContextHash = (additionalContext: string | undefined) =>
    createHash('sha256')
      .update(
        JSON.stringify({
          developerInstructions: persistentSystemPrompt,
          additionalContext: additionalContext ?? null,
        }),
      )
      .digest('hex');
  let pendingKnowledge: Omit<KnowledgeAdoptionSelection, 'contextSha256'> | undefined;
  let pendingAgentContextSha256: string | undefined;
  if (configuredRuntime)
    store().markStartupProviderInitializing(options.conversationId, options.binding);
  const runtime: CodexConversation = new CodexConversation({
    conversationId: options.conversationId,
    cwd: options.session.cwd!,
    profile: options.profile,
    storedBinding: options.binding,
    store: privateStorage,
    deferToolSurfaceReplacement: !!runtimeManager,
    enableCapacityRecovery: true,
    webSearchBackend: openShell ? 'openshell' : 'host',
    webSearchDeploymentRevision: openShell
      ? 'openshell-runtime-config-v1'
      : `codex-cli:${SUPPORTED_CODEX_CLI_VERSION}`,
    getMode: () => options.session.mode,
    systemPrompt: persistentSystemPrompt,
    startupSignal: signal,
    prepareAgentContext: options.prepareAgentContext,
    disableProjectDocuments: agentContext?.source === 'packs',
    // Thread instructions already contain the retained snapshot. The exact
    // turn/start acknowledgement associates it without duplicating developer context.
    ...(agentContext && !agentContext.sandbox
      ? {
          onProviderAccepted: (commandId: string, threadId: string, turnId: string) =>
            options.onAgentContextAccepted?.(
              commandId,
              threadId,
              turnId,
              suppliedContextHash(pendingAdditionalContext),
            ),
        }
      : {}),
    beforeComplete: connectedOpenShell
      ? undefined
      : async (signal) => {
          await hooks?.run('Stop', { stop_hook_active: false }, signal);
        },
    ...(runtimeManager
      ? {
          prepareSystemPrompt: async (signal: AbortSignal) =>
            sharedOpenShellLifecycleCoordinator.admit(options.conversationId, async () => {
              pendingKnowledge = undefined;
              pendingAdditionalContext = undefined;
              pendingAgentContextSha256 = undefined;
              if (agentContext?.sandbox) {
                const scope = await runtimeManager!.verifyAgentContextRuntime(
                  options.conversationId,
                  managedOpenShell!,
                  signal,
                );
                if (
                  contextDigest({
                    ...scope,
                    effectiveRecipeHash: agentContext.sandbox.effectiveRecipeHash,
                  }) !== contextDigest(agentContext.sandbox)
                )
                  throw Error('Saved sandbox agent context runtime changed; start a new chat');
              }
              const selected = await runtimeManager!.adoptKnowledge(
                options.conversationId,
                managedOpenShell!,
                signal,
                ...(agentContext?.source === 'packs'
                  ? [{ ...agentContext.context, scope: 'sandbox' as const }]
                  : []),
              );
              if (!selected && !agentContext?.sandbox) return undefined;
              pendingKnowledge = selected?.adoption;
              if (selected) options.onBootContext?.(selected.context);
              pendingAdditionalContext =
                (agentContext?.sandbox
                  ? `\n\n# Agent Library context (saved recipe)\n${agentContext.context.fullMarkdown}\n`
                  : '') +
                (selected
                  ? `\n\n# Published MGMT knowledge\nAccepted source: ${selected.sourceCommit}\nBundle: ${selected.payloadSha256}\nRead shared project instructions from ${selected.knowledgeRoot}/AGENTS.md. Search and read accepted knowledge under ${selected.knowledgeRoot}/memory/. This published view supersedes older accepted knowledge in the task checkout${agentContext?.sandbox ? ' and saved recipe' : ''}. Keep edits and new observations in the writable task workspace; do not modify the published knowledge view. A local commit is not evidence of publication or adoption elsewhere.\n\n${agentContext?.source === 'packs' ? 'The agent profile boot context retains its separately recorded source revisions. This retrieval publication does not replace that pinned profile context.' : selected.context.fullMarkdown}`
                  : '');
              if (agentContext?.sandbox)
                pendingAgentContextSha256 = createHash('sha256')
                  .update(pendingAdditionalContext)
                  .digest('hex');
              return pendingAdditionalContext;
            }),
          onApplicationContextAccepted: (commandId, threadId, turnId, context) => {
            const contextSha256 = createHash('sha256').update(context).digest('hex');
            if (agentContext?.sandbox) {
              if (pendingAgentContextSha256 !== contextSha256)
                throw Error('Agent context acknowledgement differs from prepared context');
              privateStorage.recordAgentContextAdoption(
                options.conversationId,
                options.binding,
                commandId,
                threadId,
                turnId,
                {
                  profileId: agentContext.profileId,
                  revision: agentContext.revision,
                  profileHash: agentContext.profileHash,
                  recipeHash: agentContext.recipeHash,
                  payloadHash: agentContext.payloadHash,
                  snapshotHash: contextDigest(agentContext),
                  sandbox: agentContext.sandbox,
                  contextSha256,
                },
              );
              options.onAgentContextAccepted?.(
                commandId,
                threadId,
                turnId,
                suppliedContextHash(context),
              );
            }
            if (!pendingKnowledge) return;
            privateStorage.recordKnowledgeAdoption(
              options.conversationId,
              options.binding,
              commandId,
              threadId,
              turnId,
              {
                ...pendingKnowledge,
                contextSha256: suppliedContextHash(context),
              },
            );
          },
          reconnectGuard: connectionService
            ? (work: () => Promise<void>) =>
                connectionService.withAccountRuntimes(
                  options.binding.accountId,
                  async (current) => {
                    if (
                      managedConnections.some(
                        (original) =>
                          !current.some(
                            (connection) =>
                              original.id === connection.id &&
                              original.gatewayProviderId === connection.gatewayProviderId,
                          ),
                      )
                    )
                      throw new Error('Connection permissions changed. Start a new conversation.');
                    await work();
                  },
                  signal,
                  (candidates) =>
                    candidates.filter((candidate) =>
                      managedConnections.some(
                        (original) =>
                          original.id === candidate.id &&
                          original.gatewayProviderId === candidate.gatewayProviderId,
                      ),
                    ),
                )
            : undefined,
          beforeRuntimeAdmission: async (closeOwnedTransport: () => Promise<void>) => {
            if (!managedOpenShell?.sandboxId || !configuredRuntime) return false;
            return sharedOpenShellLifecycleCoordinator.admit(options.conversationId, async () => {
              const previousId = managedOpenShell!.sandboxId;
              const selected = await prepareRetainedRuntimeMigration({
                conversationId: options.conversationId,
                binding: options.binding,
                store: privateStorage,
                source: {
                  runtime: { ...managedOpenShell!, sandboxId: managedOpenShell!.sandboxId! },
                  route: selectedOpenShellAccountRoute(options),
                },
                config: configuredRuntime,
                manager: runtimeManager!,
                privateDirectory: codexPrivateDirectory(),
                signal,
                closeOwnedTransport,
              });
              Object.assign(managedOpenShell!, selected.runtime);
              if (openShellClient) Object.assign(openShellClient, selected.runtime);
              runtimeManager = runtimeManager!.forSandbox(selected.runtime.sandboxName);
              const migration = privateStorage.readRuntimeMigration(
                options.conversationId,
                options.binding,
              );
              if (migration?.phase === 'committed')
                registerMigratedOpenShellLifecycle(
                  options.conversationId,
                  options.binding,
                  migration,
                );
              return selected.runtime.sandboxId !== previousId;
            });
          },
          beforeReconnect: async () => {
            await sharedOpenShellLifecycleCoordinator.admit(options.conversationId, async () => {
              const retained = options.repositoryWorkspace
                ? privateStorage.readArtifactRuntime(options.conversationId, options.binding)
                : undefined;
              if (options.repositoryWorkspace && !retained)
                throw new Error(
                  'Repository sandbox identity is unavailable; preserve the conversation',
                );
              let recovered = await runtimeManager!.ensure(
                options.conversationId,
                signal,
                retained
                  ? {
                      sandboxName: retained.runtime.sandboxName,
                      sandboxId: retained.runtime.sandboxId,
                    }
                  : undefined,
              );
              if (recovered.sandboxId && configuredRuntime) {
                const selected = await prepareRetainedRuntimeMigration({
                  conversationId: options.conversationId,
                  binding: options.binding,
                  store: privateStorage,
                  source: {
                    runtime: { ...recovered, sandboxId: recovered.sandboxId },
                    route: selectedOpenShellAccountRoute(options),
                  },
                  config: configuredRuntime,
                  manager: runtimeManager!,
                  privateDirectory: codexPrivateDirectory(),
                  signal,
                });
                recovered = selected.runtime;
                runtimeManager = runtimeManager!.forSandbox(selected.runtime.sandboxName);
                const migration = privateStorage.readRuntimeMigration(
                  options.conversationId,
                  options.binding,
                );
                if (migration?.phase === 'committed')
                  registerMigratedOpenShellLifecycle(
                    options.conversationId,
                    options.binding,
                    migration,
                  );
              }
              await restoreOpenShellLifecycleIfNeeded(
                options.conversationId,
                recovered,
                signal,
                options.binding,
                selectedOpenShellAccountRoute(options),
                true,
              );
              Object.assign(managedOpenShell!, recovered);
              if (openShellClient) Object.assign(openShellClient, recovered);
              persistArtifactRuntime();
            });
            if (managedCapabilityConnection && options.binding?.accountId)
              await capabilityTools.service?.recoverPendingForConversation(
                options.binding.accountId,
                options.conversationId,
                signal,
              );
          },
        }
      : {}),
    validateModel: (model, reasoningEffort) => {
      loadAccountProfiles().validateModel(options.binding, model, reasoningEffort);
    },
    tools: connectedOpenShell
      ? [
          ...connectionTools.definitions,
          ...openShellHostTools,
          ...capabilityTools.definitions,
          webAccessDefinition,
          githubPublishingDefinition,
        ]
      : [
          ...connectionTools.definitions,
          symposiumProposeProfileDefinition,
          ...nativeToolDefinitions,
          ...mcp.definitions,
          ...capabilityTools.definitions,
          webAccessDefinition,
          githubPublishingDefinition,
        ],
    displayToolName: mcp.displayName,
    createClient: (callbacks) => {
      try {
        return connectedOpenShell
          ? CodexAppServerClient.launchOpenShell(openShellClient!, process.env, callbacks)
          : CodexAppServerClient.launch(options.profile.credentialRef!, process.env, callbacks);
      } catch (cause) {
        throw new CodexStartupError('runtime_connection', cause);
      }
    },
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
    loadSourceSnapshots: () => codexRolloverSources(options.eventStore, options.conversationId),
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
              const access = await runtimeManager!.hasServiceProviderAccess(
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
    executeTool: async (name, input, signal, callContext) => {
      const keychainResult = await connectionTools.execute(name, input, signal);
      if (keychainResult) return keychainResult;
      if (name === REQUEST_GITHUB_PUBLISH) return githubPublishing(input, signal, callContext);
      if (name === SYMPOSIUM_PROPOSE_PROFILE_TOOL) {
        signal.throwIfAborted();
        if (!options.eventStore.getSession(options.conversationId))
          return { content: 'Conversation is unavailable', isError: true };
        const proposals = new SymposiumProfileProposalStore(
          join(process.env.REPO_PATH || '.', '.mitzo', 'events.db'),
        );
        try {
          const proposal = proposeProfileFromTool({
            store: proposals,
            owner: 'user',
            sessionId: options.conversationId,
            turnId: callContext.turnId,
            callId: callContext.callId,
            arguments: input,
          });
          return {
            content: JSON.stringify({
              proposalId: proposal.proposalId,
              status: 'awaiting_user_review',
            }),
            isError: false,
          };
        } catch (error) {
          return {
            content: error instanceof Error ? error.message : 'Profile proposal was rejected',
            isError: true,
          };
        } finally {
          proposals.close();
        }
      }
      const capability = capabilityTools.bindings.get(name);
      if (capability && capabilityTools.service) {
        const operation = await capabilityTools.service.invoke(
          {
            ...capability,
            accountId: options.binding.accountId,
            conversationId: options.conversationId,
            turnId: callContext.turnId,
            // Provider call IDs are verified by CodexConversation before this
            // callback. Hash them so a model cannot control idempotency.
            idempotencyKey: capabilityIdempotencyKey(
              options.conversationId,
              capability,
              callContext,
              input,
            ),
            input,
          },
          signal,
          capabilityApprovalForConversation(options.registry, options.conversationId),
        );
        return {
          content: JSON.stringify({
            operationId: operation.id,
            status: operation.status,
            result: operation.result,
          }),
          isError: operation.status !== 'succeeded',
        };
      }
      if (connectedOpenShell && isTelosArtifactTool(name)) {
        const parsed = telosArtifactSchemas[name].safeParse(input);
        if (!parsed.success) return { content: 'Invalid Telos artifact input', isError: true };
        const owner = options.registry.findBySessionId(options.conversationId);
        if (!owner) return { content: 'Codex session unavailable', isError: true };
        const permission = await buildPermissionHandler(owner.clientId, options.registry, {
          onDemandCreate: options.onDemandCreate,
        })(name, parsed.data, {
          signal,
          toolUseID: randomUUID(),
          forcePrompt: name === 'TelosSaveArtifact',
          title:
            name === 'TelosSaveArtifact'
              ? 'Save this document in live Telos?'
              : 'Read Telos documents',
          description:
            'Telos stores task documents on the host so future sessions can recover them.',
        });
        signal.throwIfAborted();
        if (permission.behavior !== 'allow') return { content: permission.message, isError: true };
        if (!isDeepStrictEqual(permission.updatedInput, parsed.data))
          return { content: 'Telos input changed during approval; retry the tool', isError: true };
        if (options.registry.findBySessionId(options.conversationId)?.clientId !== owner.clientId)
          return { content: 'Session permissions changed; retry the tool', isError: true };
        return executeTelosArtifactTool(
          localHttpBaseUrl(Number.parseInt(process.env.PORT || '3100', 10), localServerUsesTls()),
          owner.clientId,
          INTERNAL_TOKEN,
          name,
          parsed.data,
          signal,
        );
      }
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
      if (name === REQUEST_WEB_ACCESS) {
        return createWebAccessTool(options.conversationId, options.registry, (query, signal) =>
          runtime.searchWeb(query, signal),
        )(input, signal);
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
            persistArtifactRuntime();
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
    onTransportClosed: (diagnostic) => {
      log.info('Codex transport closed', {
        conversationId: options.conversationId,
        ...diagnostic,
      });
    },
    onError: (error) => {
      log.warn('Codex runtime reported an error', {
        conversationId: options.conversationId,
        ...codexRuntimeErrorTelemetry(error),
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
    await duringCodexStartup('conversation_initialization', () => runtime.initialize());
    if (managedCapabilityConnection && options.binding?.accountId) {
      bindLiveCapabilityConversation(options.conversationId, {
        accountId: options.binding.accountId,
        connectionId: managedCapabilityConnection.id,
        connectionRevision: managedCapabilityConnection.revision,
        gatewayProviderId: managedCapabilityConnection.gatewayProviderId,
        ...(managedOpenShell
          ? { sandboxName: managedOpenShell.sandboxName, workspace: managedOpenShell.workdir }
          : {}),
      });
      await capabilityTools.service?.recoverPendingForConversation(
        options.binding.accountId,
        options.conversationId,
        signal,
      );
    }
    if (runtimeManager && managedOpenShell) {
      const threadId = runtime.getDurableThreadId();
      persistArtifactRuntime();
      // New native threads are ephemeral until the first turn ACK. Keep the
      // provisional ownership row until onThreadChanged registers that identity.
      if (threadId)
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
    // Startup protects ensure/restore and thread ownership registration. Initial
    // send reacquires this same coordinator for runtime and knowledge admission;
    // release setup first so neither callback waits on its own startup fence.
    startupReservation?.();
    if (!options.reattachOnly && !deferInitialSend) await sendInitialCodexTurn(options, runtime);
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
    interrupt: () => runtime.interrupt(),
    close,
    stopTask: async () => {
      throw new Error('Codex subagents are unavailable');
    },
  };
}

async function sendInitialCodexTurn(options: Options, runtime: CodexConversation) {
  const dispatchCount = runtime.getTurnDispatchCount();
  try {
    options.session.abortController.signal.throwIfAborted();
    await runtime.send({
      id: options.messageId,
      prompt: options.prompt,
      intent: options.intent,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      images: options.images,
    });
  } catch (cause) {
    throw new CodexStartupError(
      runtime.getTurnDispatchCount() === dispatchCount
        ? 'initial_turn_preparation'
        : 'initial_turn_dispatch',
      cause,
    );
  }
}
