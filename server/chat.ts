import {
  TASK_WORKER_ALLOCATION_EVENT,
  resolveTaskWorkerAllocationContext,
} from './task-worker-authority.js';
import { assertTurnCallbackEffects, type TurnCallbackRunner } from './turn-callbacks.js';
import { createContinuousSdkQuery } from './continuous-sdk-callbacks.js';
import { findSessionRuntimeError } from './session-runtime-error.js';
import { reportRetainedRuntimeFailure } from './retained-runtime-failure.js';
import { AdviserTaskScope } from './adviser-task-scope.js';
import { restoreOwnedVertexInitialPrompt } from './ordinary-local-vertex-replay.js';
import type { OrdinaryWorkspaceRecord } from './ordinary-workspace-custody.js';
import type { LocalWorkspaceRecord } from './ordinary-local-workspace-owner.js';
import type { LocalWorkspaceKind } from './ordinary-local-workspace-owner.js';
import { ordinaryOperatorOwnsConversation } from './ordinary-operator-identity.js';
import {
  RetainedLocalCodexRecovery,
  recoverableLocalCodexCommand,
} from './retained-local-codex-recovery.js';
import { resolveTelosWorkRoleContext } from './telos-work-role-context.js';
import {
  resolveTelosWorkCommandScope,
  assertTelosWorkCommandAdmission,
} from './telos-work-command-scope.js';
import { TelosWorkStore } from './telos-work-store.js';
import { isAvailableTelosWorkConversation } from './telos-work-conversation.js';
import { assertAgentToolRoute, bindAgentToolSelection } from './agent-tool-selection.js';
import {
  createOrdinaryLocalVertexSdkQuery,
  SdkHookLifetime,
} from './ordinary-local-vertex-sdk-query.js';
import { LocalVertexClaudeFirstCommandSchema } from '@mitzo/protocol';
import type { OrdinaryLocalVertexCommandOwner } from './ordinary-local-vertex-command-owner.js';
import type { AccountBinding, OrdinaryLocalCommandAdmission } from '@mitzo/protocol';
import { OrdinaryLocalVertexSdkAuthority } from './ordinary-local-vertex-sdk-authority.js';
import {
  OrdinaryLocalResponsesOwnedRuntime,
  type OrdinaryLocalResponsesOwnedDispatch,
} from './ordinary-local-responses-owned-runtime.js';
import { getNativeResponsesStore } from './responses-chat-session.js';
import { OwnedOpenShellCodexChatAdmission } from './owned-openshell-codex-chat-admission.js';
import { hasPersistentRevocationAuthority } from './auth.js';
import { liveTransportAuthSessionId } from './transport-auth-ownership.js';
import type { OrdinaryOpenShellCodexOwnedDispatch } from './ordinary-openshell-codex-owned-runtime.js';
import { nativeStartupSessionId, reserveRepositoryStartup } from './ordinary-repository-startup.js';
import { PROFILE_TOOL_INSTRUCTIONS } from './session-profile-tools.js';
import { assertNativeCodexContextAdmission } from './native-codex-context-admission.js';
import { OwnedLocalCodexChatAdmission } from './owned-local-codex-chat-admission.js';
import { retainNativeHostToolOperator } from './native-host-tool-context.js';
import { findNativeMacExecutionUnavailable } from './codex-native-artifact-qualification.js';
import {
  OrdinaryLocalCodexOwnedRuntime,
  type OrdinaryLocalCodexOwnedDispatch,
} from './ordinary-local-codex-owned-runtime.js';
import { reconcilePreparedRepositoryTransitionProjection } from './owned-prepared-repository-transition.js';
import { getAgentLibrary } from './agent-library-runtime.js';
import type { HostRepositoryReservationInput } from './repository-workspaces.js';
import { isDeepStrictEqual } from 'node:util';
import {
  assertOrdinaryContributorControlAllowed,
  authorizeOrdinaryContributorStart,
  type OrdinaryContributorExecution,
} from './ordinary-contributor-execution.js';
import {
  resolveOrdinaryContributorGuidance,
  saveOrdinaryContributorGuidance,
} from './ordinary-contributor-guidance.js';
import type { OrdinaryTurnLifecycle } from './ordinary-turn-lifecycle.js';
import { assembleSourceSnapshots } from './source-snapshot-context.js';
import type { SourceSnapshot } from '@mitzo/protocol';
import {
  reconstructMessages,
  replayEventsToMessages,
  replayEventsToTranscript,
  type RawSdkMessage,
} from './conversation-transcript.js';
export {
  reconstructMessages,
  replayEventsToMessages,
  replayEventsToTranscript,
} from './conversation-transcript.js';
export type {
  RestoredMessage,
  RestoredCurrentMessage,
  RestoredSubagentState,
  RawSdkMessage,
} from './conversation-transcript.js';
import {
  getOrdinaryWorkspaces,
  getRepositoryWorkspaces,
  readRepositoryWorkspaceForConversation,
} from './repository-workspace-runtime.js';
import {
  selectRepositoryChatWorkspace,
  repositoryChatContext,
  type RepositoryChatWorkspace,
} from './repository-chat-startup.js';
import { credentialSdkBoundary } from './credential-sdk-boundary.js';
import {
  createWorkspaceRuntimeCommandRunner,
  type ProtectedSdkCommandRunner,
} from './protected-sdk-command.js';
import { createCredentialSdkServer, credentialSdkPermission } from './credential-sdk-tools.js';
import { CONNECTION_TOOL_INSTRUCTIONS } from './session-credential-tools.js';
import { isRegisteredConversation } from '@mitzo/protocol';
import { clearWebSearchGrant } from './web-search-grants.js';
import { codexRuntimeDiagnostic, codexRuntimeErrorTelemetry } from './codex-runtime-diagnostics.js';
import {
  createGithubPublishingTool,
  GITHUB_PUBLISHING_INSTRUCTIONS,
  hostGithubPublishingSource,
} from './github-publishing-tool.js';
import { localHttpBaseUrl, localServerUsesTls } from './local-server-url.js';
import { telosArtifactInstructions } from './telos-artifact-tools.js';
import { requireCustodianOrdinaryRuntime } from './custodian-ordinary-runtime.js';
import { assertOrdinaryCodexContributorAccount } from './ordinary-codex-contributor-admission.js';
import {
  createWebAccessSdkServer,
  webAccessSdkPermission,
  WEB_ACCESS_SDK_TOOL,
  GITHUB_PUBLISH_SDK_TOOL,
} from './web-access-sdk.js';
import { createWebAccessTool } from './web-access-tool.js';
import { WEB_ACCESS_INSTRUCTIONS } from './request-web-access.js';
import { searchSdk } from './web-search-adapters.js';
import { custodianControllerMode, custodianOwnerMode } from './symposium-custodian-mode.js';
import { permissionRevision, type ResumePermission } from './session-permission-revision.js';
import { GoogleAuth } from 'google-auth-library';
import type { GeminiOptions } from './gemini-session.js';
import {
  buildSessionPermissionHooks,
  SESSION_PERMISSION_INSTRUCTIONS,
} from './session-permission-policy.js';
import { credentials } from './credentials.js';
import { getConnectionsRuntime } from './connections-runtime.js';
import { assertOpenAIKeyController } from './openai-key-controller.js';
import { openAIKeyResourceBindings } from './openai-key-operation-store.js';
import {
  getResponsesRuntime,
  openResponsesChat,
  trackResponsesProviderAdmission,
} from './responses-chat-session.js';
import {
  admitProviderDispatch,
  preflightProviderDispatch,
  type ProviderDispatchAdmission,
} from './provider-execution.js';
import { responsesUserContent } from './responses-input.js';
import { CodexAppServerClient, codexEnvironment } from './codex-app-server-client.js';
import { verifyCodexAccount, type CodexAccountProfile } from './codex-account.js';
import {
  openCodexChat,
  getCodexRuntime,
  getCodexConversationStore,
  trackCodexProviderAdmission,
  publicCodexRuntimeError,
  publicCodexStartupError,
} from './codex-chat-session.js';
import {
  loadAccountProfiles,
  resolveAccountSelection,
  resolveEffectiveAccountSelection,
  LEGACY_MODELS,
  type AccountProfiles,
} from './account-profiles.js';
import {
  query,
  listSessions,
  getSessionInfo,
  getSessionMessages,
  renameSession,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  HookCallback,
  HookEvent,
  Query,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  SessionTransport,
  ConnectionRegistry,
  ManagedSession,
  CloseoutEpisode,
} from '@mitzo/harness';
import { getTransportAttachmentIdentity } from '@mitzo/harness';
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { join, resolve, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { resolveBundledMcpEntrypoint } from './mcp-entrypoint.js';
import { createHash, randomUUID } from 'crypto';
import { homedir, platform } from 'os';
import {
  createWorktree,
  createWorktreeAsync,
  symlinkRuntimeDirs,
  discoverSessionWorktrees,
} from './worktree.js';
import type { OnDemandCreateFn } from '@mitzo/harness';
import { effectivePermissionMode } from '@mitzo/harness';
import { SessionRegistry, type MitzoMode } from './session-registry.js';
import { loadMcpServers, type McpServerConfig } from './mcp-config.js';
import {
  buildConfiguredMcpAllowedTools,
  rejectReservedMcpServerCollisions,
  TASK_MCP_SERVER_NAME,
  TELOS_MCP_SERVER_NAME,
} from './host-mcp-servers.js';
import { applyTierOverrides } from './tool-tiers.js';
import { loadRepoConfig } from './repo-config.js';
import { loadProjectHooks } from './hook-bridge.js';
import { buildPermissionHandler } from './permission-handler.js';
import { setSkillPolicy } from './skill-policy.js';
import { runQueryLoop, broadcastToObservers } from './query-loop.js';
import { clearSessionImages } from './image-store.js';
import { AsyncQueue } from './async-queue.js';
import {
  GIT_BRANCH_TIMEOUT_MS,
  SESSION_PAGE_SIZE,
  SESSION_MESSAGES_LIMIT,
  USER_CLOSEOUT_TIMEOUT_MS,
  ZERO_TURN_GRACE_MS,
  DEFAULT_AGENT_NAME,
  DEFAULT_CONTEXGIN_URL,
} from './constants.js';
import { INTERNAL_TOKEN } from './internal-token.js';
import { buildTaskSystemPrompt } from './task-context.js';
import type { TaskStore } from './task-store.js';
import { loadAgentDef } from './agent-loader.js';

let _taskStore: TaskStore | null = null;
let taskStoreInstallation = 0;
/** Return a denial-only check for this actual installation. Even change-back
 * advances the generation and cannot revive a previous App assembly. */
export function setTaskStore(store: TaskStore): () => void {
  _taskStore = store;
  const generation = ++taskStoreInstallation;
  const installedEvents = eventStore;
  let invalidated = false;
  return () => {
    if (
      _taskStore !== store ||
      taskStoreInstallation !== generation ||
      eventStore !== installedEvents
    )
      invalidated = true;
    if (invalidated) throw new Error('Actual installed Telos chat owners changed');
  };
}

/** Existing ordinary admission calls this before effects and after awaits.
 * Only a proven durable mapping can attach task-tool context to a live chat.
 */
export function resolveOwnedTelosWorkCommandScope(sessionId: string, forNewCommand = false) {
  let work: TelosWorkStore | undefined;
  try {
    const owners = {
      events: eventStore,
      tasks: _taskStore,
      hasAcceptedProviderTurn: (id: string, account: AccountBinding | undefined) =>
        account?.provider === 'openai-codex' &&
        getCodexConversationStore().hasAcceptedProviderTurn(id, account),
      work: () => {
        if (work) return work;
        const path =
          process.env.TELOS_DB_PATH || join(BASE_REPO, 'command_center', 'data', 'smart_todo.db');
        const policy = {
          ordinaryConversation: (id: string) =>
            isAvailableTelosWorkConversation(eventStore.getSession(id)),
        };
        // New-command admission can retain control-denial evidence. Running-turn
        // scope checks only read authority and may run inside artifact COMMIT.
        return (work = forNewCommand
          ? new TelosWorkStore(path, policy)
          : TelosWorkStore.openReadOnly(path, policy));
      },
    };
    if (forNewCommand)
      assertTelosWorkCommandAdmission(
        owners,
        sessionId,
        eventStore.getSession(sessionId)?.accountBinding ?? undefined,
      );
    let scope: ManagedSession['taskContext'] = resolveTelosWorkCommandScope(
      owners,
      sessionId,
      eventStore.getSession(sessionId)?.accountBinding ?? undefined,
    );
    if (eventStore.getLatestEvent(sessionId, TASK_WORKER_ALLOCATION_EVENT)) {
      if (!_taskStore || scope) throw Error('Exact ordinary worker task authority unavailable');
      scope = resolveTaskWorkerAllocationContext(eventStore, _taskStore, sessionId);
      if (!scope) throw Error('Retained ordinary worker allocation proof unavailable');
    }
    const session = registry.findBySessionId(sessionId)?.session;
    if (scope && session) session.taskContext = scope;
    return scope;
  } finally {
    work?.close();
  }
}

type QueryInstance = AsyncIterable<Record<string, unknown>> &
  NonNullable<ManagedSession['queryInstance']>;

/** Validate and adapt SDK messages at the boundary instead of asserting incompatible iterables. */
export function adaptSdkQuery(sdkQuery: Query): QueryInstance {
  const validatedIterator = async function* () {
    for await (const message of sdkQuery) {
      if (!message || typeof message !== 'object' || Array.isArray(message))
        throw new TypeError(
          `Invalid SDK message: expected an object, received ${
            message === null ? 'null' : Array.isArray(message) ? 'array' : typeof message
          }`,
        );
      yield message as unknown as Record<string, unknown>;
    }
  };
  // Preserve the SDK Query's complete runtime API for future integrations. Bind
  // methods to the original instance because several SDK controls use private state.
  return new Proxy(sdkQuery, {
    get(target, property) {
      if (property === Symbol.asyncIterator) return validatedIterator;
      if (property === 'setPermissionMode') {
        return (mode: MitzoMode) => target.setPermissionMode(mode === 'ask' ? 'plan' : 'default');
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as QueryInstance;
}

let _connRegistry: ConnectionRegistry | null = null;
export function getConnectionRegistry(): ConnectionRegistry | null {
  return _connRegistry;
}
export function setConnectionRegistry(connections: ConnectionRegistry | null): void {
  if (!connections && !registry.entries(true).next().done)
    throw Error('Chat session owners are active');
  _connRegistry = connections;
}

/** Fan out an already durable Symposium event through both WS and SSE watchers. */
export function broadcastDurableSymposiumEvent(
  sessionId: string,
  event: Record<string, unknown>,
): void {
  _connRegistry?.broadcast(sessionId, event);
}

type SessionChangeCallback = (
  clientId: string,
  event: 'start' | 'end' | 'turn_end' | 'user_message' | 'detach',
  sessionId?: string,
) => void;
let _onSessionChange: SessionChangeCallback | null = null;
export function setSessionChangeCallback(cb: SessionChangeCallback): void {
  _onSessionChange = cb;
}

let _onSessionsChanged: (() => void) | null = null;
export function setSessionsChangedCallback(cb: () => void): void {
  _onSessionsChanged = cb;
}
import { EventStore } from './event-store.js';
import { capturePromptComparison } from './prompt-compare.js';
import { accountSessionName } from './account-session-name.js';
import { resolveChatAgentProfile } from './agent-library-binding.js';
import { readAgentLibraryProfile } from './agent-library-transport.js';
import { buildAgentProfilePrompt } from './agent-library-prompt.js';
import type {
  AgentLibraryVersion,
  AgentProfileSelection,
  AgentContextSnapshot,
} from '@mitzo/protocol';
import { resolveChatAgentContext } from './agent-context-binding.js';
import { createAcceptedContextPacks, getContextPackRuntime } from './context-pack-runtime.js';
import {
  bootContextWithRetainedReceipt,
  recordAgentContextAcceptance,
} from './agent-context-delivery.js';
import { retainAgentContextAuthority } from './agent-context-authority.js';
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
import {
  shouldAutoRename,
  extractRecentPrompts,
  generateSessionNameFallback,
} from './auto-rename.js';
import {
  registerSession,
  updateSessionTitle,
  finalizeCloseout,
  getSessionSdkId,
} from './session-index.js';
import { createLogger } from './logger.js';
import { withSpan, withSpanAsync } from './tracing.js';
import { ExecutionAdmissionError } from '@mitzo/protocol/event-store';
import { admitCloseout, type CloseoutAdmission } from './closeout-admission.js';
import type { ProviderAttemptToken } from '@mitzo/protocol';
import { getAccountUseStore } from './account-use-store.js';
import { buildClientCapabilitiesPrompt } from '@mitzo/protocol';

const log = createLogger('chat');

// --- Event store (durable session persistence) ---
function initEventStore(): EventStore {
  const repoPath = process.env.REPO_PATH || '.';
  const mitzoDir = join(repoPath, '.mitzo');
  mkdirSync(mitzoDir, { recursive: true });
  const dbPath = join(mitzoDir, 'events.db');
  const store = new EventStore(dbPath);
  const recover = Reflect.get(store, 'recoverSymposiumDeliveries') as
    EventStore['recoverSymposiumDeliveries'] | undefined;
  const recovered =
    custodianControllerMode || custodianOwnerMode ? [] : (recover?.call(store, Date.now()) ?? []);
  if (recovered.length > 0) {
    log.warn('recovered interrupted Symposium deliveries during startup', {
      deliveryIds: recovered.map((delivery) => delivery.deliveryId),
    });
  }
  return store;
}

export const eventStore = initEventStore();

const fallbackCloseoutAttempts = new WeakMap<
  ManagedSession,
  {
    admission: CloseoutAdmission;
    attempt: ProviderAttemptToken;
    /** The SDK-generated input UUID echoed before the command's final result. */
    inputUuid: string;
    inputObserved: boolean;
  }
>();

function markFallbackCloseoutInputObserved(session: ManagedSession, inputUuid: string): void {
  const tracked = fallbackCloseoutAttempts.get(session);
  if (tracked?.inputUuid === inputUuid) tracked.inputObserved = true;
}

function markFallbackCloseoutAmbiguous(session: ManagedSession): void {
  const tracked = fallbackCloseoutAttempts.get(session);
  if (!tracked) return;
  // An SDK abort only stops this local stream. Without a matching provider
  // result, the remote closeout may still run and its outcome is unknown.
  eventStore.transitionProviderAttempt(tracked.attempt, 'TERMINAL', 'ambiguous');
  eventStore.transitionExecution(tracked.admission.token, 'TERMINAL', 'failed');
  fallbackCloseoutAttempts.delete(session);
}

function finishFallbackCloseout(
  session: ManagedSession,
  status: 'completed' | 'failed',
  inputUuid?: string,
): void {
  const tracked = fallbackCloseoutAttempts.get(session);
  if (!tracked) return;
  // Generic assistant message ends happen between provider tool calls and can
  // also belong to a turn that pre-dates the closeout input. Only the echoed
  // closeout input followed by its terminal SDK result may complete admission.
  // If the echo is absent, leave the dispatched work recoverably ambiguous.
  if (!tracked.inputObserved || inputUuid === undefined || inputUuid !== tracked.inputUuid) return;
  eventStore.transitionProviderAttempt(
    tracked.attempt,
    'TERMINAL',
    status === 'completed' ? 'completed' : 'ambiguous',
  );
  eventStore.transitionExecution(
    tracked.admission.token,
    'TERMINAL',
    status === 'completed' ? 'completed' : 'failed',
  );
  fallbackCloseoutAttempts.delete(session);
}

export type { MitzoMode } from './session-registry.js';

// ── Boot context via ContexGin HTTP API ──────────────────────────
export interface BootContextMessage {
  type: 'boot_context';
  source: 'contexgin' | 'local-fallback' | 'sandbox';
  scope?: 'sandbox';
  sourceCount: number;
  tokenCount: number;
  tokenBudget: number;
  sources: Array<{ path: string; kind: string }>;
  included: Array<{ source: string; heading: string; tokens: number; content: string }>;
  trimmed: Array<{ source: string; heading: string; tokens: number; content: string }>;
  fullMarkdown?: string;
}

const FALLBACK_BOOT_CONTEXT: BootContextMessage = {
  type: 'boot_context',
  source: 'local-fallback',
  sourceCount: 0,
  tokenCount: 0,
  tokenBudget: 0,
  sources: [],
  included: [],
  trimmed: [],
};

/**
 * Local fallback: run build_boot_context.py --json to get deterministic boot context.
 * This is the "old way" — reads canonical source files directly, no server dependency.
 */
async function localBootContextFallback(
  repoRoot: string,
  protectedRunner?: ProtectedSdkCommandRunner,
): Promise<BootContextMessage> {
  const scriptPath = join(repoRoot, 'scripts', 'build_boot_context.py');
  try {
    // Direct callers also inherit runtime protection when they omit a runner.
    // A protection failure is caught below and never retries on the controller.
    const runner = protectedRunner ?? createWorkspaceRuntimeCommandRunner();
    let stdout: string;
    if (runner) {
      ({ stdout } = await runner('python3', [scriptPath, '--json'], {
        cwd: repoRoot,
        env: { ...process.env },
        timeout: 5000,
      }));
    } else {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);
      ({ stdout } = await execFileAsync('python3', [scriptPath, '--json'], {
        cwd: repoRoot,
        timeout: 5000,
      }));
    }
    const parsed = JSON.parse(stdout) as { additionalContext?: string };
    const content = parsed.additionalContext ?? '';
    // Rough token estimate: ~4 chars per token
    const tokens = Math.ceil(content.length / 4);
    const sources = [
      { path: 'memory/Profile/Working Style.md', kind: 'profile' },
      { path: 'memory/Profile/Communication Style.md', kind: 'profile' },
      { path: 'memory/Profile/Principles.md', kind: 'profile' },
      { path: 'CONSTITUTION.md', kind: 'constitution' },
      { path: 'SERVICES.md', kind: 'reference' },
    ];
    return {
      type: 'boot_context',
      source: 'local-fallback',
      sourceCount: sources.length,
      tokenCount: tokens,
      tokenBudget: tokens,
      sources,
      included: [],
      trimmed: [],
      fullMarkdown: content,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('Local boot context fallback failed', { error: msg });
    return { ...FALLBACK_BOOT_CONTEXT };
  }
}

/**
 * Fetch boot context from the running ContexGin server.
 * Falls back to build_boot_context.py if the server is unreachable.
 * Never throws — returns a local-fallback BootContextMessage on any error.
 */
export async function fetchBootContext(
  agentName: string,
  contexginUrl: string = process.env.CONTEXGIN_URL || DEFAULT_CONTEXGIN_URL,
  repoRoot: string = BASE_REPO,
  allowLocalExecutableFallback = true,
  protectedRunner?: ProtectedSdkCommandRunner,
): Promise<BootContextMessage> {
  try {
    const url = `${contexginUrl}/api/agents/${encodeURIComponent(agentName)}/context`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn('ContexGin agent context request failed, trying local fallback', {
        status: res.status,
        body: body.slice(0, 200),
      });
      return allowLocalExecutableFallback
        ? localBootContextFallback(repoRoot, protectedRunner)
        : { ...FALLBACK_BOOT_CONTEXT };
    }

    const data = (await res.json()) as Record<string, unknown>;
    const boot = data.boot as Record<string, unknown> | undefined;

    if (!boot) {
      log.warn('ContexGin response missing boot field, trying local fallback', {
        keys: Object.keys(data),
      });
      return allowLocalExecutableFallback
        ? localBootContextFallback(repoRoot, protectedRunner)
        : { ...FALLBACK_BOOT_CONTEXT };
    }

    const bootTokens = typeof boot.tokens === 'number' ? boot.tokens : 0;
    const bootBudget = typeof boot.tokenBudget === 'number' ? boot.tokenBudget : bootTokens;
    const rawSources = Array.isArray(boot.sources) ? boot.sources : [];

    const sources: Array<{ path: string; kind: string }> = rawSources
      .filter((s): s is string => typeof s === 'string')
      .map((s) => ({ path: s, kind: 'reference' }));

    const fullMarkdown = typeof boot.content === 'string' ? boot.content : undefined;

    const rawIncluded = Array.isArray(boot.included) ? boot.included : [];
    const rawTrimmed = Array.isArray(boot.trimmed) ? boot.trimmed : [];
    const parseSections = (arr: unknown[]) =>
      arr
        .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
        .map((s) => ({
          source: String(s.source ?? ''),
          heading: String(s.heading ?? ''),
          tokens: typeof s.tokens === 'number' ? s.tokens : 0,
          content: String(s.content ?? ''),
        }));

    return {
      type: 'boot_context',
      source: 'contexgin',
      sourceCount: sources.length,
      tokenCount: bootTokens,
      tokenBudget: bootBudget,
      sources,
      included: parseSections(rawIncluded),
      trimmed: parseSections(rawTrimmed),
      fullMarkdown,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.info('ContexGin not reachable, trying local fallback', { error: msg });
    return allowLocalExecutableFallback
      ? localBootContextFallback(repoRoot, protectedRunner)
      : { ...FALLBACK_BOOT_CONTEXT };
  }
}

let mcpServers: Record<string, McpServerConfig> = {};
try {
  const configured = rejectReservedMcpServerCollisions(loadMcpServers());
  mcpServers = configured.servers;
  if (configured.rejected.length > 0) {
    log.error('ignored configured MCP servers using reserved host names', {
      names: configured.rejected,
    });
  }
} catch (err: unknown) {
  log.error('failed to load MCP servers', { error: err instanceof Error ? err.message : err });
}

export function getMcpServerNames(): string[] {
  return Object.keys(mcpServers);
}

export const BASE_REPO = process.env.REPO_PATH || '';

/** Check whether worktree isolation is enabled.
 *  WORKTREE_ENABLED=false is an absolute ceiling (always wins).
 *  Otherwise: per-session override > .mitzo.json config > default true. */
export function isIsolationEnabled(perSession?: boolean): boolean {
  if (process.env.WORKTREE_ENABLED === 'false') return false;
  if (perSession !== undefined) return perSession;
  return getRepoConfig().isolation;
}

/**
 * Resolve the CWD for a session, handling resume and worktree cleanup.
 * Extracted for testability — injectable deps for event store and filesystem.
 */
export function resolveResumeCwd(
  options: { resume?: string; cwd?: string },
  deps?: {
    getSession: (id: string) => { cwd?: string | null } | null;
    pathExists: (p: string) => boolean;
  },
): string {
  if (options.cwd) return options.cwd;
  if (!options.resume) return BASE_REPO;

  const store = deps ?? {
    getSession: (id: string) => eventStore.getSession(id),
    pathExists: (p: string) => existsSync(p),
  };

  const meta = store.getSession(options.resume);
  if (meta?.cwd) {
    if (store.pathExists(meta.cwd)) return meta.cwd;
    if (deps) return BASE_REPO;
    mkdirSync(meta.cwd, { recursive: true });
    log.info('resume: re-created original CWD directory for SDK path encoding', {
      sessionId: options.resume,
      cwd: meta.cwd,
    });
    return meta.cwd;
  }
  return BASE_REPO;
}

/**
 * Check if a resume CWD is a valid git directory (worktree or repo).
 * If invalid and the path looks like a worktree, attempt recreation.
 */
export function validateResumable(
  cwd: string,
  _resumeId: string,
  deps?: {
    isGitDir: (path: string) => boolean;
    recreateWorktree: (wtId: string, repoRoot: string) => string;
  },
): { valid: boolean; recreated?: boolean } {
  const isGitDir =
    deps?.isGitDir ??
    ((p: string) => {
      try {
        execFileSync('git', ['-C', p, 'rev-parse', '--git-dir'], { stdio: 'pipe', timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    });

  if (isGitDir(cwd)) return { valid: true };

  const wtMatch = cwd.match(/\/(\.claude|\.cursor)\/worktrees\/([^/]+)$/);
  if (!wtMatch) return { valid: false };

  const [, prefix, wtId] = wtMatch;
  const repoRoot = cwd.slice(0, cwd.indexOf(`/${prefix}/worktrees/`));
  const recreate =
    deps?.recreateWorktree ??
    ((id: string, repo: string) =>
      createWorktree(id, repo, { prefix: prefix as '.claude' | '.cursor' }));

  try {
    recreate(wtId, repoRoot);
    return { valid: true, recreated: true };
  } catch {
    return { valid: false };
  }
}

/** Generate a session-scoped worktree ID: YYYY-MM-DD-<12 hex chars>. */
export function generateWtId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const rand = randomUUID().replace(/-/g, '').slice(0, 12);
  return `${date}-${rand}`;
}

const MODE_TO_SDK: Record<MitzoMode, string> = {
  ask: 'plan',
  agent: 'default',
  auto: 'default',
};

export const registry = new SessionRegistry((sessionId) =>
  (_connRegistry?.getConnectionsWatching(sessionId, true) ?? []).map(({ transport }) => transport),
);

/** Load repo config with short TTL cache — fresh enough for hot-reload, avoids redundant disk I/O. */
let _cachedConfig: ReturnType<typeof loadRepoConfig> | null = null;
let _cachedAt = 0;
const CONFIG_TTL_MS = 5_000;

export function getRepoConfig() {
  const now = Date.now();
  if (_cachedConfig && now - _cachedAt < CONFIG_TTL_MS) return _cachedConfig;
  _cachedConfig = loadRepoConfig(BASE_REPO, {
    pathCeiling: process.env.MITZO_REPO_PATH_CEILING,
  });
  _cachedAt = now;
  return _cachedConfig;
}

export const AVAILABLE_MODELS = LEGACY_MODELS;

/** Split "claude-opus-4-8:max" → { model: "claude-opus-4-8", effort: "max" } */
export function parseModelSpec(spec?: string): { model: string; effort: string | undefined } {
  if (!spec) return { model: '', effort: undefined };
  const idx = spec.indexOf(':');
  if (idx === -1) return { model: spec, effort: undefined };
  return { model: spec.slice(0, idx), effort: spec.slice(idx + 1) };
}

// --- Pure helper functions ---

/** Send data via transport (isOpen guard is inside the transport). */
function send(transport: SessionTransport, data: Record<string, unknown> | BootContextMessage) {
  if (transport.isOpen()) transport.send(data as Record<string, unknown>);
}

const IPV4_PRELOAD = join(dirname(fileURLToPath(import.meta.url)), 'ipv4-preload.cjs');

// launchctl resolves the live socket — the inherited one goes stale after sleep/wake.
export function resolveSshAuthSock(): string | null {
  if (platform() !== 'darwin') return null;
  try {
    const sock = execFileSync('launchctl', ['getenv', 'SSH_AUTH_SOCK'], {
      encoding: 'utf8',
      timeout: 500,
    }).trim();
    return sock || null;
  } catch {
    return null;
  }
}

export function buildSdkChildEnvironment(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  env.CLAUDE_CODE_USE_VERTEX = process.env.CLAUDE_CODE_USE_VERTEX || '1';
  env.ANTHROPIC_VERTEX_PROJECT_ID = process.env.ANTHROPIC_VERTEX_PROJECT_ID || '';
  env.CLOUD_ML_REGION = process.env.CLOUD_ML_REGION || 'us-east5';

  // Force IPv4-only DNS in the spawned CLI process. Undici's bundled
  // autoSelectFamily ignores --dns-result-order, so we patch dns.lookup
  // via a preload script to always resolve IPv4.
  const nodeOpts = env.NODE_OPTIONS || '';
  if (!nodeOpts.includes('ipv4-preload')) {
    env.NODE_OPTIONS = nodeOpts
      ? `${nodeOpts} --require=${IPV4_PRELOAD}`
      : `--require=${IPV4_PRELOAD}`;
  }

  prependConfiguredVenvPaths(env);

  const sock = resolveSshAuthSock();
  if (sock) env.SSH_AUTH_SOCK = sock;

  delete env.AUTH_PASSPHRASE;
  delete env.AUTH_SECRET;
  delete env.NTFY_AUTH_TOKEN;
  // The approved publisher uses these on the controller; models must not inherit them.
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

function restrictedChildEnv(): Record<string, string> {
  return Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]!]] : [],
    ),
  );
}

function prependConfiguredVenvPaths(env: Record<string, string>): void {
  const existingPath = env.PATH || '/usr/bin:/bin:/usr/local/bin';
  env.PATH = [...getRepoConfig().resolvedVenvPaths, existingPath].join(':');
}

/** Keep native provider environments narrow while preserving configured project runtimes. */
export function nativeExecutionEnv(): Record<string, string> {
  const env = restrictedChildEnv();
  prependConfiguredVenvPaths(env);
  return env;
}

export function resolveThinking(
  spec?: string,
):
  | { type: 'adaptive'; display: 'summarized' }
  | { type: 'enabled'; budgetTokens: number; display: 'summarized' }
  | undefined {
  const { model, effort } = parseModelSpec(spec);
  // Opus 4.7+ rejects fixed budgets and omits thinking text unless opted in.
  const adaptiveOnlyOpus = /^claude-opus-(?:4-[7-9]|[5-9])(?:[.@-]|$)/.test(model);
  if (model.includes('opus') && effort === 'max' && !adaptiveOnlyOpus)
    return { type: 'enabled', budgetTokens: 128_000, display: 'summarized' };
  if (!model || model.includes('opus')) return { type: 'adaptive', display: 'summarized' };
  if (model.includes('sonnet'))
    return { type: 'enabled', budgetTokens: 10_000, display: 'summarized' };
  return undefined;
}

export function resolveClaudeEffort(
  spec?: string,
  reasoningEffort?: string | null,
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  if (reasoningEffort === null) return undefined;
  const effort = reasoningEffort ?? parseModelSpec(spec).effort;
  if (
    effort === 'low' ||
    effort === 'medium' ||
    effort === 'high' ||
    effort === 'xhigh' ||
    effort === 'max'
  )
    return effort;
  return undefined;
}

function getBranch(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      stdio: 'pipe',
      timeout: GIT_BRANCH_TIMEOUT_MS,
    })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

function buildMcpAllowedTools(clientId?: string): string[] {
  const patterns = buildConfiguredMcpAllowedTools(mcpServers);
  if (clientId) {
    const session = registry.get(clientId);
    if (session?.taskContext) {
      patterns.push('mcp__task-board__*');
    }
  }
  return patterns;
}

/**
 * Build an on-demand worktree creation callback for the permission handler.
 * Maps an absolute path to a configured repo and creates a worktree if needed.
 */
function buildOnDemandCreate(wtId: string, clientId: string): OnDemandCreateFn {
  return async (absolutePath: string) => {
    const config = getRepoConfig();
    const allRepos: [string, string][] = [];
    if (BASE_REPO) allRepos.push(['primary', BASE_REPO]);
    for (const [name, repoPath] of Object.entries(config.repos)) {
      allRepos.push([name, repoPath]);
    }
    for (const [name, repoPath] of allRepos) {
      if (!absolutePath.startsWith(repoPath + '/') && absolutePath !== repoPath) continue;
      try {
        const worktreePath = await createWorktreeAsync(wtId, repoPath);
        const sessionId = registry.get(clientId)?.sessionId;
        if (sessionId) {
          eventStore.append(sessionId, 'worktree_opened', {
            v: 2,
            type: 'worktree_opened',
            ts: Date.now(),
            sessionId,
            repoName: name,
            path: worktreePath,
          });
        }
        return { repoName: name, worktreePath };
      } catch (err) {
        log.error('on-demand worktree creation failed', {
          repo: name,
          wtId,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }
    return null;
  };
}

/**
 * Create worktrees for the primary repo and all configured secondary repos.
 * All worktrees share the same session-scoped wtId. Returns the primary
 * worktree path as cwd, plus a map of all repo worktrees.
 */
export function createSessionWorktrees(
  transport: SessionTransport,
  baseCwd: string,
  wtId: string,
  options: { resume?: string; cwd?: string; isolation?: boolean },
): {
  cwd: string;
  wtId: string;
  worktreePath?: string;
  repoWorktrees: Map<string, { path: string; wtId: string }>;
} {
  const repoWorktrees = new Map<string, { path: string; wtId: string }>();

  // Skip worktree creation when resuming, using custom cwd, or disabled
  if (!isIsolationEnabled(options.isolation) || options.resume || options.cwd || !BASE_REPO) {
    return { cwd: baseCwd, wtId, repoWorktrees };
  }

  // Create primary worktree only — secondary repos are created on-demand
  // by the worktree guard when an agent first writes to them (Phase 2a).
  let primaryPath: string | undefined;
  try {
    primaryPath = createWorktree(wtId, BASE_REPO);
    repoWorktrees.set('primary', { path: primaryPath, wtId });
    writeFileSync(
      join(primaryPath, '.mitzo-session'),
      JSON.stringify({ wtId, createdAt: new Date().toISOString() }) + '\n',
    );
    const config = getRepoConfig();
    if (config.runtimeSymlinks.length > 0) {
      symlinkRuntimeDirs(BASE_REPO, primaryPath, config.runtimeSymlinks);
    }
    send(transport, { type: 'worktree', path: primaryPath });
    log.info('primary worktree created', { wtId, path: primaryPath });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('primary worktree creation failed', { error: message });
    send(transport, {
      type: 'error',
      error: `Worktree creation failed: ${message}`,
    });
    throw new Error(`Worktree creation failed: ${message}`, { cause: err });
  }

  return {
    cwd: primaryPath,
    wtId,
    worktreePath: primaryPath,
    repoWorktrees,
  };
}

function buildTaskMcpServer(clientId: string): Record<string, McpServerConfig> | null {
  const session = registry.get(clientId);
  if (!session?.taskContext) return null;
  const port = Number.parseInt(process.env.PORT || '3100', 10);
  const entrypoint = resolveBundledMcpEntrypoint(import.meta.url, 'task-mcp-server');
  return {
    [TASK_MCP_SERVER_NAME]: {
      command: entrypoint.command,
      args: [
        ...entrypoint.args,
        '--base-url',
        localHttpBaseUrl(port, localServerUsesTls()),
        '--client-id',
        clientId,
        ...(session.sessionId &&
        (session.taskContext.workerAllocationId ||
          _taskStore?.getTelosExecutionBinding(session.taskContext.currentTaskId))
          ? ['--session-id', session.sessionId, '--task-id', session.taskContext.currentTaskId]
          : []),
      ],
      env: { MITZO_INTERNAL_TOKEN: INTERNAL_TOKEN },
    },
  };
}

function buildTelosMcpServer(clientId: string): Record<string, McpServerConfig> {
  const port = Number.parseInt(process.env.PORT || '3100', 10);
  const entrypoint = resolveBundledMcpEntrypoint(import.meta.url, 'telos-mcp-server');
  return {
    [TELOS_MCP_SERVER_NAME]: {
      command: entrypoint.command,
      args: [
        ...entrypoint.args,
        '--base-url',
        localHttpBaseUrl(port, localServerUsesTls()),
        '--client-id',
        clientId,
        ...(registry.get(clientId)?.sessionId
          ? ['--session-id', registry.get(clientId)!.sessionId!]
          : []),
      ],
      env: { MITZO_INTERNAL_TOKEN: INTERNAL_TOKEN },
    },
  };
}

function buildTaskPromptForSession(clientId: string): string {
  if (!_taskStore) return '';
  const session = registry.get(clientId);
  if (!session?.taskContext) return '';
  return buildTaskSystemPrompt(_taskStore, session.taskContext.currentTaskId);
}

export function supportsHostTaskTools(openShellSelected: boolean): boolean {
  return !openShellSelected;
}

/**
 * Build system prompt section listing all session worktrees.
 * Lists ALL repos including primary so the agent has a complete lookup table
 * for navigating between repos (the "cd back" problem).
 */
export function buildWorktreeSystemPrompt(
  repoWorktrees: Map<string, { path: string; wtId: string }>,
): string {
  if (repoWorktrees.size === 0) return '';

  const lines = ['\n\n## Session Worktrees'];
  lines.push(`Session ID: ${repoWorktrees.values().next().value?.wtId ?? 'unknown'}`);
  lines.push(
    'This session has isolated worktrees. ALL work MUST happen in these paths. ' +
      'When switching repos, cd to the worktree path — never to the repo root.',
  );
  lines.push('');
  for (const [name, { path }] of repoWorktrees) {
    const label = name === 'primary' ? `${name} (cwd)` : name;
    lines.push(`- **${label}**: \`${path}\``);
  }
  lines.push('');
  lines.push(
    'Worktrees for secondary repos are created on first write. ' +
      'Env vars `$MITZO_REPO_<NAME>` hold worktree paths once created. ' +
      'Read operations from main worktrees are OK for reference.',
  );

  const config = getRepoConfig();
  if (config.runtimeSymlinks.length > 0) {
    lines.push('');
    lines.push(
      `**Warning:** Runtime dirs (${config.runtimeSymlinks.join(', ')}) are symlinked from ` +
        'the base repo — they are shared mutable state across sessions. ' +
        'Do not install/upgrade packages in a worktree session.',
    );
  }

  return lines.join('\n');
}

export function buildOpenShellWorkspaceSystemPrompt(workdir: string, wtId: string): string {
  return [
    '\n\n## OpenShell Session Workspace',
    `Session ID: ${wtId}`,
    `The task workspace is \`${workdir}\` inside OpenShell.`,
    'All reads, edits, and commands must use this sandbox workspace. Host worktree paths are controller metadata and are not reachable from the agent runtime.',
  ].join('\n');
}

const CONTEXT_BLOCK_MAX_BYTES = 100 * 1024; // 100 KB

/** Escape characters that would break XML attribute values. */
function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function assemblePrompt(
  prompt: string,
  cwd: string,
  images?: Array<{ data: string; mediaType: string }>,
  contextBlocks?: string[],
  sourceSnapshots?: SourceSnapshot[],
): string {
  let result = prompt;
  result = assembleSourceSnapshots(result, sourceSnapshots);

  // Inject context blocks before the user's message
  if (contextBlocks?.length) {
    const config = getRepoConfig();
    const blocks: string[] = [];
    for (const name of contextBlocks) {
      const filePath = config.contextBlocks[name];
      if (!filePath) continue;
      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        log.warn('context block file not found', { name, path: filePath });
        continue;
      }
      if (Buffer.byteLength(content, 'utf-8') > CONTEXT_BLOCK_MAX_BYTES) {
        content = Buffer.from(content, 'utf-8')
          .subarray(0, CONTEXT_BLOCK_MAX_BYTES)
          .toString('utf-8');
        content += '\n\n[… truncated at 100 KB]';
        log.warn('context block truncated', {
          name,
          path: filePath,
          maxBytes: CONTEXT_BLOCK_MAX_BYTES,
        });
      }
      const safeName = escapeXmlAttr(name);
      const safePath = escapeXmlAttr(filePath);
      blocks.push(`<context name="${safeName}" source="${safePath}">\n${content}\n</context>`);
    }
    if (blocks.length > 0) {
      const preamble =
        'The user has attached the following reference files for this message.\nUse them to inform your response.';
      result = `${preamble}\n\n${blocks.join('\n\n')}\n\n---CONTEXT_END---\n${result}`;
    }
  }

  // Append image references
  if (images?.length) {
    const paths = stageImages(cwd, images);
    const imageRefs = paths.map((p) => `- ${p}`).join('\n');
    result = `${result}\n\nI've attached ${paths.length} image(s). Read them using the Read tool:\n${imageRefs}`;
  }

  return result;
}

function stageImages(cwd: string, images: Array<{ data: string; mediaType: string }>): string[] {
  const imgDir = join(cwd, '.mitzo-images');
  mkdirSync(imgDir, { recursive: true });

  const extMap: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
  };

  const paths: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const ext = extMap[img.mediaType] || '.jpg';
    const filename = `image-${Date.now()}-${i}${ext}`;
    const filePath = join(imgDir, filename);
    writeFileSync(filePath, Buffer.from(img.data, 'base64'));
    paths.push(filePath);
  }
  return paths;
}

// --- Main orchestrator ---

function makeUserMessage(
  content: string,
  priority: 'now' | 'next' | 'later' = 'next',
  messageId?: string,
  providerAdmission?: ProviderDispatchAdmission,
  inputUuid?: SDKUserMessage['uuid'],
  mitzoImages?: Array<{ data: string; mediaType: string }>,
): SDKUserMessage & {
  mitzoMessageId?: string;
  providerAdmission?: ProviderDispatchAdmission;
  mitzoImages?: Array<{ data: string; mediaType: string }>;
} {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    priority,
    ...(messageId ? { mitzoMessageId: messageId } : {}),
    ...(providerAdmission ? { providerAdmission } : {}),
    ...(inputUuid ? { uuid: inputUuid } : {}),
    ...(mitzoImages?.length ? { mitzoImages: structuredClone(mitzoImages) } : {}),
  };
}

export { nativeStartupSessionId } from './ordinary-repository-startup.js';

export async function startChat(
  transport: SessionTransport,
  clientId: string,
  prompt: string,
  options: {
    resume?: string;
    initialSessionId?: string;
    repositoryWorkspaceId?: string;
    cwd?: string;
    model?: string;
    accountId?: string;
    reasoningEffort?: string | null;
    accountProfiles?: AccountProfiles;
    extraTools?: string;
    skillAllowedTools?: string[];
    isolation?: boolean;
    mode?: MitzoMode;
    resumePermission?: ResumePermission;
    images?: Array<{ data: string; mediaType: string }>;
    contextBlocks?: string[];
    sourceSnapshots?: SourceSnapshot[];
    clientMsgId?: string;
    onSessionResolved?: (sessionId: string) => void;
    onStartupAdmission?: (error?: unknown) => void;
    onFirstEventOutcome?: (error?: Error) => void;
    onTerminalOutcome?: (error?: Error) => void;
    /** Trusted observers for independently owned ordinary contributor turns. */
    ordinaryTurnLifecycle?: OrdinaryTurnLifecycle;
    /** Explicit contributor guidance supplied by the trusted collaboration owner. */
    contributorGuidance?: string;
    /** Trusted caller borrows a workspace owned outside this child session. */
    retainWorkspace?: boolean;
    contributorExecution?: OrdinaryContributorExecution;
    onQueryReady?: (query: { interrupt(): Promise<void> }) => void;
    onTurnResult?: (result: { is_error?: boolean }, inputUuid?: string) => void;
    /** Trusted live-query observer, never a viewer transport or replay subscription. */
    onQueryEvent?: (event: Readonly<Record<string, unknown>>) => void;
    adviserScope?: AdviserTaskScope;
    telosTaskId?: string;
    agentName?: string;
    agentProfile?: AgentProfileSelection;
    operatorConnectionId?: string;
    userIntent?: string;
    reattachOnly?: boolean;
    /** Sealed backend-owned SDK authority; never read from a client request. */
    ordinarySdkAuthority?: OrdinaryLocalVertexSdkAuthority;
    ordinarySdkCommandOwner?: (
      query: Query,
      push: (
        id: string,
        admission: Readonly<OrdinaryLocalCommandAdmission>,
        payload: Readonly<Record<string, unknown>>,
      ) => void,
      reopen: (selection: OrdinaryLocalCommandAdmission['selection']) => Promise<void>,
    ) => OrdinaryLocalVertexCommandOwner;
  },
) {
  // Resolve every identity the legacy startup path may derive before account,
  // repository, registry or transport effects. Keep one generated message ID so
  // the native path cannot later select an unchecked conversation identity.
  const initialMessageId = options.clientMsgId ?? randomUUID();
  const onStartupAdmission = options.onStartupAdmission;
  let startupAdmissionSettled = false;
  options = {
    ...options,
    clientMsgId: initialMessageId,
    ...(onStartupAdmission
      ? {
          onStartupAdmission: (error?: unknown) => {
            if (startupAdmissionSettled) return;
            startupAdmissionSettled = true;
            onStartupAdmission(error);
          },
        }
      : {}),
  };
  const repositoryStartupId =
    options.repositoryWorkspaceId && !options.resume && !options.ordinarySdkAuthority
      ? nativeStartupSessionId(`repository:${options.repositoryWorkspaceId}`)
      : undefined;
  const commandStartupId =
    !options.resume && !options.initialSessionId && !repositoryStartupId
      ? nativeStartupSessionId(initialMessageId)
      : undefined;
  try {
    const retainedBinding = options.resume
      ? eventStore.getSession(options.resume)?.accountBinding
      : undefined;
    const profiles =
      options.accountProfiles ??
      (options.accountId || retainedBinding ? loadAccountProfiles() : undefined);
    let selected;
    if (options.ordinarySdkAuthority && retainedBinding) {
      // A sealed SDK command retains its original account identity while each
      // new command selects a currently supported model. Retiring that original
      // model must not rebind the account or prevent a qualified cold command.
      if (
        !(options.ordinarySdkAuthority instanceof OrdinaryLocalVertexSdkAuthority) ||
        !profiles ||
        options.accountId !== retainedBinding.accountId
      )
        throw Error('Original SDK account unavailable');
      profiles.resumeRouting(retainedBinding);
      selected = retainedBinding;
    } else selected = resolveAccountSelection(options, retainedBinding, !!options.resume, profiles);
    if (
      selected?.provider === 'openai' &&
      (!(
        (process.env.MITZO_OPENSHELL_ENABLED === '1' ||
          !!process.env.MITZO_OPENSHELL_SANDBOX_NAME) &&
        process.env.MITZO_OPENSHELL_OPENAI_API_ENABLED !== '0'
      ) ||
        (options.resume && getNativeResponsesStore().load(options.resume, selected)))
    )
      throw Error(
        'Custom Responses execution is retired. Use native ordinary admission or review a linked native continuation.',
      );
    if (options.ordinarySdkAuthority) {
      if (
        !(options.ordinarySdkAuthority instanceof OrdinaryLocalVertexSdkAuthority) ||
        !options.ordinarySdkCommandOwner
      )
        throw Error('Original SDK authority unavailable');
      await options.ordinarySdkAuthority.assertCurrent(new AbortController().signal);
    }
    for (const sessionId of [
      options.resume,
      options.initialSessionId,
      repositoryStartupId,
      commandStartupId,
    ]) {
      if (sessionId && eventStore.getSessionRuntimeBinding(sessionId)) {
        if (!(options.ordinarySdkAuthority instanceof OrdinaryLocalVertexSdkAuthority))
          throw new Error('Runtime-bound commands require guarded admission');
        options.ordinarySdkAuthority.assertStartup(sessionId, initialMessageId);
      }
    }
  } catch (error) {
    options.onStartupAdmission?.(error);
    throw error;
  }
  let releaseRepositoryStartup: (() => void) | undefined;
  if (repositoryStartupId) {
    if (
      eventStore.getSessionState(repositoryStartupId) ||
      registry.findBySessionId(repositoryStartupId)
    )
      throw new Error(
        'This repository already has a conversation. Resume its original conversation.',
      );
    options = { ...options, initialSessionId: repositoryStartupId };
    releaseRepositoryStartup = reserveRepositoryStartup(repositoryStartupId);
  }
  const startupGuard: { admission?: ProviderDispatchAdmission; releaseContext?: () => void } = {};
  let releaseOrdinaryStartup: (() => void) | undefined;
  return withSpanAsync(
    'chat.start',
    {
      'chat.clientId': clientId,
      'chat.resume': options.resume ?? '',
      'chat.mode': options.mode ?? 'agent',
    },
    async () => {
      if (options.resume && !eventStore.getSession(options.resume))
        throw new Error('Conversation is not registered. Import external history before resuming.');
      const startupSessionId = options.resume ?? options.initialSessionId;
      if (startupSessionId) {
        if (options.contributorExecution && registry.findBySessionId(startupSessionId))
          throw new Error('Contributor child already has a live ordinary query');
        authorizeOrdinaryContributorStart(
          eventStore,
          startupSessionId,
          options.contributorExecution,
        );
      }
      if (!options.ordinarySdkAuthority)
        releaseOrdinaryStartup = eventStore.reserveOrdinaryStartup(
          [options.resume, options.initialSessionId].filter((id): id is string => Boolean(id)),
        );
      return _startChatInner(transport, clientId, prompt, options, startupGuard);
    },
  )
    .catch((error: unknown) => {
      options.onStartupAdmission?.(error);
      throw error;
    })
    .finally(() => {
      try {
        cleanupUndispatchedStartup(startupGuard.admission, clientId);
      } finally {
        releaseOrdinaryStartup?.();
        startupGuard.releaseContext?.();
        releaseRepositoryStartup?.();
      }
    });
}

async function _startChatInner(
  transport: SessionTransport,
  clientId: string,
  prompt: string,
  options: {
    resume?: string;
    initialSessionId?: string;
    repositoryWorkspaceId?: string;
    cwd?: string;
    model?: string;
    accountId?: string;
    reasoningEffort?: string | null;
    accountProfiles?: AccountProfiles;
    extraTools?: string;
    skillAllowedTools?: string[];
    isolation?: boolean;
    mode?: MitzoMode;
    resumePermission?: ResumePermission;
    images?: Array<{ data: string; mediaType: string }>;
    contextBlocks?: string[];
    sourceSnapshots?: SourceSnapshot[];
    clientMsgId?: string;
    onSessionResolved?: (sessionId: string) => void;
    onStartupAdmission?: (error?: unknown) => void;
    onFirstEventOutcome?: (error?: Error) => void;
    onTerminalOutcome?: (error?: Error) => void;
    /** Trusted observers for independently owned ordinary contributor turns. */
    ordinaryTurnLifecycle?: OrdinaryTurnLifecycle;
    /** Explicit contributor guidance supplied by the trusted collaboration owner. */
    contributorGuidance?: string;
    /** Trusted caller borrows a workspace owned outside this child session. */
    retainWorkspace?: boolean;
    contributorExecution?: OrdinaryContributorExecution;
    onQueryReady?: (query: { interrupt(): Promise<void> }) => void;
    onTurnResult?: (result: { is_error?: boolean }, inputUuid?: string) => void;
    /** Trusted live-query observer, never a viewer transport or replay subscription. */
    onQueryEvent?: (event: Readonly<Record<string, unknown>>) => void;
    adviserScope?: AdviserTaskScope;
    telosTaskId?: string;
    agentName?: string;
    agentProfile?: AgentProfileSelection;
    operatorConnectionId?: string;
    userIntent?: string;
    reattachOnly?: boolean;
    /** Sealed backend-owned SDK authority; never read from a client request. */
    ordinarySdkAuthority?: OrdinaryLocalVertexSdkAuthority;
    ordinarySdkCommandOwner?: (
      query: Query,
      push: (
        id: string,
        admission: Readonly<OrdinaryLocalCommandAdmission>,
        payload: Readonly<Record<string, unknown>>,
      ) => void,
      reopen: (selection: OrdinaryLocalCommandAdmission['selection']) => Promise<void>,
    ) => OrdinaryLocalVertexCommandOwner;
  },
  startupGuard: { admission?: ProviderDispatchAdmission; releaseContext?: () => void },
) {
  const openShellAvailable =
    process.env.MITZO_OPENSHELL_ENABLED === '1' || !!process.env.MITZO_OPENSHELL_SANDBOX_NAME;
  const initialMessageId = options.clientMsgId ?? randomUUID();
  let openShellRequested = false;
  let accountBinding;
  let agentProfile: AgentLibraryVersion | undefined;
  let codexProfile: CodexAccountProfile | undefined;
  let toolRoute: string;
  let apiKey: string | undefined;
  let enrolledOpenAIAccount = false;
  let apiCredentialRef: Parameters<typeof credentials.resolve>[0] | undefined;
  let gemini: GeminiOptions | undefined;
  let accountEnv: Record<string, string> | undefined;
  try {
    if (options.resume && eventStore.getLatestEvent(options.resume, 'adviser_task_scope'))
      throw Error('Adviser history is read-only; ask again with a reviewed snapshot');
    if (
      options.adviserScope &&
      (!(options.adviserScope instanceof AdviserTaskScope) ||
        options.resume ||
        options.agentProfile ||
        options.contextBlocks?.length ||
        options.sourceSnapshots?.length)
    )
      throw Error('Original scoped adviser context required');
    const storedMeta = options.resume ? eventStore.getSession(options.resume) : undefined;
    const storedBinding = storedMeta?.accountBinding;
    const profiles =
      options.accountProfiles ??
      (options.accountId || storedBinding ? loadAccountProfiles() : undefined);
    if (options.ordinarySdkAuthority && storedBinding) {
      if (!profiles || options.accountId !== storedBinding.accountId)
        throw Error('Original SDK account unavailable');
      profiles.resumeRouting(storedBinding);
      accountBinding = storedBinding;
    } else
      accountBinding = resolveAccountSelection(options, storedBinding, !!options.resume, profiles);
    if (
      accountBinding?.provider === 'openai' &&
      (!openShellAvailable || process.env.MITZO_OPENSHELL_OPENAI_API_ENABLED === '0')
    )
      throw new Error(
        'Custom Responses execution is retired. Use native ordinary admission or review a linked native continuation.',
      );
    options = {
      ...options,
      contributorGuidance: resolveOrdinaryContributorGuidance(
        eventStore,
        options.resume ?? options.initialSessionId,
        accountBinding ?? undefined,
        options.contributorGuidance,
      ),
    };
    if (options.resume ?? options.initialSessionId)
      resolveTelosWorkRoleContext(
        eventStore,
        (options.resume ?? options.initialSessionId)!,
        accountBinding ?? undefined,
      );
    toolRoute =
      accountBinding?.provider === 'openai-codex'
        ? openShellAvailable
          ? 'openshell'
          : 'codex'
        : accountBinding?.provider === 'openai' &&
            openShellAvailable &&
            process.env.MITZO_OPENSHELL_OPENAI_API_ENABLED !== '0'
          ? 'openshell'
          : ['openai', 'google-vertex'].includes(accountBinding?.provider ?? '')
            ? 'local-api'
            : 'claude-sdk';
    if (options.agentProfile || storedMeta?.agentProfile)
      agentProfile = await resolveChatAgentProfile({
        requested: options.agentProfile,
        stored: storedMeta?.agentProfile,
        resume: !!options.resume,
        provider: accountBinding?.provider,
        toolRoute,
        lookup: (selection) => readAgentLibraryProfile(selection, options.operatorConnectionId),
      });
    assertAgentToolRoute(agentProfile?.definition, toolRoute);
    // Reject unsupported context before credential preflight, workspace creation,
    // or snapshot persistence. Host Responses and SDK routes retain pack support.
    if (
      accountBinding?.provider === 'openai-codex' ||
      (accountBinding?.provider === 'openai' &&
        openShellAvailable &&
        process.env.MITZO_OPENSHELL_OPENAI_API_ENABLED !== '0')
    )
      assertNativeCodexContextAdmission(
        agentProfile?.definition.contextRecipe,
        storedMeta?.agentContext,
        // Profile resolution may await a remote lookup; re-read retained context.
        options.resume || options.initialSessionId
          ? eventStore.getSession((options.resume ?? options.initialSessionId)!)?.agentContext
          : undefined,
      );
    if (!accountBinding && openShellAvailable)
      throw new Error('OpenShell execution requires an explicit account selection');
    if (options.ordinaryTurnLifecycle) {
      if (!accountBinding || !profiles)
        throw new Error('Selected account does not support ordinary contributor turns');
      assertOrdinaryCodexContributorAccount(profiles, accountBinding, options.mode);
      // Availability was captured before profile lookup. Do not fall back to
      // Responses when configuration changed during that awaited lookup.
      if (accountBinding.provider === 'openai' && !openShellAvailable)
        throw new Error('Selected account does not support ordinary contributor turns');
    }
    if (accountBinding) {
      requireCustodianOrdinaryRuntime(custodianControllerMode, accountBinding.provider);
      openShellRequested =
        openShellAvailable &&
        (accountBinding.provider === 'openai-codex' ||
          (accountBinding.provider === 'openai' &&
            process.env.MITZO_OPENSHELL_OPENAI_API_ENABLED !== '0'));
      options = {
        ...options,
        ...resolveEffectiveAccountSelection(options, storedMeta, accountBinding),
      };
      if (
        accountBinding.provider === 'openai' ||
        accountBinding.provider === 'google-vertex' ||
        accountBinding.provider === 'anthropic-vertex'
      )
        profiles!.validateModelSelection(accountBinding, options.model!, options.reasoningEffort);
      if (accountBinding.provider === 'openai-codex') {
        if (options.skillAllowedTools)
          throw new Error('Codex restricted skill tool ceilings are not yet supported');
        codexProfile = profiles!.codexProfile(accountBinding);
        if (openShellRequested) {
          if (!codexProfile.sandboxProvider)
            throw new Error('The selected ChatGPT account has no OpenShell provider binding');
          if (
            codexProfile.planType !== 'api' &&
            (process.env.MITZO_OPENSHELL_ENABLED !== '1' ||
              codexProfile.sandboxProviderType !== 'openai-codex-oauth' ||
              !codexProfile.sandboxProviderId ||
              !codexProfile.sandboxGrantId)
          )
            throw new Error(
              'ChatGPT subscription requires a complete brokered Codex OAuth binding; API billing substitution is forbidden.',
            );
        } else {
          if (!codexProfile.credentialRef)
            throw new Error('The selected ChatGPT account has no host login binding');
          const preflight = CodexAppServerClient.launch(codexProfile.credentialRef);
          try {
            await preflight.initialize();
            await verifyCodexAccount(preflight, codexProfile, accountBinding);
          } finally {
            preflight.close();
          }
        }
        accountEnv = openShellRequested
          ? restrictedChildEnv()
          : codexEnvironment(codexProfile.credentialRef!, process.env);
      } else if (accountBinding.provider === 'google-vertex') {
        if (options.images?.length)
          throw new Error('Gemini image attachments are not yet supported');
        const profile = profiles!.googleProfile(accountBinding);
        const auth = new GoogleAuth({
          keyFilename: profile.credentialRef,
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        });
        gemini = {
          accountId: accountBinding.accountId,
          projectId: profile.projectId,
          region: profile.region,
          getAccessToken: async () => {
            const token = await auth.getAccessToken();
            if (!token) throw new Error('Google Vertex credentials unavailable');
            return token;
          },
        };
        accountEnv = nativeExecutionEnv();
      } else if (accountBinding.provider === 'openai') {
        const profile = profiles!.apiProfile(accountBinding);
        enrolledOpenAIAccount = profiles!.isEnrolledOpenAIAccount(accountBinding.accountId);
        if (
          enrolledOpenAIAccount &&
          !getConnectionsRuntime()?.openAIEnrollmentAuthority?.manages(accountBinding.accountId)
        )
          throw new Error('OpenAI account enrollment controller is unavailable');
        assertOpenAIKeyController(
          accountBinding.accountId,
          join(BASE_REPO, '.mitzo'),
          !!getConnectionsRuntime()?.assertOpenAIKeyReady,
          openAIKeyResourceBindings({
            credentialRef: profile.credentialRef,
            providerName: profile.sandboxProvider,
            providerId: profile.sandboxProviderId,
          }),
        );
        responsesUserContent(prompt, options.images);
        if (openShellRequested) {
          if (!profile.sandboxProvider)
            throw new Error('The selected API account has no OpenShell provider binding');
          codexProfile = {
            accountId: accountBinding.accountId,
            accountLabel: accountBinding.accountLabel,
            credentialRef: '/sandbox/.codex',
            email: 'openshell-api@invalid',
            planType: 'api',
            sandboxProvider: profile.sandboxProvider,
            model: accountBinding.model,
          };
        } else apiCredentialRef = profile.credentialRef;
        accountEnv = openShellRequested ? restrictedChildEnv() : nativeExecutionEnv();
      } else accountEnv = profiles!.sdkEnv(accountBinding, buildSdkChildEnvironment());
    }
    if (options.adviserScope) {
      if (!accountBinding || accountBinding.provider !== 'anthropic-vertex')
        throw Error('Scoped SDK adviser requires the selected Claude account');
      options.adviserScope.assertSelection(accountBinding, options.reasoningEffort);
    }
    if (options.ordinaryTurnLifecycle && !codexProfile)
      throw new Error('Selected account does not support ordinary contributor turns');
  } catch (err: unknown) {
    options.onStartupAdmission?.(err);
    const diagnostic = err instanceof Error ? codexRuntimeDiagnostic(err) : undefined;
    if (diagnostic)
      log.warn('Codex account preflight failed', {
        clientId,
        ...codexRuntimeErrorTelemetry(err as Error),
        error: diagnostic,
      });
    send(transport, {
      type: 'error',
      error: diagnostic ?? (err instanceof Error ? err.message : 'Account selection failed'),
    });
    return;
  }
  const openShellSelected = !!codexProfile && openShellRequested;
  const openShellWorkdir = openShellSelected
    ? process.env.MITZO_OPENSHELL_ENABLED === '1'
      ? '/sandbox/workspaces/mgmt'
      : process.env.MITZO_OPENSHELL_WORKDIR || '/sandbox/workspaces/mgmt'
    : undefined;
  const abortController = new AbortController();
  const abortAdviser = () => abortController.abort(options.adviserScope?.signal.reason);
  options.adviserScope?.signal.addEventListener('abort', abortAdviser, { once: true });
  if (options.adviserScope?.signal.aborted) abortAdviser();
  options.ordinarySdkAuthority?.bindAbortController(abortController);
  const resumedSession = options.resume
    ? registry.findBySessionId(options.resume)?.session
    : undefined;
  // Read durable policy after account verification. A stopped runtime's captured
  // ceiling is valid only until another mode change has been acknowledged.
  const capturedPermission = options.resumePermission;
  const mode = options.resume
    ? ((resumedSession && effectivePermissionMode(resumedSession)) ??
      (capturedPermission &&
      capturedPermission.revision === permissionRevision(eventStore, options.resume)
        ? capturedPermission.mode
        : eventStore.getSession(options.resume)?.mode) ??
      'agent')
    : (options.mode ?? 'agent');

  let repositoryWorkspace: RepositoryChatWorkspace | undefined;
  if (options.ordinarySdkAuthority) {
    const identity = options.resume ?? options.initialSessionId!;
    const ownedWorkspace = getRepositoryWorkspaces(true).getForConversation(identity);
    repositoryWorkspace = ownedWorkspace;
    if (
      !ownedWorkspace ||
      ownedWorkspace.id !== options.repositoryWorkspaceId ||
      ownedWorkspace.state !== 'claimed' ||
      ownedWorkspace.directory !== options.cwd
    )
      throw Error('Original SDK repository workspace unavailable');
    await options.ordinarySdkAuthority.assertCurrent(abortController.signal);
  } else if (options.repositoryWorkspaceId) {
    if (
      options.resume ||
      !accountBinding ||
      !['openai', 'openai-codex'].includes(accountBinding.provider)
    )
      throw new Error('Repository-backed startup requires a new ordinary OpenAI conversation');
    options = {
      ...options,
      initialSessionId: options.initialSessionId ?? nativeStartupSessionId(initialMessageId),
    };
    const taskRoot = join(BASE_REPO, '.claude', 'repository-tasks');
    if (!openShellSelected) {
      if (!BASE_REPO) throw new Error('Repository task root is not configured');
      mkdirSync(taskRoot, { recursive: true, mode: 0o700 });
    }
    repositoryWorkspace = await selectRepositoryChatWorkspace(
      {
        repositoryWorkspaceId: options.repositoryWorkspaceId,
        conversationId: options.initialSessionId!,
        binding: accountBinding,
        sandbox: openShellSelected,
        taskRoot,
      },
      getRepositoryWorkspaces(),
    );
  } else if (options.resume) {
    const marker = eventStore.getSession(options.resume)?.repositoryWorkspaceId;
    repositoryWorkspace = readRepositoryWorkspaceForConversation(options.resume, marker);
    if (marker && repositoryWorkspace?.id !== marker)
      throw new Error(
        'Repository claim ledger is unavailable or changed; preserve the conversation',
      );
  }
  if (
    repositoryWorkspace?.sandbox !== undefined &&
    repositoryWorkspace.sandbox !== openShellSelected
  )
    throw new Error('Repository workspace runtime changed; preserve the original conversation');
  if (
    repositoryWorkspace?.binding &&
    (!accountBinding ||
      repositoryWorkspace.binding.accountId !== accountBinding.accountId ||
      repositoryWorkspace.binding.provider !== accountBinding.provider ||
      repositoryWorkspace.binding.profileRevision !== accountBinding.profileRevision)
  )
    throw new Error('Repository workspace account binding changed');
  if (repositoryWorkspace && !openShellSelected) {
    if (!repositoryWorkspace.directory)
      throw new Error('Retained repository task directory is unavailable');
    await getRepositoryWorkspaces(true).validateHostTask(
      options.resume ?? options.initialSessionId!,
      repositoryWorkspace.directory,
    );
    options = { ...options, cwd: repositoryWorkspace.directory };
  }
  const baseCwd = openShellWorkdir ?? resolveResumeCwd(options);
  if (repositoryWorkspace) {
    eventStore.upsertSession({
      sessionId: options.resume ?? options.initialSessionId!,
      repositoryWorkspaceId: repositoryWorkspace.id,
      cwd: baseCwd,
      mode,
      ...(accountBinding ? { accountBinding } : {}),
      selectedModel: options.model ?? accountBinding?.model ?? null,
      reasoningEffort: options.reasoningEffort ?? null,
    });
  }
  prompt = repositoryChatContext(repositoryWorkspace) + prompt;
  const nativeProviderSelected = !!apiCredentialRef || !!gemini;

  if (
    nativeProviderSelected &&
    !options.reattachOnly &&
    !options.resume &&
    !options.initialSessionId
  ) {
    options = { ...options, initialSessionId: nativeStartupSessionId(initialMessageId) };
  }

  // Native initial and cold-resume commands need durable identity before any
  // worktree, registry, transcript, or provider queue side effect. New bound
  // sessions receive their canonical ID here so an exact retry can consult the
  // same admission instead of selecting a fresh initial route.
  let initialProviderAdmission: ProviderDispatchAdmission | undefined;
  if (nativeProviderSelected && !options.reattachOnly) {
    const conversationId = options.resume ?? options.initialSessionId ?? randomUUID();
    if (!options.resume && !options.initialSessionId) {
      options = { ...options, initialSessionId: conversationId };
    }
    if (!eventStore.getSession(conversationId)) {
      eventStore.upsertSession({
        sessionId: conversationId,
        cwd: baseCwd,
        mode,
        ...(accountBinding ? { accountBinding } : {}),
        selectedModel: options.model ?? accountBinding?.model ?? null,
        reasoningEffort: options.reasoningEffort ?? null,
      });
    }
    try {
      const stablePrompt = assemblePrompt(
        prompt,
        baseCwd,
        undefined,
        options.contextBlocks,
        options.sourceSnapshots,
      );
      initialProviderAdmission = admitProviderDispatch({
        store: eventStore,
        request: {
          sessionId: conversationId,
          clientMsgId: initialMessageId,
          effectivePrompt: stablePrompt,
          fingerprintSource: providerFingerprintSource(stablePrompt, options.images),
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          accountBinding,
        },
        prepare: () => {},
      });
      if (initialProviderAdmission.duplicate) {
        options.onStartupAdmission?.();
        return;
      }
      startupGuard.admission = initialProviderAdmission;
    } catch (err: unknown) {
      options.onStartupAdmission?.(err);
      send(transport, {
        type: 'error',
        ...(options.resume || options.initialSessionId
          ? { sessionId: options.resume ?? options.initialSessionId }
          : {}),
        error: err instanceof Error ? err.message : 'Provider command admission failed',
      });
      return;
    }
  }
  if (apiCredentialRef) {
    try {
      const runtime = getConnectionsRuntime();
      if (
        accountBinding &&
        enrolledOpenAIAccount &&
        !runtime?.openAIEnrollmentAuthority?.manages(accountBinding.accountId)
      )
        throw new Error('OpenAI account enrollment controller is unavailable');
      const manager =
        accountBinding && runtime?.openAIEnrollmentAuthority?.manages(accountBinding.accountId)
          ? runtime.openAIEnrollmentAuthority
          : accountBinding && runtime?.openAIKeys?.manages(accountBinding.accountId)
            ? runtime.openAIKeys
            : undefined;
      if (manager && accountBinding) {
        // resolveKey holds the custody gate and returns the exact marker-verified
        // value. A separate generic lookup could observe a later unverified key.
        apiKey = await manager.resolveKey(accountBinding.accountId, AbortSignal.timeout(30000));
      } else if (runtime?.assertOpenAIKeyReady && accountBinding) {
        const selectedReference = apiCredentialRef;
        const signal = AbortSignal.any([abortController.signal, AbortSignal.timeout(30_000)]);
        apiKey = await runtime.service.withCredentialRead(async () => {
          signal.throwIfAborted();
          await runtime.assertOpenAIKeyReady!(accountBinding.accountId, signal);
          signal.throwIfAborted();
          const key = await credentials.resolve(selectedReference);
          signal.throwIfAborted();
          return key;
        }, signal);
      } else apiKey = await credentials.resolve(apiCredentialRef);
    } catch (err: unknown) {
      if (initialProviderAdmission) {
        eventStore.transitionExecution(
          initialProviderAdmission.token,
          'TERMINAL',
          'startup_failed',
        );
      }
      options.onStartupAdmission?.(err);
      send(transport, {
        type: 'error',
        ...(options.resume || options.initialSessionId
          ? { sessionId: options.resume ?? options.initialSessionId }
          : {}),
        error: err instanceof Error ? err.message : 'OpenAI credentials unavailable',
      });
      return;
    }
  }
  if (gemini && !options.reattachOnly) {
    try {
      await gemini.getAccessToken();
    } catch (err: unknown) {
      if (initialProviderAdmission) {
        eventStore.transitionExecution(
          initialProviderAdmission.token,
          'TERMINAL',
          'startup_failed',
        );
      }
      options.onStartupAdmission?.(err);
      send(transport, {
        type: 'error',
        ...(options.resume || options.initialSessionId
          ? { sessionId: options.resume ?? options.initialSessionId }
          : {}),
        error: err instanceof Error ? err.message : 'Google Vertex credentials unavailable',
      });
      return;
    }
  }

  if (options.resume) {
    const validation =
      codexProfile || apiKey || gemini
        ? { valid: true }
        : validateResumable(baseCwd, options.resume);
    if (!validation.valid) {
      log.warn('session not resumable, starting fresh', {
        sessionId: options.resume,
        cwd: baseCwd,
      });
      send(transport, {
        type: 'error',
        error: 'Session workspace was cleaned up. Starting a new conversation.',
      });
      delete options.resume;
    }
  }

  // Generate session-scoped worktree ID and create worktrees in all repos
  const wtId = generateWtId();
  let sessionWorktrees: ReturnType<typeof createSessionWorktrees>;
  try {
    sessionWorktrees = openShellSelected
      ? {
          cwd: openShellWorkdir!,
          wtId,
          worktreePath: undefined,
          repoWorktrees: new Map<string, { path: string; wtId: string }>(),
        }
      : createSessionWorktrees(transport, baseCwd, wtId, options);
  } catch (error) {
    options.onStartupAdmission?.(error);
    return;
  }
  const { cwd, worktreePath, repoWorktrees } = sessionWorktrees;

  if (repositoryWorkspace?.directory && !openShellSelected) {
    repoWorktrees.set('primary', { path: repositoryWorkspace.directory, wtId });
  }

  // On resume, rebuild worktreePaths from disk so the system prompt and guard
  // have the full map even after server restart (Phase 2d).
  // Merge discovered entries — the map may already have the primary but be
  // missing lazily-created secondaries after a restart.
  if (!repositoryWorkspace && !openShellSelected && options.resume && BASE_REPO) {
    const config = getRepoConfig();
    const wtIdFromCwd = baseCwd.match(/\/(\.claude|\.cursor)\/worktrees\/([^/]+)/)?.[2];
    if (wtIdFromCwd) {
      const discovered = discoverSessionWorktrees(wtIdFromCwd, BASE_REPO, config.repos);
      for (const [name, entry] of discovered) {
        repoWorktrees.set(name, entry);
      }
      if (discovered.size > 0) {
        log.info('rebuilt worktree map from disk on resume', {
          count: discovered.size,
          wtId: wtIdFromCwd,
        });
      }
    }
  }

  const fullPrompt = options.adviserScope
    ? prompt
    : assemblePrompt(
        prompt,
        cwd,
        codexProfile || nativeProviderSelected ? undefined : options.images,
        options.contextBlocks,
        options.sourceSnapshots,
      );
  const userIntent = options.userIntent ?? prompt;
  if (options.reattachOnly && (!options.resume || !codexProfile))
    throw new Error('Provider-only reattachment requires a resumable Codex conversation');

  // Apply tier overrides from current .mitzo.json (re-read each session start).
  // Always call applyTierOverrides so removed overrides reset to defaults.
  const currentConfig = getRepoConfig();
  applyTierOverrides(currentConfig.toolTierOverrides);

  const mcpAllowed = buildMcpAllowedTools(clientId);
  const extraTools = options.extraTools ? options.extraTools.split(',').map((t) => t.trim()) : [];

  // Resolve agent name early — needed for registration, resume upsert, and boot context.
  const agentName = options.agentName ?? DEFAULT_AGENT_NAME;

  // Streaming-input queue — kept open for the session lifetime.
  const inputQueue = new AsyncQueue<SDKUserMessage>();
  if (!options.reattachOnly && !initialProviderAdmission && !options.ordinarySdkAuthority)
    inputQueue.push(
      makeUserMessage(fullPrompt, 'now', apiKey || gemini ? initialMessageId : undefined),
    );

  if (options.initialSessionId) {
    eventStore.upsertSession({
      sessionId: options.initialSessionId,
      ...(agentProfile ? { agentProfile } : {}),
      cwd,
      mode,
      initialPrompt:
        options.ordinarySdkAuthority || options.sourceSnapshots?.length ? prompt : fullPrompt,
      ...(accountBinding ? { accountBinding } : {}),
      selectedModel: options.model ?? accountBinding?.model ?? null,
      reasoningEffort: options.reasoningEffort ?? null,
    });
  }

  registry.register(clientId, {
    ...(options.operatorConnectionId ? { ownerConnectionId: options.operatorConnectionId } : {}),
    transport,
    abortController,
    // startChat already checked this exact execution against the existing claim.
    ...(options.contributorExecution ? { contributorExecutionOwner: true as const } : {}),
    mode,
    cwd,
    wtId,
    sessionAllowList: new Set<string>(),
    worktreePath,
    agentName,
    ...(accountBinding ? { accountBinding } : {}),
    // Set sessionId early so pre-assistant events are persisted (iOS reconnect).
    ...((options.resume ?? options.initialSessionId)
      ? { sessionId: options.resume ?? options.initialSessionId }
      : {}),
    ...(options.telosTaskId ? { telosTaskId: options.telosTaskId } : {}),
  });

  const session = registry.get(clientId)!;
  bindAgentToolSelection(session, agentProfile?.definition, toolRoute);
  if (options.contributorGuidance !== undefined && session.sessionId)
    saveOrdinaryContributorGuidance(
      eventStore,
      session.sessionId,
      accountBinding ?? undefined,
      options.contributorGuidance,
    );
  if (options.retainWorkspace && session.sessionId) {
    const retained = eventStore
      .getSessionEvents(session.sessionId)
      .some(
        (event) =>
          event.type === 'workspace_retention' && event.payload.policy === 'external-owner',
      );
    if (!retained)
      eventStore.append(session.sessionId, 'workspace_retention', { policy: 'external-owner' });
  }
  if (options.skillAllowedTools) setSkillPolicy(registry, clientId, options.skillAllowedTools);
  session.model = options.model ?? session.model;
  session.inputQueue = inputQueue as { push: (msg: unknown) => void; close: () => void };
  _onSessionChange?.(clientId, 'start');

  // Session state machine: mark CREATED (Phase 1 — write only, no behavior change)
  const stateSessionId = options.resume ?? session.sessionId;
  if (stateSessionId) {
    eventStore.setSessionState(stateSessionId, 'CREATED', { clientId });
  }

  // Copy all repo worktrees into the session for cleanup tracking
  for (const [name, info] of repoWorktrees) {
    session.worktreePaths.set(name, info);
  }

  const branch = repositoryWorkspace?.featureBranch ?? getBranch(cwd);
  session.branch = branch;
  send(transport, { type: 'session_info', branch, cwd, worktree: !!worktreePath, wtId });

  // Pre-register resumed sessions in EventStore so they're discoverable
  // even if the query loop dies before the first assistant event.
  // Preserve existing updatedAt so server restarts don't reset all timestamps.
  if (options.resume) {
    const existingMeta = eventStore.getSession(options.resume);
    eventStore.upsertSession({
      sessionId: options.resume,
      cwd,
      mode,
      branch,
      isActive: true,
      ...(worktreePath ? { wtId } : {}),
      ...(options.telosTaskId ? { telosTaskId: options.telosTaskId } : {}),
      ...(existingMeta ? { updatedAt: existingMeta.updatedAt } : {}),
      agentName,
      ...(options.model ? { selectedModel: options.model } : {}),
      ...(options.reasoningEffort !== undefined
        ? { reasoningEffort: options.reasoningEffort || null }
        : {}),
    });
  }

  // OpenShell owns its workspace lifecycle; only host sessions belong in the
  // host worktree index.
  if (!openShellSelected) {
    try {
      registerSession(BASE_REPO, wtId, repoWorktrees, branch);
    } catch (err: unknown) {
      log.warn('session index write failed', {
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  // Build session env with worktree paths for the agent (all repos including primary)
  const sessionEnv = accountEnv ?? buildSdkChildEnvironment();
  sessionEnv.MITZO_SESSION_ID = wtId;
  sessionEnv.MITZO_AGENT_NAME = agentName;
  for (const [name, { path }] of repoWorktrees) {
    sessionEnv[`MITZO_REPO_${name.toUpperCase()}`] = path;
  }

  // Merge dynamic MCP servers (task board if active)
  const taskMcp = supportsHostTaskTools(openShellSelected) ? buildTaskMcpServer(clientId) : null;
  const telosMcp = supportsHostTaskTools(openShellSelected) ? buildTelosMcpServer(clientId) : null;
  const allMcpServers = { ...mcpServers, ...taskMcp, ...telosMcp };

  const sdkCredentialBoundary =
    !codexProfile && !apiCredentialRef && !gemini
      ? credentialSdkBoundary(process.platform, options.ordinarySdkAuthority?.writeRoots())
      : undefined;
  options.ordinarySdkAuthority?.assertEnvironment(sessionEnv);

  const sdkCredentialIsolation = sdkCredentialBoundary?.credentialIsolation ?? false;
  const projectCommandRunner = sdkCredentialIsolation
    ? undefined
    : createWorkspaceRuntimeCommandRunner();

  // Load project hooks from .claude/settings.json (e.g. SessionStart boot context)
  const projectHooks =
    options.adviserScope || sdkCredentialIsolation
      ? undefined
      : loadProjectHooks(cwd, sessionEnv, projectCommandRunner);
  const hooks =
    agentProfile?.definition.contextRecipe && projectHooks
      ? (Object.fromEntries(
          Object.entries(projectHooks).filter(([name]) => name !== 'SessionStart'),
        ) as typeof projectHooks)
      : projectHooks;

  // Fetch boot context BEFORE building system prompt so it's part of the
  // system prompt append and survives SDK context compaction.
  // fetchBootContext never throws and has a 5s AbortSignal timeout internally.
  // Await the bounded fetch/fallback before opening any provider. A shorter race
  // could discard a valid bundle while persisting empty context for the session.
  let agentContext: AgentContextSnapshot | undefined;
  let prepareAgentContext: ((signal: AbortSignal) => Promise<void>) | undefined;
  let assertSandboxContextAuthorization: (() => void) | undefined;
  try {
    const stored = options.resume ? eventStore.getSession(options.resume)?.agentContext : undefined;
    if (agentProfile?.definition.contextRecipe || stored) {
      const authorization = captureAgentLibraryAuthorization(options.operatorConnectionId);
      const scope = retainAgentContextAuthority(authorization.auth, abortController);
      startupGuard.releaseContext = scope.release;
      const packRecipe = agentProfile?.definition.contextRecipe?.source === 'packs';
      if (
        (stored?.sandbox && (!openShellSelected || packRecipe || stored.source === 'packs')) ||
        (openShellSelected && !packRecipe && stored && !stored.sandbox)
      )
        throw Error('Agent context compilation scope differs; start a new chat');
      const contextRuntime = packRecipe ? await getContextPackRuntime() : undefined;
      if (packRecipe && !contextRuntime)
        throw Error('Knowledge Library is not configured for the selected agent context');
      if (openShellSelected && !packRecipe) {
        assertSandboxContextAuthorization = () => {
          authorization.assertCurrent();
          scope.assertCurrent();
        };
      } else {
        agentContext = await resolveChatAgentContext({
          profile: agentProfile,
          stored,
          workspaceRoot: cwd,
          signal: abortController.signal,
          ...(contextRuntime ? { packs: createAcceptedContextPacks(contextRuntime, scope) } : {}),
        });
      }
      authorization.assertCurrent();
      scope.assertCurrent();
      prepareAgentContext = async (signal) => {
        signal.throwIfAborted();
        scope.assertCurrent();
        for (const document of agentContext?.provenance?.documents ?? []) {
          if (
            !contextRuntime ||
            document.storeId !== contextRuntime.sourceIdentity ||
            !contextRuntime.source.allowed(document.path)
          )
            throw Error('Agent context source scope changed');
          await contextRuntime.source.authorize(document.path, document.revision, signal);
          scope.assertCurrent();
        }
      };
      if (stateSessionId && agentContext)
        eventStore.upsertSession({ sessionId: stateSessionId, agentProfile, agentContext });
    }
  } catch (error: unknown) {
    options.onStartupAdmission?.(error);
    terminalizeUndispatchedStartup(initialProviderAdmission);
    if (stateSessionId)
      eventStore.setSessionState(stateSessionId, 'ENDED', {
        clientId,
        reason: 'context_admission_failed',
      });
    send(transport, {
      type: 'error',
      ...(stateSessionId ? { sessionId: stateSessionId } : {}),
      error: error instanceof Error ? error.message : 'Agent context could not be compiled',
    });
    // Preserve task roots for inspection/retry; compilation has opened no provider.
    inputQueue.close();
    registry.abort(clientId);
    _onSessionChange?.(clientId, 'end', session.sessionId);
    return;
  }
  let bootContextMsg: BootContextMessage =
    (agentContext
      ? bootContextWithRetainedReceipt(
          agentContext,
          stateSessionId
            ? (eventStore.getSession(stateSessionId)?.bootContext ?? undefined)
            : undefined,
        )
      : undefined) ??
    (options.adviserScope || options.ordinarySdkAuthority
      ? { ...FALLBACK_BOOT_CONTEXT, fullMarkdown: '' }
      : openShellSelected
        ? { ...FALLBACK_BOOT_CONTEXT, source: 'sandbox', scope: 'sandbox' }
        : await fetchBootContext(
            agentName,
            undefined,
            undefined,
            !sdkCredentialIsolation,
            projectCommandRunner,
          ));
  const bootContextAppend = bootContextMsg.fullMarkdown
    ? `\n\n# Boot Context\n${bootContextMsg.fullMarkdown}`
    : '';

  // Send boot context to UI immediately (sessionId may be undefined for new sessions — OK,
  // it's a display-only hint; the client doesn't key on it for boot context).
  if (!openShellSelected || agentContext)
    send(transport, {
      ...bootContextMsg,
      ...(stateSessionId ? { sessionId: stateSessionId } : {}),
    });
  // Cache in ManagedSession for replay on reconnect/switch
  session.bootContext = bootContextMsg as unknown as Record<string, unknown>;
  if (options.adviserScope && stateSessionId) {
    options.adviserScope.assertCurrent();
    eventStore.append(stateSessionId, 'adviser_task_scope', {
      version: 1,
      contextSha256: options.adviserScope.contextSha256,
      feature: options.adviserScope.feature(),
      policy: 'reviewed-context-only',
    });
  }
  // For resumed sessions, persist immediately (sessionId is known).
  // For new sessions, persist in onSessionResolved once SDK assigns the ID.
  if (stateSessionId) {
    eventStore.upsertSession({
      sessionId: stateSessionId,
      bootContext: JSON.stringify(bootContextMsg),
    });
  }

  const acceptAgentContext = (
    commandId: string,
    providerThreadId: string,
    providerTurnId: string,
    contextSha256: string,
  ) => {
    const sessionId = session.sessionId ?? stateSessionId ?? newSdkSessionId;
    if (!agentContext || !sessionId) throw Error('Prepared agent context identity is unavailable');
    const message = recordAgentContextAcceptance({
      store: eventStore,
      sessionId,
      snapshot: agentContext,
      commandId,
      providerThreadId,
      providerTurnId,
      contextSha256,
    });
    session.bootContext = message as unknown as Record<string, unknown>;
    send(transport, { ...message, sessionId });
  };

  // Build the system prompt append string (used by both query and comparison)
  const workspacePrompt = repositoryWorkspace
    ? `# Repository task workspace
This is an independent checkout with its own Git storage, not a linked worktree. Work inside ${cwd} for code edits, dependency setup and tests. Use the dedicated Mitzo integrations for network access and publication. Do not switch to the configured default repository.
`
    : openShellWorkdir
      ? buildOpenShellWorkspaceSystemPrompt(openShellWorkdir, wtId)
      : buildWorktreeSystemPrompt(repoWorktrees);
  const systemPromptAppend = options.adviserScope
    ? options.adviserScope.instructions()
    : repositoryChatContext(repositoryWorkspace) +
      'This is Mitzo, a mobile chat interface. The user is on their phone.\n' +
      SESSION_PERMISSION_INSTRUCTIONS +
      PROFILE_TOOL_INSTRUCTIONS +
      (options.contributorGuidance === undefined ? telosArtifactInstructions(!!agentContext) : '') +
      '- Read operations are fine without asking.\n' +
      '- Keep responses concise — small screen.\n' +
      (agentContext
        ? ''
        : '- Read CLAUDE.md and .cursor/rules/ for project context before doing substantive work.') +
      buildClientCapabilitiesPrompt() +
      workspacePrompt +
      (supportsHostTaskTools(openShellSelected) ? buildTaskPromptForSession(clientId) : '') +
      (agentProfile ? `\n\n${buildAgentProfilePrompt(agentProfile.definition)}` : '') +
      (options.contributorGuidance
        ? `\n\n## Contributor guidance\n${options.contributorGuidance}`
        : '') +
      bootContextAppend;

  // Recipe-bound chats already have their exact Library definition and context.
  // Loading the legacy definition would compile another, unrelated default bundle.
  if (
    !options.adviserScope &&
    !options.ordinarySdkAuthority &&
    !agentContext &&
    !agentProfile?.definition.contextRecipe
  )
    loadAgentDef(agentName, cwd)
      .then((loaded) => {
        const s = registry.get(clientId);
        if (s) {
          s.agentDefinition = loaded.definition;
          s.agentDefinitionSource = loaded.source;
          log.info('agent definition stored', {
            agent: agentName,
            source: loaded.source,
            identity: loaded.definition.identity.description,
          });
        } else {
          log.warn('agent definition loaded but session already torn down', {
            agent: agentName,
            source: loaded.source,
          });
        }
      })
      .catch((err: unknown) => {
        log.warn('agent definition load failed', {
          agent: agentName,
          error: err instanceof Error ? err.message : String(err),
        });
      });

  if (!openShellSelected) {
    capturePromptComparison(wtId, cwd, systemPromptAppend, repoWorktrees).catch(() => {});
  }

  // Resolve SDK session UUID for resume — worktree IDs are not valid SDK session IDs
  let liveOrdinarySdkOwner: OrdinaryLocalVertexCommandOwner | undefined;
  let resolvedResume: string | undefined;
  if (options.resume && !codexProfile && !apiKey && !gemini) {
    if (!BASE_REPO) {
      log.warn('REPO_PATH unset — resume will use raw worktree ID, SDK may reject it');
    }
    resolvedResume =
      options.ordinarySdkAuthority?.sdkSessionId() ??
      (BASE_REPO ? getSessionSdkId(BASE_REPO, options.resume) : undefined) ??
      options.resume;
  }

  // Bound sessions have durable routing before the SDK can create history or side effects.
  const newSdkSessionId =
    !resolvedResume && !options.resume
      ? (options.ordinarySdkAuthority?.sdkSessionId() ?? options.initialSessionId ?? randomUUID())
      : undefined;
  try {
    if (newSdkSessionId) {
      eventStore.upsertSession({
        sessionId: newSdkSessionId,
        ...(agentProfile ? { agentProfile } : {}),
        ...(agentContext ? { agentContext } : {}),
        accountBinding,
        bootContext: JSON.stringify(bootContextMsg),
        cwd,
        mode: session.mode,
        agentName,
        selectedModel: options.model ?? accountBinding?.model ?? null,
        reasoningEffort: options.reasoningEffort ?? null,
      });
    }
    let q: QueryInstance;
    if (codexProfile) {
      const conversationId = options.resume ?? newSdkSessionId!;
      session.sessionId = conversationId;
      options.onSessionResolved?.(conversationId);
      send(transport, { type: 'session_id', sessionId: conversationId });
      const messageId = initialMessageId;
      if (!options.reattachOnly)
        storeAndEchoIfNew(
          conversationId,
          messageId,
          options.sourceSnapshots?.length ? prompt : fullPrompt,
          clientId,
          transport,
          session.observers,
          imagePreviews(options.images),
          options.contextBlocks,
          options.sourceSnapshots,
        );
      q = await openCodexChat({
        agentProfile,
        assertAgentContextAuthorization: assertSandboxContextAuthorization,
        resume: !!options.resume,
        conversationId,
        binding: accountBinding!,
        profile: codexProfile,
        repositoryWorkspace,
        session,
        registry,
        prompt: fullPrompt,
        intent: userIntent,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        images: options.images,
        messageId,
        systemPrompt: systemPromptAppend,
        agentContext,
        prepareAgentContext,
        onAgentContextAccepted: agentProfile?.definition.contextRecipe
          ? acceptAgentContext
          : undefined,
        env: sessionEnv,
        configuredSourceEnv: nativeExecutionEnv(),
        mcpServers: allMcpServers,
        eventStore,
        onDemandCreate: repositoryWorkspace ? undefined : buildOnDemandCreate(wtId, clientId),
        publishingGitStorageRoots: [BASE_REPO, ...Object.values(getRepoConfig().repos)]
          .filter(Boolean)
          .map((root) => join(root, '.git')),
        onBootContext: (context) => {
          // Both sandbox startup and published-knowledge adoption use the pinned
          // ContexGin compiler. A selected profile keeps its prepared snapshot.
          const retained = eventStore.getSession(conversationId);
          agentContext = retained?.agentContext ?? agentContext;
          const message: BootContextMessage = agentContext
            ? {
                ...bootContextWithRetainedReceipt(agentContext, retained?.bootContext ?? undefined),
                ...(context.scope ? { scope: context.scope } : {}),
              }
            : { ...context, source: 'contexgin' };
          bootContextMsg = message;
          send(transport, { ...message, sessionId: conversationId });
          session.bootContext = message as unknown as Record<string, unknown>;
          eventStore.upsertSession({
            sessionId: conversationId,
            bootContext: JSON.stringify(message),
          });
        },
        reattachOnly: options.reattachOnly,
        ordinaryTurnLifecycle: options.ordinaryTurnLifecycle,
        contributorGuidance: options.contributorGuidance,
      });
    } else if (apiKey || gemini) {
      const conversationId = options.resume ?? newSdkSessionId!;
      session.sessionId = conversationId;
      options.onSessionResolved?.(conversationId);
      send(transport, { type: 'session_id', sessionId: conversationId });
      q = await openResponsesChat({
        agentProfile,
        resume: !!options.resume,
        conversationId,
        binding: accountBinding!,
        apiKey,
        gemini,
        ...(accountBinding?.provider === 'openai' &&
        (getConnectionsRuntime()?.openAIKeys?.manages(accountBinding.accountId) ||
          getConnectionsRuntime()?.openAIEnrollmentAuthority?.manages(accountBinding.accountId))
          ? {
              getApiKey: async (signal?: AbortSignal) => {
                loadAccountProfiles().resume(accountBinding!);
                const runtime = getConnectionsRuntime();
                const manager = runtime?.openAIEnrollmentAuthority?.manages(
                  accountBinding!.accountId,
                )
                  ? runtime.openAIEnrollmentAuthority
                  : runtime?.openAIKeys;
                if (!manager) throw new Error('OpenAI credential management is unavailable');
                return manager.resolveKey(
                  accountBinding!.accountId,
                  signal ?? AbortSignal.timeout(30000),
                );
              },
            }
          : {}),
        selectedModel: options.model,
        reasoningEffort: options.reasoningEffort,
        session,
        registry,
        input: inputQueue,
        eventStore,
        systemPrompt: systemPromptAppend,
        env: sessionEnv,
        configuredSourceEnv: nativeExecutionEnv(),
        agentContext,
        prepareAgentContext,
        onAgentContextAccepted: agentContext ? acceptAgentContext : undefined,
        mcpServers: allMcpServers,
        onDemandCreate: repositoryWorkspace ? undefined : buildOnDemandCreate(wtId, clientId),
        publishingGitStorageRoots: [BASE_REPO, ...Object.values(getRepoConfig().repos)]
          .filter(Boolean)
          .map((root) => join(root, '.git')),
      });
      if (!initialProviderAdmission) {
        throw new Error('Native provider startup is missing durable command admission');
      }
      const responsesRuntime = getResponsesRuntime(session);
      if (!responsesRuntime) throw new Error('Native provider startup runtime is unavailable');
      responsesRuntime.prepare(initialMessageId, responsesUserContent(fullPrompt, options.images));
      storeAndEchoIfNew(
        conversationId,
        initialMessageId,
        options.sourceSnapshots?.length ? prompt : fullPrompt,
        clientId,
        transport,
        session.observers,
        imagePreviews(options.images),
        options.contextBlocks,
        options.sourceSnapshots,
      );
      trackResponsesProviderAdmission(session, initialProviderAdmission, eventStore);
      inputQueue.push(
        makeUserMessage(
          fullPrompt,
          'now',
          initialMessageId,
          initialProviderAdmission,
          undefined,
          options.images,
        ),
      );
      options.onStartupAdmission?.();
    } else {
      const existingDecision = webAccessSdkPermission(
        buildPermissionHandler(clientId, registry, {
          onDemandCreate: repositoryWorkspace ? undefined : buildOnDemandCreate(wtId, clientId),
        }),
      );
      const connectionServer = createCredentialSdkServer(
        () => session.sessionId ?? options.resume ?? newSdkSessionId,
        session,
        registry,
        options.ordinarySdkAuthority
          ? {
              profilesOnly: true,
              assertCurrent: (signal) => options.ordinarySdkAuthority!.assertCurrent(signal),
              assertCurrentSync: (signal) =>
                options.ordinarySdkAuthority!.assertCurrentSync(signal),
            }
          : undefined,
      );
      const packBoundSdk = agentContext?.source === 'packs' || !!options.ordinarySdkAuthority;
      const contextStopReason = 'Accepted agent context is no longer authorized; start a new chat.';
      const sdkHookLifetime = new SdkHookLifetime();
      const authorizeSdkContext = async (signal: AbortSignal) => {
        const joined = AbortSignal.any([abortController.signal, signal]);
        try {
          options.adviserScope?.assertCurrent();
          joined.throwIfAborted();
          await prepareAgentContext?.(joined);
          await options.ordinarySdkAuthority?.assertCurrent(joined);
          joined.throwIfAborted();
        } catch (error) {
          // SDK hook failures can be recoverable diagnostics. Abort the owning
          // provider process too, so a denied continuation cannot be retried.
          if (packBoundSdk && !sdkHookLifetime.retired(signal))
            abortController.abort(new Error(contextStopReason));
          throw error;
        }
      };
      const decide: ReturnType<typeof buildPermissionHandler> = async (name, input, opts) => {
        if (packBoundSdk) await authorizeSdkContext(opts.signal);
        if (
          options.ordinarySdkAuthority &&
          name.startsWith('mcp__mitzo-connections__') &&
          ![
            'mcp__mitzo-connections__SymposiumReadProfiles',
            'mcp__mitzo-connections__SymposiumProposeProfile',
          ].includes(name)
        )
          return {
            behavior: 'deny',
            message: 'This helper is unavailable for the selected conversation route.',
          };
        try {
          const keychain = credentialSdkPermission(name, input, clientId, registry, session);
          return keychain && !opts.forcePrompt
            ? keychain
            : await existingDecision(name, input, opts);
        } finally {
          // Permissions can wait for a human while accepted Knowledge changes.
          if (packBoundSdk) await authorizeSdkContext(opts.signal);
        }
      };
      const sdkHooks = buildSessionPermissionHooks(decide, hooks);
      if (packBoundSdk) {
        const fence: (hook: HookCallback) => HookCallback = (hook) => async (input, id, opts) => {
          const signal = AbortSignal.any([abortController.signal, opts.signal]);
          sdkHookLifetime.propagate(opts.signal, signal);
          const abortOwner = () => {
            if (!sdkHookLifetime.retired(signal))
              abortController.abort(new Error(contextStopReason));
          };
          signal.addEventListener('abort', abortOwner, { once: true });
          try {
            await authorizeSdkContext(signal);
            try {
              return await hook(input, id, { ...opts, signal });
            } finally {
              // Every matched callback owns its final fence. Concurrent SDK
              // matchers cannot outrun a slower hook or its source changes.
              await authorizeSdkContext(signal);
            }
          } catch (error) {
            if (abortController.signal.aborted)
              return { continue: false, stopReason: contextStopReason };
            throw error;
          } finally {
            signal.removeEventListener('abort', abortOwner);
          }
        };
        const boundaries: HookEvent[] = [
          'SessionStart',
          'UserPromptSubmit',
          'UserPromptExpansion',
          'PreToolUse',
          'PostToolUse',
          'PostToolUseFailure',
          'PostToolBatch',
          'PermissionRequest',
          'PermissionDenied',
          'SubagentStart',
          'SubagentStop',
          'PreCompact',
          'PostCompact',
          'Stop',
          'StopFailure',
        ];
        for (const event of boundaries) {
          sdkHooks[event] = [
            ...(sdkHooks[event] ?? []).map((matcher) => ({
              ...matcher,
              hooks: matcher.hooks.map(fence),
            })),
            // Also fence batches/events that match no project hook, including
            // nested workers. PostToolBatch runs before the next model request.
            { hooks: [fence(async () => ({}))] },
          ];
        }
      }
      const githubPublishing = createGithubPublishingTool(
        () => session.sessionId ?? options.resume ?? newSdkSessionId ?? '',
        registry,
        () => {
          assertTurnCallbackEffects();
          options.ordinarySdkAuthority?.assertCurrentSync(abortController.signal);
          return hostGithubPublishingSource(
            session,
            [BASE_REPO, ...Object.values(getRepoConfig().repos)]
              .filter(Boolean)
              .map((root) => join(root, '.git')),
          );
        },
        session,
        async () => {
          assertTurnCallbackEffects();
          await options.ordinarySdkAuthority?.assertCurrent(abortController.signal);
          assertTurnCallbackEffects();
        },
        {
          explicitSelection: () => {
            // Ordinary SDK provider publication is disabled; an explicit operator
            // action selects the trusted current command settings separately.
            if (options.ordinarySdkAuthority) {
              const id = session.sessionId ?? options.resume ?? '';
              const settings =
                eventStore.getOrdinaryWorkspaceConversationSettings(id) ??
                eventStore.getOrdinaryConversationSettings(id);
              if (!settings) throw Error('Explicit operator publication selection unavailable');
              return {
                model: settings.selection.model,
                reasoningEffort: settings.selection.thinking ?? null,
              };
            }
            // Legacy SDK queries retain their original model/thinking/effort;
            // sendToChat refuses model changes for this fixed query.
            return {
              model: options.model ?? session.model ?? session.accountBinding?.model ?? '',
              reasoningEffort: options.reasoningEffort ?? null,
            };
          },
        },
      );
      abortController.signal.addEventListener('abort', () => githubPublishing.close(), {
        once: true,
      });
      const createSdkWebAccess = (state?: {
        retired: boolean;
        completing: boolean;
        runCallback: TurnCallbackRunner;
      }) => {
        const assertWebCurrent = async () => {
          assertTurnCallbackEffects();
          if (state?.retired || state?.completing) throw Error('Completed SDK query retired');
          await options.ordinarySdkAuthority?.assertCurrent(abortController.signal);
          assertTurnCallbackEffects();
          if (state?.retired || state?.completing) throw Error('Completed SDK query retired');
        };
        return createWebAccessSdkServer(
          createWebAccessTool(
            () => session.sessionId ?? options.resume ?? newSdkSessionId ?? '',
            registry,
            (query, signal, owner) =>
              searchSdk(query, signal, {
                ...owner,
                executionStore: eventStore,
                env: sessionEnv,
                model: parseModelSpec(session.model ?? accountBinding?.model ?? '').model,
                ...(options.ordinarySdkAuthority
                  ? {
                      assertCurrent: assertWebCurrent,
                      assertCurrentSync: (signal) => {
                        if (state?.retired || state?.completing)
                          throw Error('Completed SDK query retired');
                        options.ordinarySdkAuthority!.assertCurrentSync(signal);
                      },
                      writeRoots: options.ordinarySdkAuthority.writeRoots(),
                    }
                  : {}),
              }),
            assertWebCurrent,
          ),
          abortController.signal,
          options.ordinarySdkAuthority ? undefined : githubPublishing,
          state?.runCallback,
        );
      };
      const webAccess = createSdkWebAccess();
      await authorizeSdkContext(abortController.signal);
      const sdkOptions: NonNullable<Parameters<typeof query>[0]['options']> = {
        cwd,
        env: sessionEnv,
        abortController,
        includePartialMessages: true,
        settingSources:
          sdkCredentialIsolation || agentContext?.source === 'packs' || options.ordinarySdkAuthority
            ? []
            : ['project'],
        ...(sdkCredentialBoundary
          ? {
              spawnClaudeCodeProcess: sdkCredentialBoundary.spawnClaudeCodeProcess,
            }
          : {}),
        ...(sdkCredentialIsolation || options.ordinarySdkAuthority
          ? { strictMcpConfig: true }
          : {}),
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append:
            systemPromptAppend +
            WEB_ACCESS_INSTRUCTIONS +
            (options.ordinarySdkAuthority
              ? ''
              : GITHUB_PUBLISHING_INSTRUCTIONS + CONNECTION_TOOL_INSTRUCTIONS),
        },
        permissionMode: MODE_TO_SDK[session.mode] as 'plan' | 'default',
        allowedTools: options.ordinarySdkAuthority
          ? [
              'mcp__mitzo-connections__SymposiumReadProfiles',
              'mcp__mitzo-connections__SymposiumProposeProfile',
              WEB_ACCESS_SDK_TOOL,
            ]
          : [
              ...(sdkCredentialIsolation ? [] : mcpAllowed),
              ...extraTools,
              WEB_ACCESS_SDK_TOOL,
              GITHUB_PUBLISH_SDK_TOOL,
              'mcp__mitzo-connections__*',
            ],
        disallowedTools: [
          'WebSearch',
          'WebFetch',
          ...(options.ordinarySdkAuthority ? [GITHUB_PUBLISH_SDK_TOOL] : []),
        ],
        thinking: resolveThinking(options.model),
        effort: resolveClaudeEffort(options.model, options.reasoningEffort),
        ...(options.model ? { model: parseModelSpec(options.model).model } : {}),
        ...(resolvedResume ? { resume: resolvedResume } : {}),
        ...(newSdkSessionId ? { sessionId: newSdkSessionId } : {}),
        mcpServers: options.ordinarySdkAuthority
          ? { 'mitzo-connections': connectionServer, 'mitzo-web-access': webAccess }
          : {
              ...(sdkCredentialIsolation ? {} : allMcpServers),
              'mitzo-web-access': webAccess,
              'mitzo-connections': connectionServer,
            },
        hooks: sdkHooks,
        canUseTool: decide,
        ...(options.adviserScope
          ? {
              ...options.adviserScope.sdkPolicy(),
              strictMcpConfig: true,
              systemPrompt: options.adviserScope.instructions(),
              allowedTools: [],
              disallowedTools: [],
            }
          : {}),
      };
      if (options.ordinarySdkAuthority) {
        const ownedQuery = createOrdinaryLocalVertexSdkQuery({
          options: sdkOptions,
          input: inputQueue,
          lifetime: sdkHookLifetime,
          sdkSessionId: options.ordinarySdkAuthority.sdkSessionId(),
          cwd,
          controller: abortController,
          authorize: authorizeSdkContext,
          authorizeSync: (signal) => options.ordinarySdkAuthority!.assertCurrentSync(signal),
          adapt: adaptSdkQuery,
          settings: (selection) => ({
            model: parseModelSpec(selection.model).model,
            thinking: resolveThinking(selection.model),
            effort: resolveClaudeEffort(selection.model, selection.thinking),
          }),
          inputChanged: (queue) => {
            session.inputQueue = queue as { push(message: unknown): void; close(): void };
          },
          mcpServers: (state) => ({
            'mitzo-web-access': createSdkWebAccess(state),
            'mitzo-connections': createCredentialSdkServer(
              () => session.sessionId,
              session,
              registry,
              {
                profilesOnly: true,
                runCallback: state.runCallback,
                assertCurrentSync: (signal) => {
                  if (state.retired || state.completing) throw Error('Completed SDK query retired');
                  options.ordinarySdkAuthority!.assertCurrentSync(signal);
                },
                assertCurrent: async (signal) => {
                  if (state.retired || state.completing) throw Error('Completed SDK query retired');
                  await options.ordinarySdkAuthority!.assertCurrent(signal);
                  if (state.retired || state.completing) throw Error('Completed SDK query retired');
                },
              },
            ),
          }),
        });
        q = ownedQuery.query;
        liveOrdinarySdkOwner = options.ordinarySdkCommandOwner!(
          ownedQuery.firstQuery,
          (id, _admission, payload) => {
            const { systemPrompt, ...commandPayload } = payload;
            const profile = eventStore.getSession(session.sessionId!)?.agentProfile;
            if (!profile || systemPrompt !== buildAgentProfilePrompt(profile.definition))
              throw Error('Original SDK profile prompt changed');
            const frozenPayload =
              LocalVertexClaudeFirstCommandSchema.shape.payload.parse(commandPayload);
            const message =
              id === initialMessageId
                ? fullPrompt
                : assemblePrompt(
                    repositoryChatContext(repositoryWorkspace) + frozenPayload.text,
                    cwd,
                    frozenPayload.images,
                    undefined,
                    frozenPayload.sourceSnapshots,
                  );
            session.model = _admission.selection.model;
            storeAndEchoIfNew(
              session.sessionId!,
              id,
              frozenPayload.text,
              clientId,
              session.transport,
              session.observers,
              imagePreviews(frozenPayload.images),
              undefined,
              frozenPayload.sourceSnapshots,
              'user',
              false,
            );
            ownedQuery.push(
              makeUserMessage(message, 'now', id, undefined, undefined, frozenPayload.images),
            );
          },
          ownedQuery.apply,
        );
        await liveOrdinarySdkOwner.enqueue(initialMessageId);
      } else {
        q = createContinuousSdkQuery({
          input: inputQueue,
          controller: abortController,
          lifetime: sdkHookLifetime,
          authorize: authorizeSdkContext,
          create: (request) => query(request),
          adapt: adaptSdkQuery,
          options: (state) => ({
            ...sdkOptions,
            mcpServers: {
              ...sdkOptions.mcpServers,
              'mitzo-web-access': createSdkWebAccess(state),
              'mitzo-connections': createCredentialSdkServer(
                () => session.sessionId ?? options.resume ?? newSdkSessionId,
                session,
                registry,
                {
                  runCallback: state.runCallback,
                  assertCurrentSync: (signal) => {
                    signal.throwIfAborted();
                    assertTurnCallbackEffects();
                  },
                  assertCurrent: async (signal) => {
                    assertTurnCallbackEffects();
                    await authorizeSdkContext(signal);
                    assertTurnCallbackEffects();
                  },
                },
              ),
            },
          }),
        });
      }
    }

    session.queryInstance = q;
    options.onQueryReady?.(q);
    if (repositoryWorkspace && accountBinding && session.sessionId) {
      // Provider startup has settled and the task workspace is independently retained.
      // Failure to reclaim a controller seed must never terminate a live task.
      await getRepositoryWorkspaces(true)
        .releaseSource(repositoryWorkspace.id, accountBinding, session.sessionId)
        .catch(() =>
          log.warn('Repository preparation cleanup remains pending', {
            repositoryWorkspaceId: repositoryWorkspace.id,
          }),
        );
    }

    // Session state machine: mark STARTING (query allocated, waiting for first SDK event)
    const startingSessionId = options.resume ?? session.sessionId;
    if (startingSessionId) {
      eventStore.setSessionState(startingSessionId, 'STARTING', { clientId });
    }

    // For resumed sessions the prompt is sent to the SDK but was never stored
    // in the event store — making user messages invisible after WS reconnect.
    // Store and echo it here so the frontend can replay it.
    if (options.resume && !codexProfile && !apiKey && !gemini && !options.ordinarySdkAuthority) {
      const messageId =
        options.clientMsgId || `umsg-${Date.now()}-${randomUUID().slice(0, 8)}-resume`;
      storeAndEchoIfNew(
        options.resume,
        messageId,
        options.sourceSnapshots?.length ? prompt : fullPrompt,
        clientId,
        transport,
        session.observers,
        imagePreviews(options.images),
        options.contextBlocks,
        options.sourceSnapshots,
      );
    }

    // The session is registered and the provider query is ready. Worktree and
    // provider setup failures above must be reported before admitting a spawn.
    if (!apiKey && !gemini) options.onStartupAdmission?.();
    const queryEvents = q as unknown as AsyncIterable<Record<string, unknown>>;
    const sdkContextEvents = async function* () {
      let acknowledged = false;
      for await (const message of queryEvents) {
        options.adviserScope?.assertCurrent();
        if (
          !acknowledged &&
          agentContext &&
          !codexProfile &&
          !apiKey &&
          !gemini &&
          message.type === 'stream_event'
        ) {
          const event = message.event as { type?: string; message?: { id?: string } } | undefined;
          const providerSessionId = session.sessionId ?? stateSessionId ?? newSdkSessionId;
          if (event?.type === 'message_start' && event.message?.id && providerSessionId) {
            acknowledged = true;
            const append =
              systemPromptAppend +
              WEB_ACCESS_INSTRUCTIONS +
              GITHUB_PUBLISHING_INSTRUCTIONS +
              CONNECTION_TOOL_INSTRUCTIONS;
            acceptAgentContext(
              initialMessageId,
              providerSessionId,
              event.message.id,
              createHash('sha256').update(append).digest('hex'),
            );
          }
        }
        yield message;
      }
    };
    await runQueryLoop(
      sdkContextEvents(),
      clientId,
      registry,
      abortController,
      eventStore,
      options.resume || codexProfile || apiKey || gemini || options.ordinarySdkAuthority
        ? undefined
        : options.sourceSnapshots?.length
          ? prompt
          : fullPrompt,
      {
        connRegistry: _connRegistry ?? undefined,
        onFirstEventOutcome: options.onFirstEventOutcome,
        onTerminalOutcome: options.onTerminalOutcome,
        onEvent: options.onQueryEvent,
        initialClientMsgId: initialMessageId,
        initialImages: imagePreviews(options.images),
        initialContextBlocks: options.contextBlocks,
        initialSourceSnapshots: options.sourceSnapshots,
        onSessionResolved: (sessionId: string) => {
          // Persist boot context for new sessions (resume sessions already persisted above)
          if (!options.resume) {
            eventStore.upsertSession({
              sessionId,
              ...(accountBinding ? { accountBinding } : {}),
              bootContext: JSON.stringify(session.bootContext ?? bootContextMsg),
              ...(agentProfile ? { agentProfile } : {}),
              ...(agentContext ? { agentContext } : {}),
            });
          }
          options.onSessionResolved?.(sessionId);
        },
        onInitialPrompt: (sessionId: string) => {
          if (!options.adviserScope && !options.ordinarySdkAuthority)
            tryAutoRename(sessionId, clientId).catch(() => {
              /* errors logged internally */
            });
        },
        onTurnEnd: (cId: string) => {
          _onSessionChange?.(cId, 'turn_end');
        },
        onUserInput: (cId, inputUuid) => {
          const active = registry.get(cId);
          if (active) markFallbackCloseoutInputObserved(active, inputUuid);
          liveOrdinarySdkOwner?.inputObserved(inputUuid);
        },
        onResult: (cId, result, inputUuid) => {
          const active = registry.get(cId);
          if (active)
            finishFallbackCloseout(
              active,
              result.is_error === true ? 'failed' : 'completed',
              inputUuid,
            );
          if (liveOrdinarySdkOwner)
            void liveOrdinarySdkOwner
              .resultObserved(inputUuid, result.is_error === true)
              .catch(() =>
                abortController.abort(Error('Original SDK result authority unavailable')),
              );
          options.adviserScope?.assertCurrent();
          options.onTurnResult?.(result, inputUuid);
        },
        onSuccessfulAccountUse: (binding) => getAccountUseStore().record(binding),
      },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const native =
      accountBinding?.provider === 'openai-codex' ||
      accountBinding?.provider === 'openai' ||
      options.ordinarySdkAuthority instanceof OrdinaryLocalVertexSdkAuthority;
    const publicMessage = native
      ? publicCodexStartupError(err instanceof Error ? err : new Error(message))
      : message;
    try {
      // Admission rejection is also a client/span boundary. Never forward the
      // internal exception or its cause to a second, unsanitized error path.
      options.onStartupAdmission?.(native ? new Error(publicMessage) : err);
      terminalizeUndispatchedStartup(initialProviderAdmission);
      if (message.includes('No conversation found') && options.resume) {
        log.warn('SDK rejected resume, session expired', { sessionId: options.resume, cwd });
        send(transport, {
          type: 'error',
          error: 'Session expired. Send your message again to start fresh.',
        });
      } else {
        log.error('startChat failed after register, cleaning up', {
          clientId,
          sessionId: newSdkSessionId ?? session.sessionId,
          ...(accountBinding?.provider === 'openai-codex' || accountBinding?.provider === 'openai'
            ? codexRuntimeErrorTelemetry(err instanceof Error ? err : new Error(message))
            : {}),
          error: publicMessage,
        });
        send(transport, {
          type: 'error',
          ...(session.sessionId ? { sessionId: session.sessionId } : {}),
          error: publicMessage,
        });
      }
    } finally {
      const failedSession = registry.get(clientId);
      if (failedSession === session) {
        // A resumed startup also entered CREATED. Retire its driver state while
        // retaining native history, bindings and uncertainty records. A replaced
        // registry owner must never be ended or aborted by this attempt's cleanup.
        try {
          const failedSessionId = newSdkSessionId ?? session.sessionId;
          if (failedSessionId)
            eventStore.setSessionState(failedSessionId, 'ENDED', {
              clientId,
              reason: 'startup_failed',
            });
          cleanupSessionWorktrees(failedSession);
        } finally {
          registry.abort(clientId);
        }
      }
    }
  } finally {
    options.adviserScope?.signal.removeEventListener('abort', abortAdviser);
    const current = registry.get(clientId);
    if (!current || current === session) _onSessionChange?.(clientId, 'end', session.sessionId);
  }
}

/** Inspect only live ownership; cold sessions require separate native admission. */
export function hasOwnedLocalCodexDriver(sessionId: string): boolean {
  return registry.findBySessionId(sessionId)?.session.ordinaryRuntimeOwner?.location === 'local';
}

/** Capability to request a guarded resume, never a provider readiness claim. */
export function canResumeOwnedLocalCodexDriver(sessionId: string, authSessionId: string): boolean {
  try {
    if (eventStore.getLatestEvent(sessionId, 'adviser_task_scope')) return false;
    if (
      !hasPersistentRevocationAuthority() ||
      process.env.MITZO_ORDINARY_LOCAL_CODEX_ENABLED !== '1' ||
      custodianControllerMode ||
      custodianOwnerMode ||
      registry.findBySessionId(sessionId)
    )
      return false;
    const meta = eventStore.getSession(sessionId);
    const binding = eventStore.getSessionRuntimeBinding(sessionId);
    if (
      !meta?.accountBinding ||
      binding?.execution.location !== 'local' ||
      binding.harness.implementation !== 'codex'
    )
      return false;
    const native = getCodexConversationStore();
    return (
      ordinaryOperatorOwnsConversation(
        native.readHostCustody(sessionId, meta.accountBinding)?.authSessionId,
        authSessionId,
      ) &&
      Boolean(native.read(sessionId, meta.accountBinding).threadId) &&
      !native.hasRunningCommand(sessionId, meta.accountBinding)
    );
  } catch {
    return false;
  }
}

/** Existing live owner only. The middleware-retained operator binding supplies
 * the authenticated subject; request JSON cannot adopt a cold conversation.
 */
export async function sendOwnedLocalCodexCommand(input: {
  sessionId: string;
  command: unknown;
  operatorConnectionId: string;
  signal?: AbortSignal;
}): Promise<{ dispatched: boolean; sessionId: string }> {
  const unavailable = () => new Error('Owned local Codex chat unavailable');
  try {
    if (eventStore.getLatestEvent(input.sessionId, 'adviser_task_scope')) throw unavailable();
    if (
      process.env.MITZO_ORDINARY_LOCAL_CODEX_ENABLED !== '1' ||
      custodianControllerMode ||
      custodianOwnerMode
    )
      throw unavailable();
    const captured = captureAgentLibraryAuthorization(input.operatorConnectionId);
    captured.assertCurrent();
    const retained = registry.findBySessionId(input.sessionId)?.session.ordinaryRuntimeOwner;
    if (
      !retained ||
      retained.location !== 'local' ||
      !ordinaryOperatorOwnsConversation(retained.authSessionId, captured.auth.id)
    )
      throw unavailable();
    resolveOwnedTelosWorkCommandScope(input.sessionId);
    retained.reauthorize?.(input.operatorConnectionId);
    const result = await retained.admit(structuredClone(input.command), input.signal);
    captured.assertCurrent();
    resolveOwnedTelosWorkCommandScope(input.sessionId);
    if (result.dispatched) {
      const current = registry.findBySessionId(input.sessionId);
      const native = current && getCodexRuntime(current.session);
      if (
        !native ||
        !ordinaryOperatorOwnsConversation(
          current!.session.ownedLocalAuthSessionId,
          captured.auth.id,
        )
      )
        throw unavailable();
      await native.resumeAfterExplicitSend();
    }
    return { ...result, sessionId: input.sessionId };
  } catch {
    throw unavailable();
  }
}

/** Explicit existing queue action. Acceptance observation remains read-only;
 * this action reopens the original saved input even after its outbox retires. */
export async function continueOwnedLocalCodexQueue(
  sessionId: string,
  authorization: import('./auth.js').AuthSession | undefined,
  connectionId?: string,
) {
  if (!authorization || authorization.expiresAt <= Date.now() || !connectionId)
    throw Error('Original Codex operator required');
  const captured = captureAgentLibraryAuthorization(connectionId);
  captured.assertCurrent();
  const transport = _connRegistry?.get(connectionId)?.transport;
  if (
    captured.auth.id !== authorization.id ||
    liveTransportAuthSessionId(connectionId) !== authorization.id ||
    !transport?.isOpen()
  )
    throw Error('Original signed connection required');
  const meta = eventStore.getSession(sessionId),
    binding = eventStore.getSessionRuntimeBinding(sessionId);
  if (
    !meta?.accountBinding ||
    binding?.version !== 2 ||
    binding.harness.implementation !== 'codex' ||
    binding.execution.location !== 'local'
  )
    throw Error('Original local Codex route required');
  const commandId = recoverableLocalCodexCommand(
    eventStore,
    getCodexConversationStore(),
    sessionId,
    authorization.id,
  );
  if (!commandId) throw Error('Saved input has no safe undispatched recovery');
  const workspaceKind = meta.ordinaryWorkspaceId ? 'ordinary' : 'repository';
  const workspace =
    workspaceKind === 'ordinary'
      ? getOrdinaryWorkspaces(true).getOrdinaryWorkspace(meta.ordinaryWorkspaceId!)
      : getRepositoryWorkspaces(true).get(meta.repositoryWorkspaceId!);
  const taskRoot = workspace.hostReservation?.taskRoot;
  if (!taskRoot) throw Error('Original task reservation unavailable');
  const { request } = RetainedLocalCodexRecovery.captureSaved(
    eventStore,
    getCodexConversationStore(),
    sessionId,
    authorization.id,
    commandId,
  );
  const release = reserveRepositoryStartup(sessionId);
  const preparation = new AbortController();
  const timer = setTimeout(() => preparation.abort(), 120000);
  try {
    await startOwnedLocalCodexCommand(transport, `${connectionId}:${sessionId}`, {
      command: request,
      commandId,
      workspaceKind,
      reservation: {
        id: meta.ordinaryWorkspaceId ?? meta.repositoryWorkspaceId!,
        conversationId: sessionId,
        binding: meta.accountBinding,
        taskRoot,
        runtimeBinding: binding,
      },
      operatorConnectionId: connectionId,
      ownerConnectionId: connectionId,
      signal: preparation.signal,
      resume: true,
      recovery: true,
      savedRecovery: true,
    });
  } finally {
    clearTimeout(timer);
    release();
  }
}

/** Explicit server-only entry for the owned local first-command route. The
 * preexisting repository reservation and authenticated operator are supplied by
 * trusted composition; no request can provide an authority or runtime launcher.
 */
export async function startOwnedLocalCodexCommand(
  transport: SessionTransport,
  clientId: string,
  input: {
    workspaceKind?: LocalWorkspaceKind;
    command: unknown;
    reservation: Omit<HostRepositoryReservationInput, 'signal'>;
    commandId: string;
    operatorConnectionId: string;
    /** Actual event stream, distinct from a retained server-only auth binding. */
    ownerConnectionId?: string;
    signal: AbortSignal;
    /** Server-selected cold continuation, never legacy history adoption. */
    resume?: boolean;
    recovery?: boolean;
    savedRecovery?: boolean;
    /** Trusted silent allocation receipt; explicit first command only. */
    preparationOperationId?: string;
    adviserScope?: AdviserTaskScope;
    onSessionPrepared?: (session: ManagedSession) => void;
    onQueryEvent?: (event: Readonly<Record<string, unknown>>) => void;
    onTerminalOutcome?: (error?: Error) => void;
    onEnded?: () => void;
  },
): Promise<{ dispatched: boolean; sessionId: string }> {
  const unavailable = () => new Error('Owned local Codex chat unavailable');
  // Loading these owners can allocate their private stores. Absence stays off.
  if (
    process.env.MITZO_ORDINARY_LOCAL_CODEX_ENABLED !== '1' ||
    custodianControllerMode ||
    custodianOwnerMode
  )
    throw unavailable();
  let driver: OrdinaryLocalCodexOwnedRuntime<LocalWorkspaceKind> | undefined;
  let prepared: Awaited<ReturnType<typeof prepareOwnedLocalCodexChat>> | undefined;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const sessionId = input.reservation.conversationId;
    const live = registry.findBySessionId(sessionId)?.session;
    if (live && driver && live.ordinaryRuntimeOwner?.identity === driver)
      delete live.ordinaryRuntimeOwner;
    driver?.close();
    input.onEnded?.();
  };
  try {
    const commandId = input.commandId;
    const preparationOperationId = input.preparationOperationId;
    const requestedResume = input.resume;
    const resume = requestedResume === true;
    if (
      (preparationOperationId !== undefined &&
        (typeof preparationOperationId !== 'string' ||
          preparationOperationId.length > 200 ||
          !/^\S+$/.test(preparationOperationId))) ||
      (requestedResume !== undefined && typeof requestedResume !== 'boolean') ||
      (resume && preparationOperationId !== undefined)
    )
      throw unavailable();
    const operatorConnectionId = input.operatorConnectionId;
    const signal = input.signal;
    signal.throwIfAborted();
    const captured = captureAgentLibraryAuthorization(operatorConnectionId);
    captured.assertCurrent();
    const ownerConnectionId = input.ownerConnectionId ?? operatorConnectionId;
    const ownerAuthSessionId = captured.auth.id;
    const reservation = structuredClone(input.reservation);
    let workspaceKind = input.workspaceKind;
    const command = structuredClone(input.command);
    const sessionId = reservation.conversationId;
    if (eventStore.getLatestEvent(sessionId, 'adviser_task_scope') && !input.adviserScope)
      throw unavailable();
    if (input.adviserScope && (!(input.adviserScope instanceof AdviserTaskScope) || resume))
      throw unavailable();
    input.adviserScope?.assertSelection(
      reservation.binding,
      (command as { selection?: { thinking?: string | null } }).selection?.thinking,
    );
    resolveOwnedTelosWorkCommandScope(sessionId);
    if (input.recovery) {
      if (!resume || input.adviserScope) throw unavailable();
      if (input.savedRecovery)
        RetainedLocalCodexRecovery.captureSaved(
          eventStore,
          getCodexConversationStore(),
          sessionId,
          ownerAuthSessionId,
          commandId,
        );
      else
        RetainedLocalCodexRecovery.capture(
          eventStore,
          getCodexConversationStore(),
          sessionId,
          ownerAuthSessionId,
          command,
        );
      captured.assertCurrent();
      const prior = registry.findBySessionId(sessionId);
      if (prior) {
        const runtime = getCodexRuntime(prior.session);
        if (
          !runtime?.isPaused() ||
          !ordinaryOperatorOwnsConversation(
            prior.session.ownedLocalAuthSessionId,
            ownerAuthSessionId,
          )
        )
          throw unavailable();
        prior.session.queryInstance?.close();
        registry.abort(prior.clientId);
      }
    }
    const liveOwner = registry.findBySessionId(sessionId)?.session.ordinaryRuntimeOwner;
    if (liveOwner) {
      if (
        liveOwner.location !== 'local' ||
        liveOwner.authSessionId !== ownerAuthSessionId ||
        liveOwner.initialCommandId !== commandId ||
        liveOwner.initialPreparationOperationId !== preparationOperationId ||
        (liveOwner.initialResume ?? false) !== resume
      )
        throw unavailable();
      const result = await liveOwner.retryInitial(command);
      resolveOwnedTelosWorkCommandScope(sessionId);
      return { ...result, sessionId };
    }
    if (resume) {
      const native = getCodexConversationStore();
      const custody = native.readHostCustody(sessionId, reservation.binding);
      if (!custody || !ordinaryOperatorOwnsConversation(custody.authSessionId, ownerAuthSessionId))
        throw unavailable();
      const adopted = reconcilePreparedRepositoryTransitionProjection({
        workspace: getRepositoryWorkspaces(true),
        events: eventStore,
        native,
        conversationId: sessionId,
        binding: reservation.binding,
        assertCurrentSync: () => {
          signal.throwIfAborted();
          captured.assertCurrent();
        },
      });
      if (adopted) {
        reservation.id = adopted.id;
        workspaceKind = 'repository';
      }
    }
    driver = new OrdinaryLocalCodexOwnedRuntime<LocalWorkspaceKind>({
      enabled: true,
      eventStore,
      library: getAgentLibrary(),
      workspaceKind,
      workspace:
        workspaceKind === 'ordinary' ? getOrdinaryWorkspaces(true) : getRepositoryWorkspaces(true),
      reservation,
      commandId,
      operatorConnectionId,
      signal,
      nativeStore: getCodexConversationStore(),
      ...(input.adviserScope
        ? {
            nativeExecutionReadRoots: input.adviserScope.nativeReadRoots(
              getOrdinaryWorkspaces(true).getOrdinaryWorkspace(reservation.id).directory,
            ),
          }
        : {}),
      dispatchContinuation: async (dispatch) => {
        if (released || !driver || input.adviserScope) throw unavailable();
        const current = registry.findBySessionId(sessionId);
        const session = current?.session;
        const native = session && getCodexRuntime(session);
        if (
          !current ||
          !session ||
          !native ||
          session.ownedLocalAuthSessionId !== ownerAuthSessionId
        )
          throw unavailable();
        resolveOwnedTelosWorkCommandScope(sessionId, !!dispatch.agentMessageId);
        await native.admitExplicitSend(
          {
            id: dispatch.commandId,
            prompt: assembleSourceSnapshots(
              dispatch.payload.text,
              dispatch.payload.sourceSnapshots,
            ),
            intent: dispatch.payload.intent ?? dispatch.payload.text,
            images: dispatch.payload.images,
            model: dispatch.expected.selection.model,
            reasoningEffort: dispatch.expected.selection.thinking,
          },
          dispatch.preparationSignal
            ? AbortSignal.any([session.abortController.signal, dispatch.preparationSignal])
            : session.abortController.signal,
          dispatch.assertCredentialSetupCurrent,
        );
        dispatch.preparationSignal?.throwIfAborted();
        resolveOwnedTelosWorkCommandScope(sessionId);
        if (!dispatch.agentMessageId)
          storeAndEchoIfNew(
            sessionId,
            dispatch.commandId,
            dispatch.payload.text,
            current.clientId,
            session.transport,
            session.observers,
            imagePreviews(dispatch.payload.images),
            undefined,
            dispatch.payload.sourceSnapshots,
            'user',
            false,
          );
      },
      dispatch: async (dispatch) => {
        if (prepared || released || !driver) throw unavailable();
        prepared = await prepareOwnedLocalCodexChat(transport, clientId, dispatch, {
          operatorConnectionId,
          ownerConnectionId,
          ownerAuthSessionId,
          onEnded: release,
          adviserScope: input.adviserScope,
          onSessionPrepared: input.onSessionPrepared,
          onQueryEvent: input.onQueryEvent,
          onTerminalOutcome: input.onTerminalOutcome,
        });
      },
    });
    const admitFirst = (command: unknown) =>
      preparationOperationId !== undefined
        ? driver!.admitPreparedFirst(preparationOperationId, command)
        : driver!.admit(command);
    const result = input.savedRecovery
      ? await driver.recoverSavedResume()
      : input.recovery
        ? await driver.recoverResume(command)
        : resume
          ? await driver.admitResume(command)
          : await admitFirst(command);
    resolveOwnedTelosWorkCommandScope(sessionId);
    if (!result.dispatched) {
      if (prepared) throw unavailable();
      release();
      return { dispatched: false, sessionId };
    }
    if (!prepared || released) throw unavailable();
    const liveSession = registry.findBySessionId(sessionId)?.session;
    if (!liveSession) throw unavailable();
    const retainedDriver = driver;
    liveSession.ordinaryRuntimeOwner = {
      location: 'local',
      authSessionId: ownerAuthSessionId,
      reauthorize: (connectionId) => retainedDriver.reauthorize(connectionId),
      identity: retainedDriver,
      initialCommandId: commandId,
      initialPreparationOperationId: preparationOperationId,
      initialResume: resume,
      admit: (command, signal) => retainedDriver.admitContinuation(command, signal),
      notifyCredentialSetup: (notice) => {
        const meta = eventStore.getSession(sessionId);
        if (!meta) throw unavailable();
        return retainedDriver.notifyCredentialSetup({
          ...notice,
          assertCurrent: () => {
            notice.assertCurrent();
            const current = registry.findBySessionId(sessionId)?.session;
            if (
              current !== liveSession ||
              current.ordinaryRuntimeOwner?.identity !== retainedDriver ||
              current.mode !== meta.mode
            )
              throw unavailable();
            resolveOwnedTelosWorkCommandScope(sessionId);
          },
        });
      },
      admitAgentMessage: (messageId, assertSenderCurrent, signal) =>
        retainedDriver.admitAgentMessage(messageId, assertSenderCurrent, signal),
      retryInitial: (command) =>
        preparationOperationId !== undefined
          ? retainedDriver.admitPreparedFirst(preparationOperationId, command)
          : resume
            ? retainedDriver.admitResume(command)
            : retainedDriver.admit(command),
      close: release,
    };
    const ownedQuery = prepared;
    // run() is the existing chat task, started only after admit saved consumed.
    // Its normal completion/abort closes the driver through required onEnded.
    void ownedQuery.run().catch((error: unknown) => {
      reportRetainedRuntimeFailure({
        store: eventStore,
        sessionId,
        commandId,
        session: liveSession,
        transport,
        error,
      });
      try {
        ownedQuery.close();
      } catch {
        log.warn('owned local chat task cleanup remains unconfirmed', { sessionId });
      }
      try {
        release();
      } catch {
        log.warn('owned local chat authority release remains unconfirmed', { sessionId });
      }
    });
    return { dispatched: true, sessionId };
  } catch (error) {
    try {
      prepared?.close();
    } catch {
      /* Preserve receipt/workspace uncertainty. */
    }
    try {
      release();
    } catch {
      /* No automatic retry or custody cleanup. */
    }
    throw (
      findNativeMacExecutionUnavailable(error) ?? findSessionRuntimeError(error) ?? unavailable()
    );
  }
}

/** Trusted first-command consumer. Native startup and turn/start settle while the
 * existing receipt remains uncertain. The caller starts event consumption only
 * after its admission coordinator has committed consumed. Legacy startup,
 * account preflight, runtime inference and workspace acquisition are excluded.
 */
export const prepareOwnedLocalCodexChat = prepareOwnedCodexChat;

function isOrdinaryWorkspace(
  value: LocalWorkspaceRecord<LocalWorkspaceKind>,
): value is OrdinaryWorkspaceRecord {
  return 'kind' in value && value.kind === 'ordinary';
}

export async function prepareOwnedCodexChat(
  transport: SessionTransport,
  clientId: string,
  input: OrdinaryLocalCodexOwnedDispatch<LocalWorkspaceKind> | OrdinaryOpenShellCodexOwnedDispatch,
  options: {
    /** Retained startup operator, distinct from the browser's event connection. */
    operatorConnectionId?: string;
    ownerConnectionId?: string;
    ownerAuthSessionId?: string;
    onSessionResolved?: (sessionId: string) => void;
    onFirstEventOutcome?: (error?: Error) => void;
    onTerminalOutcome?: (error?: Error) => void;
    onEnded: () => void;
    adviserScope?: AdviserTaskScope;
    onSessionPrepared?: (session: ManagedSession) => void;
    onQueryEvent?: (event: Readonly<Record<string, unknown>>) => void;
  },
): Promise<{ run(): Promise<void>; close(): void }> {
  const unavailable = () =>
    new Error(
      input.admission instanceof OwnedOpenShellCodexChatAdmission
        ? 'Owned OpenShell Codex chat unavailable'
        : 'Owned local Codex chat unavailable',
    );
  const boundAccount = 'lease' in input ? input.lease.binding : input.account;
  const localAdmission =
    input.admission instanceof OwnedLocalCodexChatAdmission ? input.admission : undefined;
  const openShellAdmission =
    input.admission instanceof OwnedOpenShellCodexChatAdmission ? input.admission : undefined;
  const resume = 'resume' in input ? input.resume : undefined;
  let releaseOwner: () => void;
  let selected: {
    expected:
      OrdinaryLocalCodexOwnedDispatch['expected'] | OrdinaryOpenShellCodexOwnedDispatch['expected'];
    workspace: OrdinaryLocalCodexOwnedDispatch<LocalWorkspaceKind>['workspace'];
    payload: OrdinaryLocalCodexOwnedDispatch['payload'];
    profile: OrdinaryLocalCodexOwnedDispatch['profile'];
  };
  try {
    const release = options?.onEnded;
    if (typeof release !== 'function') throw unavailable();
    releaseOwner = () => release.call(options);
    if (
      (!localAdmission && !openShellAdmission) ||
      custodianControllerMode ||
      custodianOwnerMode ||
      !/^\S{1,200}$/.test(clientId) ||
      registry.get(clientId) ||
      registry.findBySessionId(input.sessionId)
    )
      throw unavailable();
    input.admission.assertConsumerOwner(eventStore, input.sessionId, input.commandId);
    resolveOwnedTelosWorkCommandScope(input.sessionId);
    selected = structuredClone({
      expected: input.expected,
      workspace: input.workspace,
      payload: input.payload,
      profile: input.profile,
    });
    const { workspace, expected } = selected;
    if (openShellAdmission && workspace.directory === undefined)
      workspace.directory = expected.workspace.cwd;
    if (
      workspace.state !== 'claimed' ||
      Boolean('sandbox' in workspace && workspace.sandbox) !== Boolean(openShellAdmission) ||
      workspace.conversationId !== input.sessionId ||
      workspace.id !== expected.workspace.workspaceId ||
      workspace.directory !== expected.workspace.cwd ||
      !isDeepStrictEqual(workspace.binding, boundAccount)
    )
      throw unavailable();
    input.admission.assertPreparedOptions({
      ...selected.payload,
      intent: selected.payload.intent ?? selected.payload.text,
      prompt: assembleSourceSnapshots(selected.payload.text, selected.payload.sourceSnapshots),
      conversationId: input.sessionId,
      messageId: input.commandId,
      resume,
      binding: boundAccount,
      profile: selected.profile,
      session: { cwd: expected.workspace.cwd, mode: expected.selection.permission.mode },
      model: expected.selection.model,
      reasoningEffort: expected.selection.thinking,
      agentProfile: expected.agentProfile,
      agentContext: expected.agentContext,
      ...(isOrdinaryWorkspace(workspace)
        ? { ordinaryWorkspace: workspace }
        : { repositoryWorkspace: workspace }),
    });
  } catch (error) {
    throw findSessionRuntimeError(error) ?? unavailable();
  }

  const { expected, workspace, payload, profile } = selected;
  const sessionId = input.sessionId;
  const commandId = input.commandId;
  const admission = input.admission;
  const abortController = new AbortController();
  let queryInstance: QueryInstance | undefined;
  let session: ManagedSession | undefined;
  let ownedClientId = clientId;
  let closed = false;
  let ran = false;
  let releaseNativeHostOperator: (() => void) | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    abortController.signal.removeEventListener('abort', onAbort);
    let failed = false;
    const attempt = (operation: () => void) => {
      try {
        operation();
      } catch {
        failed = true;
      }
    };
    attempt(() => queryInstance?.close());
    attempt(() => admission.close());
    attempt(() => releaseNativeHostOperator?.());
    attempt(() => {
      const current = registry.findBySessionId(sessionId);
      if (session && current?.session === session) {
        ownedClientId = current.clientId;
        registry.abort(ownedClientId);
      } else abortController.abort();
    });
    // The workspace ledger and command receipt retain their original state.
    attempt(() =>
      eventStore.setSessionState(sessionId, 'ENDED', {
        clientId: ownedClientId,
        reason: 'owned_local_closed',
      }),
    );
    attempt(releaseOwner);
    attempt(() => _onSessionChange?.(ownedClientId, 'end', sessionId));
    if (failed) throw unavailable();
  };
  const onAbort = () => {
    try {
      close();
    } catch {
      log.warn('owned local chat abort cleanup remains unconfirmed', { sessionId });
    }
  };
  let releaseStartup: (() => void) | undefined;
  try {
    releaseStartup = eventStore.reserveOrdinaryStartup([sessionId]);
    admission.assertConsumerOwner(eventStore, sessionId, commandId);
    registry.register(clientId, {
      transport,
      abortController,
      sessionId,
      cwd: expected.workspace.cwd,
      mode: expected.selection.permission.mode,
      model: expected.selection.model,
      branch: 'featureBranch' in workspace ? workspace.featureBranch : undefined,
      agentName: expected.agentProfile?.definition.name,
      accountBinding: structuredClone(boundAccount),
      sessionAllowList: new Set(),
      ownerConnectionId: options.ownerConnectionId,
      ownedLocalAuthSessionId: options.ownerAuthSessionId,
    });
    session = registry.get(clientId)!;
    if (localAdmission && options.operatorConnectionId)
      releaseNativeHostOperator = retainNativeHostToolOperator(
        session,
        options.operatorConnectionId,
      );
    resolveOwnedTelosWorkCommandScope(sessionId);
    options.onSessionPrepared?.(session);
    if (options.adviserScope) {
      options.adviserScope.assertSelection(boundAccount, expected.selection.thinking);
      eventStore.append(sessionId, 'adviser_task_scope', {
        version: 1,
        contextSha256: options.adviserScope.contextSha256,
        feature: options.adviserScope.feature(),
        policy: 'reviewed-context-only',
      });
    }
    // Existing public stop/interrupt controls expect this lifecycle marker.
    // Native commands remain owned exclusively by CodexConversation's FIFO.
    session.inputQueue = {
      push: () => {
        throw new Error('Runtime-bound commands require guarded admission');
      },
      close: () => {},
    };
    abortController.signal.addEventListener('abort', onAbort, { once: true });
    eventStore.setSessionState(sessionId, 'CREATED', { clientId });
    _onSessionChange?.(clientId, 'start');
    send(transport, { type: 'session_id', sessionId, clientMsgId: commandId });
    send(transport, {
      type: 'session_info',
      sessionId,
      cwd: expected.workspace.cwd,
      branch: 'featureBranch' in workspace ? workspace.featureBranch : undefined,
      worktree: false,
    });
    storeAndEchoIfNew(
      sessionId,
      commandId,
      payload.text,
      clientId,
      transport,
      session.observers,
      imagePreviews(payload.images),
      undefined,
      payload.sourceSnapshots,
      'user',
      false,
    );
    if (expected.agentContext) {
      const context = bootContextWithRetainedReceipt(
        expected.agentContext,
        eventStore.getSession(sessionId)?.bootContext ?? undefined,
      );
      eventStore.upsertSession({ sessionId, bootContext: JSON.stringify(context) });
      send(transport, { ...context, sessionId });
    }
    const env = buildSdkChildEnvironment();
    env.MITZO_SESSION_ID = sessionId;
    env.MITZO_AGENT_NAME = expected.agentProfile?.definition.name ?? '';
    queryInstance = await openCodexChat({
      ownedLocal: localAdmission,
      ownedOpenShell: openShellAdmission,
      resume,
      conversationId: sessionId,
      messageId: commandId,
      binding: structuredClone(boundAccount),
      profile,
      session,
      registry,
      ...(isOrdinaryWorkspace(workspace)
        ? { ordinaryWorkspace: workspace }
        : { repositoryWorkspace: workspace }),
      agentProfile: expected.agentProfile,
      agentContext: expected.agentContext,
      prepareAgentContext: async (signal) => {
        signal.throwIfAborted();
        resolveOwnedTelosWorkCommandScope(sessionId);
        // openCodexChat brackets this callback with fresh checks of this same
        // admission. Keep the local scope fence without a third credential read.
        signal.throwIfAborted();
        admission.assertCurrentSync();
        resolveOwnedTelosWorkCommandScope(sessionId);
      },
      assertWorkTurnAdmission: () => {
        admission.assertCurrentSync();
        resolveOwnedTelosWorkCommandScope(sessionId, true);
      },
      assertAgentContextAuthorization: () => {
        admission.assertCurrentSync();
        resolveOwnedTelosWorkCommandScope(sessionId);
      },
      onBootContext: (context) => send(transport, { ...context, sessionId }),
      onAgentContextAccepted: (acceptedCommandId, threadId, turnId, contextSha256) => {
        admission.assertCurrentSync();
        const snapshot = eventStore.getSession(sessionId)?.agentContext;
        if (!snapshot) throw unavailable();
        const context = recordAgentContextAcceptance({
          store: eventStore,
          sessionId,
          snapshot,
          commandId: acceptedCommandId,
          providerThreadId: threadId,
          providerTurnId: turnId,
          contextSha256,
        });
        send(transport, { ...context, sessionId });
      },
      prompt: assembleSourceSnapshots(payload.text, payload.sourceSnapshots),
      intent: payload.intent ?? payload.text,
      systemPrompt: payload.systemPrompt,
      adviserScope: options.adviserScope,
      model: expected.selection.model,
      reasoningEffort: expected.selection.thinking,
      images: payload.images,
      env,
      configuredSourceEnv: nativeExecutionEnv(),
      mcpServers: options.adviserScope
        ? {}
        : {
            ...mcpServers,
            ...(supportsHostTaskTools(!!openShellAdmission) ? buildTaskMcpServer(clientId) : null),
          },
      eventStore,
      publishingGitStorageRoots: isOrdinaryWorkspace(workspace)
        ? undefined
        : [
            ...(workspace.localSource ? [workspace.localSource.commonDirectory] : []),
            ...[BASE_REPO, ...Object.values(getRepoConfig().repos)]
              .filter(Boolean)
              .map((root) => join(root, '.git')),
          ],
    });
    resolveOwnedTelosWorkCommandScope(sessionId);
    if (closed || abortController.signal.aborted) {
      queryInstance.close();
      throw unavailable();
    }
    if (registry.findBySessionId(sessionId)?.session !== session) throw unavailable();
    session.queryInstance = queryInstance;
    eventStore.setSessionState(sessionId, 'STARTING', { clientId });
    options.onSessionResolved?.(sessionId);
  } catch (error) {
    try {
      close();
    } catch {
      /* Retain uncertainty even if shutdown cannot finish. */
    }
    throw (
      findNativeMacExecutionUnavailable(error) ?? findSessionRuntimeError(error) ?? unavailable()
    );
  } finally {
    releaseStartup?.();
  }
  const preparedQuery = queryInstance;
  return {
    close,
    run: async () => {
      let currentClientId: string;
      try {
        if (
          closed ||
          ran ||
          (localAdmission
            ? eventStore.getOrdinaryLocalCommandExecutionAdmission(commandId)
            : eventStore.getOrdinaryCommandAdmission(commandId)
          )?.state !== 'consumed'
        )
          throw unavailable();
        admission.assertConsumerOwner(eventStore, sessionId, commandId);
        resolveOwnedTelosWorkCommandScope(sessionId);
        const current = registry.findBySessionId(sessionId);
        if (!current || current.session !== session) throw unavailable();
        if (!session.transport.isOpen())
          detachChatIfCurrentTransport(current.clientId, session.transport);
        // Detach notifies the existing lifecycle callback; capture its current key afterward.
        const ready = registry.findBySessionId(sessionId);
        if (!ready || ready.session !== session) throw unavailable();
        currentClientId = ready.clientId;
        ownedClientId = currentClientId;
      } catch (error) {
        throw findSessionRuntimeError(error) ?? unavailable();
      }
      ran = true;
      const safeEvents = async function* () {
        try {
          yield* preparedQuery;
        } catch (error) {
          throw findSessionRuntimeError(error) ?? unavailable();
        }
      };
      try {
        if (localAdmission) {
          // openCodexChat can enqueue and attempt a pump while the owning
          // admission is uncertain. Consumption does not itself wake that
          // native FIFO: release the original queue here, exactly once, after
          // this owner's consumed/identity checks. Never resume paused work.
          const native = getCodexRuntime(session);
          if (!native) throw unavailable();
          if (resume) await native.resumeAfterExplicitSend();
          else await native.startQueued();
        }
        await runQueryLoop(
          safeEvents(),
          currentClientId,
          registry,
          abortController,
          eventStore,
          undefined,
          {
            connRegistry: _connRegistry ?? undefined,
            initialClientMsgId: commandId,
            initialImages: imagePreviews(payload.images),
            onFirstEventOutcome: options.onFirstEventOutcome,
            onTerminalOutcome: options.onTerminalOutcome,
            onEvent: options.onQueryEvent,
            onTurnEnd: (ownerClientId) => _onSessionChange?.(ownerClientId, 'turn_end'),
            onSuccessfulAccountUse: (binding) => getAccountUseStore().record(binding),
          },
        );
      } catch (error) {
        throw findSessionRuntimeError(error) ?? unavailable();
      } finally {
        close();
      }
    },
  };
}

/** Echo uses the existing transcript owner after guarded native FIFO admission. */
export function echoOwnedCodexCommand(
  sessionId: string,
  commandId: string,
  payload: {
    text: string;
    sourceSnapshots?: SourceSnapshot[];
    images?: Array<{ data: string; mediaType: string }>;
  },
): void {
  const current = registry.findBySessionId(sessionId);
  if (!current) throw Error('Owned Codex conversation unavailable');
  storeAndEchoIfNew(
    sessionId,
    commandId,
    payload.text,
    current.clientId,
    current.session.transport,
    current.session.observers,
    imagePreviews(payload.images),
    undefined,
    payload.sourceSnapshots,
    'user',
    false,
  );
}

/**
 * Check if an auto-rename should fire for a session and perform it if so.
 * Runs asynchronously — errors are logged but don't affect the session.
 */
async function tryAutoRename(sessionId: string, clientId: string): Promise<void> {
  try {
    const sessionMeta = eventStore.getSession(sessionId);
    if (!sessionMeta) return;

    const promptCount = eventStore.incrementPromptCount(sessionId);
    if (!shouldAutoRename(promptCount, sessionMeta.manuallyRenamed)) return;

    const events = eventStore.getSessionEvents(sessionId);
    const prompts = extractRecentPrompts(events);
    const newName = await accountSessionName(prompts, sessionMeta.accountBinding);
    if (!newName) return;

    log.info('auto-renaming session', { sessionId, promptCount, newName });

    // Persist to EventStore first — survives SDK rename failures.
    eventStore.upsertSession({ sessionId, summary: newName });
    _onSessionsChanged?.();

    // Update the SDK session name (best-effort, fire-and-forget)
    renameSessionById(sessionId, newName, false).catch((err: unknown) => {
      log.warn('auto-rename SDK call failed', {
        sessionId,
        error: err instanceof Error ? err.message : 'unknown',
      });
    });

    // Update session index title (initial_title frozen, last_title updated)
    const session = registry.get(clientId);
    if (session?.wtId) {
      try {
        updateSessionTitle(BASE_REPO, session.wtId, newName);
      } catch (err: unknown) {
        log.warn('session index title update failed', {
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    }

    // Push the new name to the connected frontend
    if (session) {
      send(session.transport, { type: 'session_renamed', sessionId, name: newName });
    }
  } catch (err: unknown) {
    log.warn('auto-rename failed', {
      sessionId,
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
}

/**
 * Store and echo a user message only if it hasn't been stored before.
 * Returns true if the message was a duplicate (already stored), false if newly stored.
 */
function storeAndEchoIfNew(
  sessionId: string,
  messageId: string,
  text: string,
  clientId: string,
  transport: SessionTransport,
  observers: Set<SessionTransport>,
  images?: string[],
  contextBlocks?: string[],
  sourceSnapshots?: SourceSnapshot[],
  source: 'user' | 'closeout' = 'user',
  autoRename = true,
): boolean {
  if (eventStore.hasUserMessage(sessionId, messageId)) {
    return true;
  }
  const seq = eventStore.append(sessionId, 'user_message', {
    v: 2,
    type: 'user_message',
    ts: Date.now(),
    messageId,
    text,
    ...(source === 'closeout' ? { source } : {}),
    ...(images?.length ? { images } : {}),
    ...(contextBlocks?.length ? { contextBlocks } : {}),
    ...(sourceSnapshots?.length ? { sourceSnapshots } : {}),
  });
  eventStore.updateLastSpeaker(sessionId, 'user');
  _onSessionChange?.(clientId, 'user_message');
  const echo = {
    type: 'user_message',
    v: 2,
    messageId,
    text,
    ...(source === 'closeout' ? { source } : {}),
    sessionId,
    seq,
    prevSessionSeq: eventStore.getSessionPredecessorSeq(sessionId, seq),
    ...(images?.length ? { images } : {}),
    ...(contextBlocks?.length ? { contextBlocks } : {}),
    ...(sourceSnapshots?.length ? { sourceSnapshots } : {}),
  };
  send(transport, echo);
  broadcastToObservers(observers, echo);
  // Native providers bypass the SDK query-loop callbacks that name Claude chats.
  const provider = eventStore.getSession(sessionId)?.accountBinding?.provider;
  if (
    autoRename &&
    source === 'user' &&
    (provider === 'openai-codex' || provider === 'openai' || provider === 'google-vertex')
  ) {
    void tryAutoRename(sessionId, clientId);
  }
  return false;
}

function imagePreviews(images?: Array<{ data: string; mediaType: string }>): string[] | undefined {
  return images?.map((image) => `data:${image.mediaType};base64,${image.data}`);
}

function providerFingerprintSource(
  fullPrompt: string,
  images?: Array<{ data: string; mediaType: string }>,
): string {
  return JSON.stringify({ effectivePrompt: fullPrompt, images });
}

function terminalizeUndispatchedStartup(admission: ProviderDispatchAdmission | undefined): boolean {
  if (!admission) return false;
  const current = eventStore.getSession(admission.token.sessionId);
  if (
    current?.executionId !== admission.token.executionId ||
    current.executionGeneration !== admission.token.generation ||
    current.executionPhase !== 'RUNNING' ||
    eventStore.getProviderAttempts(admission.token).length > 0
  ) {
    return false;
  }
  try {
    eventStore.transitionExecution(admission.token, 'TERMINAL', 'startup_failed');
  } catch (cleanupError) {
    log.warn('could not persist native startup failure; restart recovery required', {
      sessionId: admission.token.sessionId,
      error: cleanupError instanceof Error ? cleanupError.message : 'unknown',
    });
  }
  return true;
}

function cleanupUndispatchedStartup(
  admission: ProviderDispatchAdmission | undefined,
  clientId: string,
): void {
  if (!admission || eventStore.getProviderAttempts(admission.token).length > 0) return;
  terminalizeUndispatchedStartup(admission);
  const current = eventStore.getSession(admission.token.sessionId);
  const failedBeforeDispatch =
    current?.executionId === admission.token.executionId &&
    current.executionGeneration === admission.token.generation &&
    current.executionPhase === 'TERMINAL' &&
    current.executionTerminalReason === 'startup_failed';
  if (!failedBeforeDispatch) return;
  try {
    eventStore.setSessionState(admission.token.sessionId, 'ENDED', {
      clientId,
      reason: 'startup_failed',
    });
  } catch (cleanupError) {
    log.warn('could not persist failed native startup state', {
      sessionId: admission.token.sessionId,
      error: cleanupError instanceof Error ? cleanupError.message : 'unknown',
    });
  }
  const failedSession = registry.get(clientId);
  if (failedSession) cleanupSessionWorktrees(failedSession);
  registry.abort(clientId);
}

/**
 * Consult durable native-provider admission before a registry-missing resume
 * route performs takeover, watch, transcript, or runtime side effects.
 */
export function preflightStartupProviderCommand(
  store: EventStore,
  request: {
    sessionId: string;
    clientMsgId: string;
    prompt: string;
    cwd: string;
    images?: Array<{ data: string; mediaType: string }>;
    contextBlocks?: string[];
    sourceSnapshots?: SourceSnapshot[];
    model?: string;
    reasoningEffort?: string | null;
  },
): boolean {
  if (store.getSessionRuntimeBinding(request.sessionId))
    throw new Error('Runtime-bound commands require guarded admission');
  const meta = store.getSession(request.sessionId);
  const binding = meta?.accountBinding;
  if (!binding) return false;
  const existingAdmission = store.getExecutionAdmission(request.sessionId, request.clientMsgId);
  const stablePrompt = assemblePrompt(
    request.prompt,
    request.cwd,
    undefined,
    request.contextBlocks,
    request.sourceSnapshots,
  );
  const providerRequest = {
    sessionId: request.sessionId,
    clientMsgId: request.clientMsgId,
    effectivePrompt: stablePrompt,
    fingerprintSource: providerFingerprintSource(stablePrompt, request.images),
    model: request.model ?? meta.selectedModel ?? binding.model,
    reasoningEffort: request.reasoningEffort,
    accountBinding: binding,
  };
  // Durable evidence wins over the current environment. This keeps a routing
  // toggle across restart from replaying a command through the other provider
  // implementation. A native admission can be checked exactly; a legacy
  // OpenShell user message is only evidence that startup began, so its dispatch
  // outcome is ambiguous and requires a fresh command ID.
  if (existingAdmission) return preflightProviderDispatch(store, providerRequest);
  if (store.hasUserMessage(request.sessionId, request.clientMsgId)) {
    throw new Error(
      'Existing command has ambiguous legacy OpenShell dispatch state; retry with a new command ID',
    );
  }
  const openShellAvailable =
    process.env.MITZO_OPENSHELL_ENABLED === '1' || !!process.env.MITZO_OPENSHELL_SANDBOX_NAME;
  const isNative =
    binding.provider === 'google-vertex' ||
    (binding.provider === 'openai' &&
      (!openShellAvailable || process.env.MITZO_OPENSHELL_OPENAI_API_ENABLED === '0'));
  if (!isNative) return false;
  return preflightProviderDispatch(store, providerRequest);
}

function validateNativeModelSelection(
  sessionId: string,
  model?: string,
  reasoningEffort?: string | null,
): void {
  if (!model && reasoningEffort === undefined) return;
  const meta = eventStore.getSession(sessionId);
  const binding = meta?.accountBinding;
  if (!binding) throw new Error('Bound account metadata is unavailable');
  loadAccountProfiles().validateModelSelection(
    binding,
    model ?? meta.selectedModel ?? binding.model,
    reasoningEffort,
  );
}

/** Push a follow-up message into a running session.
 * UI routes supply onRetained to opt into retention acknowledgment even if
 * later admission fails. Programmatic callers receive false for that refusal. */
export async function sendToChat(
  clientId: string,
  prompt: string,
  images?: Array<{ data: string; mediaType: string }>,
  contextBlocks?: string[],
  clientMsgId?: string,
  model?: string,
  reasoningEffort?: string | null,
  signal?: AbortSignal,
  userIntent?: string,
  sourceSnapshots?: SourceSnapshot[],
  onRetained?: () => void,
): Promise<boolean> {
  return withSpanAsync('chat.send', { 'chat.clientId': clientId }, async () => {
    if (signal?.aborted) return false;
    const session = registry.get(clientId);
    if (session?.sessionId && eventStore.getSessionRuntimeBinding(session.sessionId))
      throw new Error('Runtime-bound commands require guarded admission');
    if (session?.sessionId)
      assertOrdinaryContributorControlAllowed(eventStore, session.sessionId, 'send');
    if (session?.sessionId && eventStore.getLatestEvent(session.sessionId, 'adviser_task_scope'))
      throw Error('Adviser history is read-only; ask again with a reviewed snapshot');
    if (session?.sessionId && eventStore.getSession(session.sessionId)?.symposiumConfig)
      throw new Error('Use Symposium directed prompts for this session');
    if (!session?.inputQueue) return false;
    const codex = getCodexRuntime(session);
    const responses = getResponsesRuntime(session);
    if (responses && session.accountBinding?.provider !== 'google-vertex')
      throw Error('Custom Responses execution is retired; review a linked native continuation');
    if (!codex && !responses && model && model !== session.model) {
      send(session.transport, {
        type: 'error',
        sessionId: session.sessionId,
        error:
          'Changing models in an active Anthropic session is not supported. Start a new task to use the selected model.',
      });
      return false;
    }
    if (codex && session.activeSkillPolicy) {
      send(session.transport, {
        type: 'error',
        sessionId: session.sessionId,
        error: 'Codex restricted skill tool ceilings are not yet supported',
      });
      return false;
    }
    if (
      responses &&
      images?.length &&
      session.sessionId &&
      eventStore.getSession(session.sessionId)?.accountBinding?.provider === 'google-vertex'
    ) {
      send(session.transport, {
        type: 'error',
        sessionId: session.sessionId,
        error: 'Gemini image attachments are not yet supported',
      });
      return false;
    }
    if (
      images?.length &&
      (responses ||
        (codex &&
          (session.accountBinding?.provider ??
            (session.sessionId
              ? eventStore.getSession(session.sessionId)?.accountBinding?.provider
              : undefined)) === 'openai'))
    ) {
      try {
        responsesUserContent(prompt, images);
      } catch (error) {
        send(session.transport, {
          type: 'error',
          sessionId: session.sessionId,
          error: error instanceof Error ? error.message : 'Invalid API image attachment',
        });
        return false;
      }
    }
    const fullPrompt = assemblePrompt(
      prompt,
      session.cwd ?? '.',
      codex || responses ? undefined : images,
      contextBlocks,
      sourceSnapshots,
    );
    const messageId = clientMsgId || `umsg-${Date.now()}-${randomUUID().slice(0, 8)}-send`;
    const previews = imagePreviews(images);
    let selectionReasoningEffort =
      model && model !== session.model && reasoningEffort === undefined ? null : reasoningEffort;
    let providerAdmission: ProviderDispatchAdmission | undefined;
    if (responses) {
      try {
        if (!session.sessionId) throw new Error('Bound session metadata is unavailable');
        if (
          clientMsgId &&
          eventStore.hasUserMessage(session.sessionId, clientMsgId) &&
          !eventStore.getExecutionAdmission(session.sessionId, clientMsgId)
        ) {
          return true;
        }
        const existingAdmission = eventStore.getExecutionAdmission(session.sessionId, messageId);
        if (!existingAdmission && responses.isRunning()) {
          throw new Error('Native Responses conversation already running');
        }
        validateNativeModelSelection(session.sessionId, model, selectionReasoningEffort);
        const binding = eventStore.getSession(session.sessionId)?.accountBinding ?? undefined;
        const prepare = () =>
          responses.prepare(messageId, responsesUserContent(fullPrompt, images), {
            ...(model ? { model } : {}),
            ...(selectionReasoningEffort !== undefined
              ? { reasoningEffort: selectionReasoningEffort }
              : {}),
          });
        providerAdmission = admitProviderDispatch({
          store: eventStore,
          request: {
            sessionId: session.sessionId,
            clientMsgId: messageId,
            effectivePrompt: fullPrompt,
            fingerprintSource: providerFingerprintSource(fullPrompt, images),
            model,
            reasoningEffort,
            accountBinding: binding,
          },
          prepare,
        });
        if (providerAdmission.duplicate) return true;
      } catch (error) {
        if (error instanceof ExecutionAdmissionError) throw error;
        send(session.transport, {
          type: 'error',
          sessionId: session.sessionId,
          error: 'Wait for the active OpenAI API turn to finish before sending another message.',
        });
        return false;
      }
    }
    const commitSelection = (): void => {
      if (!model && selectionReasoningEffort === undefined) return;
      if (session.sessionId) {
        eventStore.upsertSession({
          sessionId: session.sessionId,
          ...(model ? { selectedModel: model } : {}),
          ...(selectionReasoningEffort !== undefined
            ? { reasoningEffort: selectionReasoningEffort || null }
            : {}),
        });
      }
      if (model) {
        if (model !== session.model) clearWebSearchGrant(session);
        session.model = model;
      }
    };
    const failPreparedProviderCommand = (error: unknown): never => {
      if (!responses || !providerAdmission) throw error;
      const cleanupErrors: unknown[] = [];
      try {
        eventStore.transitionExecution(providerAdmission.token, 'TERMINAL', 'startup_failed');
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      } finally {
        try {
          responses.abandon(messageId);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length) {
        const message = error instanceof Error ? error.message : 'Provider command startup failed';
        throw new AggregateError([error, ...cleanupErrors], message);
      }
      throw error;
    };
    const acknowledge = (): boolean => {
      if (session.sessionId) {
        const isDup = storeAndEchoIfNew(
          session.sessionId,
          messageId,
          sourceSnapshots?.length ? prompt : fullPrompt,
          clientId,
          session.transport,
          session.observers,
          previews,
          contextBlocks,
          ...(sourceSnapshots?.length ? ([sourceSnapshots] as const) : ([] as const)),
        );
        const provider = eventStore.getSession(session.sessionId)?.accountBinding?.provider;
        if (
          !isDup &&
          provider !== 'openai-codex' &&
          provider !== 'openai' &&
          provider !== 'google-vertex'
        ) {
          tryAutoRename(session.sessionId, clientId).catch(() => {
            /* errors logged internally */
          });
        }
        return isDup;
      } else {
        // Pre-session-resolve: no eventStore to dedup against.
        // The frontend deduplicates echoes by messageId, and server-generated
        // fallback IDs include randomUUID, so duplicates are not possible in practice.
        const echo = {
          type: 'user_message',
          v: 2,
          messageId,
          text: sourceSnapshots?.length ? prompt : fullPrompt,
          ...(previews?.length ? { images: previews } : {}),
          ...(contextBlocks?.length ? { contextBlocks } : {}),
          ...(sourceSnapshots?.length ? { sourceSnapshots } : {}),
        };
        send(session.transport, echo);
        broadcastToObservers(session.observers, echo);
        return false;
      }
    };
    if (codex) {
      let promptRetained = false;
      const savedSessionId = session.sessionId;
      const reportSavedError = (error: string): void => {
        if (!savedSessionId) {
          send(session.transport, { type: 'error', sessionId: savedSessionId, error });
          return;
        }
        const event = {
          v: 2,
          type: 'error',
          sessionId: savedSessionId,
          clientMsgId: messageId,
          retainedCommandFailure: true,
          error,
        };
        // An attached owner keeps its existing stream transport. The current
        // POST wrapper may never observe this event, so persist its exact
        // failure here; wrappers recognize seq and do not append it again.
        if (eventStore.getSendCommand(messageId)?.sessionId === savedSessionId)
          eventStore.failSendCommand(messageId, error);
        const seq = eventStore.append(savedSessionId, 'error', event);
        const durable = {
          ...event,
          seq,
          prevSessionSeq: eventStore.getSessionPredecessorSeq(savedSessionId, seq),
        };
        send(session.transport, durable);
        broadcastToObservers(session.observers, durable);
      };
      try {
        // The ordinary HTTP receipt confirms saved intent, not provider
        // admission. Keep idle health checks and recovery after this exact
        // durable echo; their existing private queue/dispatch fences still run.
        if (session.sessionId) {
          acknowledge();
          promptRetained = true;
          onRetained?.();
        }
        const selection = await codex.admitExplicitSend(
          {
            id: messageId,
            prompt: fullPrompt,
            intent: userIntent ?? prompt,
            images,
            reasoningEffort,
            ...(model ? { model } : {}),
          },
          signal,
        );
        selectionReasoningEffort = selection.reasoningEffort;
        if (!promptRetained) acknowledge();
        commitSelection();
        void codex
          .resumeAfterExplicitSend()
          .catch((error: unknown) =>
            reportSavedError(
              `Message saved. ${publicCodexRuntimeError(error instanceof Error ? error : new Error('Reconnect failed'))}`,
            ),
          );
      } catch {
        if (promptRetained) {
          reportSavedError(
            signal?.aborted
              ? 'Message saved. Codex queue preparation was cancelled. Check the conversation before sending a new message.'
              : 'Message saved. Codex queue admission could not finish. Check the connection before sending a new message.',
          );
          // UI routes explicitly opt into retention acknowledgment and already
          // received the exact saved failure. Programmatic dispatch still needs
          // false so its task owner can mark a refused admission as blocked.
          return !!onRetained;
        }
        if (signal?.aborted) return false;
        send(session.transport, {
          type: 'error',
          sessionId: session.sessionId,
          error:
            'Message could not be saved to the Codex queue. Retry after checking storage and connection.',
        });
        return false;
      }
    } else {
      let duplicate = false;
      try {
        duplicate = acknowledge();
      } catch (error) {
        failPreparedProviderCommand(error);
      }
      if (duplicate) {
        if (responses && providerAdmission) {
          failPreparedProviderCommand(
            new Error('Provider command was already acknowledged without a dispatch'),
          );
        }
        return true;
      }
      try {
        commitSelection();
        if (responses && providerAdmission) {
          trackResponsesProviderAdmission(session, providerAdmission, eventStore);
        }
        session.inputQueue.push(
          makeUserMessage(
            fullPrompt,
            'next',
            responses ? messageId : undefined,
            providerAdmission,
            undefined,
            responses ? images : undefined,
          ),
        );
      } catch (error) {
        failPreparedProviderCommand(error);
      }
    }
    return true;
  });
}

/** Interrupt the current generation and inject a message the model sees immediately. */
export function preflightChatCommand(
  clientId: string,
  prompt: string,
  images?: Array<{ data: string; mediaType: string }>,
  contextBlocks?: string[],
  clientMsgId?: string,
  model?: string,
  reasoningEffort?: string | null,
  sourceSnapshots?: SourceSnapshot[],
): boolean {
  const session = registry.get(clientId);
  if (session?.sessionId && eventStore.getSessionRuntimeBinding(session.sessionId))
    throw new Error('Runtime-bound commands require guarded admission');
  if (!session?.sessionId || !clientMsgId || !getResponsesRuntime(session)) return false;
  const stablePrompt = assemblePrompt(
    prompt,
    session.cwd ?? '.',
    undefined,
    contextBlocks,
    sourceSnapshots,
  );
  const binding = eventStore.getSession(session.sessionId)?.accountBinding ?? undefined;
  return preflightProviderDispatch(eventStore, {
    sessionId: session.sessionId,
    clientMsgId,
    effectivePrompt: stablePrompt,
    fingerprintSource: providerFingerprintSource(stablePrompt, images),
    model,
    reasoningEffort,
    accountBinding: binding,
  });
}

export async function interruptChat(
  clientId: string,
  prompt: string,
  images?: Array<{ data: string; mediaType: string }>,
  contextBlocks?: string[],
  clientMsgId?: string,
  model?: string,
  reasoningEffort?: string | null,
  sourceSnapshots?: SourceSnapshot[],
): Promise<boolean> {
  return withSpanAsync('chat.interrupt', { 'chat.clientId': clientId }, async () => {
    const session = registry.get(clientId);
    if (session?.sessionId)
      assertOrdinaryContributorControlAllowed(eventStore, session.sessionId, 'interrupt');
    if (session?.sessionId && eventStore.getSession(session.sessionId)?.symposiumConfig)
      throw new Error('Use Symposium directed prompts for this session');
    if (!session?.queryInstance || !session?.inputQueue) return false;
    if (session.sessionId && eventStore.getSessionRuntimeBinding(session.sessionId)) {
      // Cancellation remains available while later-turn admission is unenrolled.
      // Interrupting cannot authorize the accompanying replacement prompt/settings.
      await session.queryInstance.interrupt();
      if (
        prompt.trim() ||
        images?.length ||
        contextBlocks?.length ||
        sourceSnapshots?.length ||
        model !== undefined ||
        reasoningEffort !== undefined
      ) {
        send(session.transport, {
          type: 'error',
          sessionId: session.sessionId,
          error: 'Execution interrupted. Runtime-bound commands require guarded admission',
        });
        return false;
      }
      return true;
    }
    const codex = getCodexRuntime(session);
    const responses = getResponsesRuntime(session);
    if (responses && session.accountBinding?.provider !== 'google-vertex') {
      await session.queryInstance.interrupt();
      return false;
    }
    if (
      responses &&
      images?.length &&
      session.sessionId &&
      eventStore.getSession(session.sessionId)?.accountBinding?.provider === 'google-vertex'
    ) {
      send(session.transport, {
        type: 'error',
        sessionId: session.sessionId,
        error: 'Gemini image attachments are not yet supported',
      });
      return false;
    }
    if (
      images?.length &&
      (responses ||
        (codex &&
          (session.accountBinding?.provider ??
            (session.sessionId
              ? eventStore.getSession(session.sessionId)?.accountBinding?.provider
              : undefined)) === 'openai'))
    ) {
      try {
        responsesUserContent(prompt, images);
      } catch (error) {
        send(session.transport, {
          type: 'error',
          sessionId: session.sessionId,
          error: error instanceof Error ? error.message : 'Invalid API image attachment',
        });
        return false;
      }
    }
    const fullPrompt = assemblePrompt(
      prompt,
      session.cwd ?? '.',
      codex || responses ? undefined : images,
      contextBlocks,
      sourceSnapshots,
    );
    if (!codex && !responses && model && model !== session.model) {
      send(session.transport, {
        type: 'error',
        sessionId: session.sessionId,
        error:
          'Changing models in an active Anthropic session is not supported. Start a new task to use the selected model.',
      });
      return false;
    }
    if (codex) {
      if (session.activeSkillPolicy) {
        send(session.transport, {
          type: 'error',
          sessionId: session.sessionId,
          error: 'Codex restricted skill tool ceilings are not yet supported',
        });
        return false;
      }
      if (model) codex.validateModel(model, reasoningEffort);
      await codex.interrupt();
      return sendToChat(
        clientId,
        prompt,
        images,
        contextBlocks,
        clientMsgId,
        model,
        reasoningEffort,
        ...((sourceSnapshots?.length ? [undefined, undefined, sourceSnapshots] : []) as [
          undefined?,
          undefined?,
          SourceSnapshot[]?,
        ]),
      );
    }
    if (responses) {
      if (
        preflightChatCommand(
          clientId,
          prompt,
          images,
          contextBlocks,
          clientMsgId,
          model,
          reasoningEffort,
          ...(sourceSnapshots?.length ? ([sourceSnapshots] as const) : ([] as const)),
        )
      )
        return true;
      await session.queryInstance.interrupt();
      return sendToChat(
        clientId,
        prompt,
        images,
        contextBlocks,
        clientMsgId,
        model,
        reasoningEffort,
        ...((sourceSnapshots?.length ? [undefined, undefined, sourceSnapshots] : []) as [
          undefined?,
          undefined?,
          SourceSnapshot[]?,
        ]),
      );
    }
    if (model) {
      if (model !== session.model) clearWebSearchGrant(session);
      session.model = model;
    }
    if (session.sessionId && (model || reasoningEffort !== undefined)) {
      eventStore.upsertSession({
        sessionId: session.sessionId,
        ...(model ? { selectedModel: model } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort: reasoningEffort || null } : {}),
      });
    }
    const messageId = clientMsgId || `umsg-${Date.now()}-${randomUUID().slice(0, 8)}-interrupt`;
    const previews = imagePreviews(images);
    // Store and echo the user message. A retried interrupt must still stop
    // the agent — only the echo/store is skipped on duplicate.
    let isDup = false;
    if (session.sessionId) {
      isDup = storeAndEchoIfNew(
        session.sessionId,
        messageId,
        sourceSnapshots?.length ? prompt : fullPrompt,
        clientId,
        session.transport,
        session.observers,
        previews,
        contextBlocks,
        sourceSnapshots,
      );
    } else {
      // Pre-session-resolve: no eventStore to dedup against (see sendToChat).
      const echo = {
        type: 'user_message',
        v: 2,
        messageId,
        text: sourceSnapshots?.length ? prompt : fullPrompt,
        ...(previews?.length ? { images: previews } : {}),
        ...(contextBlocks?.length ? { contextBlocks } : {}),
        ...(sourceSnapshots?.length ? { sourceSnapshots } : {}),
      };
      send(session.transport, echo);
      broadcastToObservers(session.observers, echo);
    }
    // Stop all active subagent tasks before interrupting the parent query.
    // Without this, interrupt() only halts the parent — which is blocked
    // waiting for the subagent, so the session hangs.
    if (session.activeTaskIds.size > 0) {
      const stops = [...session.activeTaskIds.keys()].map((taskId) =>
        session
          .queryInstance!.stopTask(taskId)
          .catch((err: unknown) => log.warn('stopTask failed', { taskId, err })),
      );
      await Promise.allSettled(stops);
    }
    await session.queryInstance.interrupt();
    // Only push to inputQueue on first delivery — a retried interrupt should
    // still call interrupt() (to halt the agent) but not double-queue the prompt.
    if (!isDup) {
      session.inputQueue.push(makeUserMessage(fullPrompt, 'now'));
    }
    return true;
  });
}

// --- Session management ---

/** SDK/provider history remains bound to every task cwd across stop and
 * restart. Session shutdown releases runtime resources, never filesystem custody.
 * Explicit owner-controlled retirement is separate from query/transport lifetime. */
export function cleanupSessionWorktrees(
  session: import('./session-registry.js').ManagedSession,
): void {
  log.info('retaining session workspaces for owned retirement', {
    sessionId: session.sessionId,
    workspaces: session.worktreePaths.size,
  });
}

/** Persist, echo, and enqueue a closeout prompt through the active provider runtime. */
function queueCloseoutPrompt(
  session: import('./session-registry.js').ManagedSession,
  clientId: string,
  prompt: string,
  episode: CloseoutEpisode,
): void {
  if (!session.sessionId) {
    log.warn('skipping closeout admission — session not yet resolved', { clientId });
    return;
  }
  const codex = getCodexRuntime(session);
  const responses = getResponsesRuntime(session);
  if (responses && session.accountBinding?.provider !== 'google-vertex') {
    log.warn('retired Responses closeout requires explicit linked native continuation', {
      sessionId: session.sessionId,
    });
    return;
  }
  const metadata = eventStore.getSession(session.sessionId);
  let admission: CloseoutAdmission;
  try {
    admission = admitCloseout({
      store: eventStore,
      request: {
        sessionId: session.sessionId,
        episode,
        prompt,
        promptRevision: episode.source === 'automatic' ? 'automatic-v1' : 'user-v1',
        task:
          episode.source === 'automatic'
            ? 'commit-push-memory-summarize'
            : 'commit-memory-summarize',
        model: metadata?.selectedModel ?? session.model ?? metadata?.accountBinding?.model,
        reasoningEffort: metadata?.reasoningEffort,
        accountBinding: metadata?.accountBinding ?? session.accountBinding,
      },
      prepare: (messageId) => {
        if (codex) codex.enqueue({ id: messageId, prompt, intent: prompt });
        else if (responses) responses.prepare(messageId, prompt);
      },
    });
  } catch (error) {
    log.warn('failed to admit closeout prompt', { clientId, error });
    return;
  }
  if (admission.duplicate) return;
  storeAndEchoIfNew(
    session.sessionId,
    admission.messageId,
    prompt,
    clientId,
    session.transport,
    session.observers,
    undefined,
    undefined,
    undefined,
    'closeout',
  );
  if (codex) {
    trackCodexProviderAdmission(session, admission.messageId, admission, eventStore);
    void codex
      .startQueued()
      .catch((error) => log.warn('failed to start Codex closeout prompt', { clientId, error }));
  } else if (responses) {
    trackResponsesProviderAdmission(session, admission, eventStore);
    session.inputQueue?.push(makeUserMessage(prompt, 'now', admission.messageId, admission));
  } else {
    const attempt = eventStore.beginProviderAttempt(admission.token, admission.providerAttemptId);
    if (attempt.duplicate) return;
    const inputUuid = randomUUID();
    fallbackCloseoutAttempts.set(session, {
      admission,
      attempt: attempt.token,
      inputUuid,
      inputObserved: false,
    });
    session.abortController.signal.addEventListener(
      'abort',
      () => markFallbackCloseoutAmbiguous(session),
      { once: true },
    );
    session.inputQueue?.push(
      makeUserMessage(prompt, 'now', admission.messageId, undefined, inputUuid),
    );
  }
}

const CLOSEOUT_PROMPT = `This session is closing in 10 minutes due to inactivity.
Please perform session closeout:

1. If there is uncommitted work in any worktree, commit it now with a descriptive message
2. If a reviewed GitHub publish capability is available, invoke it after committing to publish the branch and create or update a pull request. Do not run direct \`git push\` or \`gh pr create\`: the capability displays the required approval and enforces repository and branch scope. If it is unavailable, leave the local commit in place and report that publishing requires the reviewed capability.
3. If there are memory-worthy observations, decisions, or patterns — write them to memory/Observations/ or memory/Decisions/
4. Write a 2-3 sentence summary of what was accomplished and what remains unfinished — output it as your final chat message so it appears in the conversation history
5. Do not ask for confirmation — just do it`;

/**
 * Graceful session closeout. Called by the registry's closeout handler
 * when the detach TTL is about to expire. Injects a closeout prompt into
 * the agent's input queue so it can commit work and write memory while it
 * still has full conversation context.
 */
export function closeoutSession(clientId: string, episode: CloseoutEpisode): void {
  withSpan('session.closeout', { 'session.clientId': clientId }, () =>
    _closeoutSessionInner(clientId, episode),
  );
}

function _closeoutSessionInner(clientId: string, episode: CloseoutEpisode): void {
  const session = registry.get(clientId);
  if (!session?.inputQueue) {
    // No active session or input queue — just finalize as abandoned
    if (session?.sessionId) clearSessionImages(session.sessionId);
    if (session?.wtId) {
      try {
        finalizeCloseout(BASE_REPO, session.wtId, {
          status: 'abandoned',
          closed_by: 'abandoned',
          tokens_used: session.cumulativeSessionTokens,
          cost_usd: session.cumulativeCostUsd,
        });
      } catch {
        // best-effort
      }
    }
    return;
  }

  if (session.sessionId) {
    eventStore.setSessionState(session.sessionId, 'CLOSING', {
      clientId,
      reason: 'detach_ttl_closeout',
    });
  }

  log.info('injecting closeout prompt', { clientId, wtId: session.wtId });

  queueCloseoutPrompt(session, clientId, CLOSEOUT_PROMPT, episode);

  // The registry's CLOSEOUT_TIMEOUT_MS timer will abort the session after
  // 10 minutes regardless. When the session is finally aborted (by the
  // registry or by natural completion), the index gets finalized.
  //
  // We register a one-time listener on the abort signal to finalize.
  if (session.wtId) {
    const wtId = session.wtId;
    const onAbort = () => {
      if (session.sessionId) clearSessionImages(session.sessionId);
      const status = registry.isClosingOut(clientId) ? 'abandoned' : 'closed';
      const closedBy = registry.isUserClose(clientId)
        ? 'user'
        : status === 'abandoned'
          ? 'abandoned'
          : 'auto';
      try {
        finalizeCloseout(BASE_REPO, wtId, {
          status,
          closed_by: closedBy,
          tokens_used: session.cumulativeSessionTokens,
          cost_usd: session.cumulativeCostUsd,
        });
      } catch {
        // best-effort
      }
    };
    session.abortController.signal.addEventListener('abort', onAbort, { once: true });
  }
}

// Wire closeout handler on the registry
registry.setCloseoutHandler(closeoutSession);

const USER_CLOSEOUT_PROMPT = `The user has closed this session.
Please perform session closeout:

1. If there is uncommitted work in any worktree, commit it now with a descriptive message
2. If there are memory-worthy observations, decisions, or patterns — write them to memory/Observations/ or memory/Decisions/
3. Write a 2-3 sentence summary of what was accomplished and what remains unfinished — output it as your final chat message so it appears in the conversation history
4. Do not ask for confirmation — just do it`;

/**
 * User-initiated session close. Triggers the same closeout flow as
 * auto-close but with a shorter timeout (2 minutes) and marks the
 * session as closed by the user.
 */
export function closeSessionByUser(clientId: string): void {
  withSpan('session.close_by_user', { 'session.clientId': clientId }, () => {
    const session = registry.get(clientId);
    if (!session) return;

    if (session.sessionId)
      assertOrdinaryContributorControlAllowed(eventStore, session.sessionId, 'close');

    // Mark as user-initiated close in the registry
    const episode = registry.markUserClose(clientId);

    if (!session.inputQueue) {
      // No active agent — finalize immediately
      if (session.sessionId) clearSessionImages(session.sessionId);
      if (session.wtId) {
        try {
          finalizeCloseout(BASE_REPO, session.wtId, {
            status: 'closed',
            closed_by: 'user',
            tokens_used: session.cumulativeSessionTokens,
            cost_usd: session.cumulativeCostUsd,
          });
        } catch {
          // best-effort
        }
      }
      if (session.sessionId) {
        eventStore.upsertSession({
          sessionId: session.sessionId,
          isActive: false,
          closedBy: 'user',
        });
      }
      registry.remove(clientId);
      return;
    }

    log.info('user-initiated closeout', { clientId, wtId: session.wtId });

    if (episode.source === 'user')
      queueCloseoutPrompt(session, clientId, USER_CLOSEOUT_PROMPT, episode);
    else
      log.info('user close overlaps active automatic closeout; preserving admitted prompt', {
        clientId,
        episodeId: episode.id,
      });

    // Register abort listener to finalize with closed_by: 'user'
    if (session.wtId) {
      const wtId = session.wtId;
      const onAbort = () => {
        if (session.sessionId) clearSessionImages(session.sessionId);
        try {
          finalizeCloseout(BASE_REPO, wtId, {
            status: 'closed',
            closed_by: 'user',
            tokens_used: session.cumulativeSessionTokens,
            cost_usd: session.cumulativeCostUsd,
          });
        } catch {
          // best-effort
        }
      };
      session.abortController.signal.addEventListener('abort', onAbort, { once: true });
    }

    // Mark inactive in event store
    if (session.sessionId) {
      eventStore.upsertSession({ sessionId: session.sessionId, closedBy: 'user' });
    }

    // Set a shorter timeout — 2 minutes instead of 10
    setTimeout(() => {
      if (registry.isActive(clientId) && registry.isUserClose(clientId)) {
        log.info('user closeout timeout, aborting', { clientId });
        registry.abort(clientId);
      }
    }, USER_CLOSEOUT_TIMEOUT_MS);
  });
}

/** Public ordinary control; contributor drivers retain stopChat after exact terminal proof. */
export function stopOrdinaryChat(clientId: string): void {
  const session = registry.get(clientId);
  if (session?.sessionId)
    assertOrdinaryContributorControlAllowed(eventStore, session.sessionId, 'stop');
  stopChat(clientId);
}
export function stopChat(clientId: string) {
  withSpan('session.stop', { 'session.clientId': clientId }, () => {
    const session = registry.get(clientId);
    if (session) {
      cleanupSessionWorktrees(session);
      if (session.sessionId) clearSessionImages(session.sessionId);
      session.inputQueue?.close();
      session.queryInstance?.close();
    }
    registry.abort(clientId);
  });
}
export function detachChat(clientId: string) {
  withSpan('session.detach', { 'session.clientId': clientId }, () => {
    const session = registry.get(clientId);
    registry.detach(clientId);
    if (session?.sessionId) {
      eventStore.setSessionState(session.sessionId, 'DETACHED', {
        clientId,
        reason: 'transport_close',
      });
    }
  });
}
/** Attachment teardown never changes the retained execution or login owner. */
export function detachChatIfCurrentTransport(
  clientId: string,
  transport: SessionTransport,
): boolean {
  const session = registry.get(clientId);
  if (
    !session ||
    getTransportAttachmentIdentity(session.transport) !==
      getTransportAttachmentIdentity(transport) ||
    registry.isSuspended(clientId) ||
    !registry.isAttached(clientId)
  )
    return false;
  detachChat(clientId);
  _onSessionChange?.(clientId, 'detach', session.sessionId);
  return true;
}
export function reattachChat(clientId: string, transport: SessionTransport): boolean {
  return withSpan('session.reattach', { 'session.clientId': clientId }, () => {
    const session = registry.get(clientId);
    const ok = registry.reattach(clientId, transport);
    if (ok && session?.sessionId) {
      eventStore.setSessionState(session.sessionId, 'ACTIVE', {
        clientId,
        reason: 'reattach',
      });
    }
    return ok;
  });
}
export function rekeyChat(oldClientId: string, newClientId: string): boolean {
  return withSpan(
    'session.rekey',
    { 'session.oldClientId': oldClientId, 'session.newClientId': newClientId },
    () => {
      return registry.rekey(oldClientId, newClientId);
    },
  );
}
export function isActive(clientId: string): boolean {
  return registry.isActive(clientId);
}

// --- Session listing ---

/**
 * Collect directories to scan for Claude Code sessions.
 *
 * The SDK's listSessions({ dir, includeWorktrees: true }) discovers sessions
 * within a single repo and its git worktrees, but it cannot cross repo
 * boundaries. Since worktree sessions span multiple repos, we must call
 * listSessions once per repo. We discover repos two ways:
 *
 * 1. Explicit repos from .mitzo.json `repos` config.
 * 2. Sibling discovery: derive unique parent dirs from .mitzo.json `roots`,
 *    then scan each parent for child directories that have .git/ or .claude/.
 *
 * This keeps all paths configurable (no hardcoded machine-specific paths).
 */
export function getSessionDirs(options?: { claudeProjectsRoot?: string }): string[] {
  const dirs = [BASE_REPO];
  const seen = new Set([BASE_REPO]);

  try {
    const config = getRepoConfig();

    // 1. Add all explicitly configured repos
    for (const repoPath of Object.values(config.repos)) {
      if (!seen.has(repoPath)) {
        dirs.push(repoPath);
        seen.add(repoPath);
      }
    }

    // 2. Derive unique parent dirs from roots, then scan for sibling projects.
    const parentDirs = new Set<string>();
    for (const root of config.roots) {
      parentDirs.add(dirname(resolve(root.path)));
    }

    for (const parent of parentDirs) {
      try {
        for (const entry of readdirSync(parent, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const child = join(parent, entry.name);
          if (seen.has(child)) continue;
          if (existsSync(join(child, '.git')) || existsSync(join(child, '.claude'))) {
            dirs.push(child);
            seen.add(child);
          }
        }
      } catch {
        // Expected when parent dir doesn't exist
      }
    }
  } catch {
    // Expected when config hasn't loaded yet
  }

  // Legacy location: <repo>-sessions/ sibling directory
  const sessionsDir = `${BASE_REPO}-sessions`;
  try {
    const entries = readdirSync(sessionsDir);
    for (const e of entries) {
      if (e.startsWith('session-')) dirs.push(join(sessionsDir, e));
    }
  } catch {
    // Expected when sessions dir doesn't exist yet
  }

  // Discover worktree sessions from ~/.claude/projects/.
  // When a session runs in a worktree CWD, the SDK stores its data under
  // a project dir derived from that path. Once the worktree is cleaned up,
  // listSessions({ dir: BASE_REPO }) can no longer find those sessions.
  // We scan for project dirs matching <encoded-BASE_REPO>--claude-worktrees-<id>
  // and reconstruct the original worktree path.
  const encodedBase = BASE_REPO.replace(/\//g, '-');
  const wtPrefix = `${encodedBase}--claude-worktrees-`;
  try {
    const claudeProjects = options?.claudeProjectsRoot ?? join(homedir(), '.claude', 'projects');
    for (const entry of readdirSync(claudeProjects)) {
      if (!entry.startsWith(wtPrefix)) continue;
      const wtId = entry.slice(wtPrefix.length);
      if (!wtId) continue;
      const originalPath = `${BASE_REPO}/.claude/worktrees/${wtId}`;
      if (!seen.has(originalPath)) {
        dirs.push(originalPath);
        seen.add(originalPath);
      }
    }
  } catch {
    // Expected when ~/.claude/projects doesn't exist
  }

  return dirs;
}

export function hideSession(sessionId: string) {
  eventStore.hideSession(sessionId);
}
export function hideAllSessions() {
  for (const meta of eventStore.listSessions()) {
    eventStore.hideSession(meta.sessionId);
  }
}

export async function renameSessionById(
  sessionId: string,
  title: string,
  manual = true,
): Promise<void> {
  const session = eventStore.getSession(sessionId);
  if (!isRegisteredConversation(session))
    throw new Error('Only registered conversations can be renamed; import external history first');
  const provider = session.accountBinding?.provider;
  if (provider === 'openai' || provider === 'openai-codex' || provider === 'google-vertex') {
    if (manual) eventStore.markManuallyRenamed(sessionId);
    eventStore.upsertSession({ sessionId, summary: title });
    return;
  }
  const errors: string[] = [];
  for (const dir of getSessionDirs()) {
    try {
      await renameSession(sessionId, title, { dir });
      if (manual) {
        eventStore.markManuallyRenamed(sessionId);
      }
      // Also update the summary in the event store
      eventStore.upsertSession({ sessionId, summary: title });
      return;
    } catch (err: unknown) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new Error('Session not found');
}

/** SDK indexes can advertise an ai-title-only file as a session. */
async function hasSdkConversation(
  info: import('@anthropic-ai/claude-agent-sdk').SDKSessionInfo,
  dir?: string,
): Promise<boolean> {
  try {
    // Image-only or assistant-only histories may have no firstPrompt.
    return (
      (await getSessionMessages(info.sessionId, { ...(dir ? { dir } : {}), limit: 1 })).length > 0
    );
  } catch {
    return false;
  }
}

/** Refresh registered conversations; filesystem discovery cannot create chats. */
export async function getSessions(offset = 0, limit = SESSION_PAGE_SIZE) {
  await syncSessionTimestamps();
  return getSessionsCached(offset, limit);
}

/** Unregistered SDK histories are candidates for deliberate import, never chats. */
export async function listImportableSdkConversations() {
  const candidateLimit = 100;
  const seen = new Map<
    string,
    { id: string; summary: string; lastModified: number; cwd?: string }
  >();
  for (const dir of getSessionDirs().filter(Boolean)) {
    try {
      const projectCandidates = new Set<string>();
      // Excluded SDK records cannot consume the candidate budget. Each project
      // contributes its newest eligible window before the global sort and cap.
      for (let offset = 0; projectCandidates.size < candidateLimit; offset += candidateLimit) {
        const page = await listSessions({
          dir,
          limit: candidateLimit,
          offset,
          includeWorktrees: true,
        });
        for (const info of page) {
          if (
            eventStore.getInternalSdkExecution(info.sessionId) ||
            eventStore.isSessionHidden(info.sessionId) ||
            isRegisteredConversation(eventStore.getSession(info.sessionId)) ||
            !(await hasSdkConversation(info, dir))
          )
            continue;
          projectCandidates.add(info.sessionId);
          const previous = seen.get(info.sessionId);
          if (!previous || info.lastModified > previous.lastModified)
            seen.set(info.sessionId, {
              id: info.sessionId,
              summary: info.summary,
              lastModified: info.lastModified,
              cwd: info.cwd,
            });
          if (projectCandidates.size === candidateLimit) break;
        }
        if (page.length < candidateLimit) break;
      }
    } catch {
      /* A configured project may have no SDK history. */
    }
  }
  return [...seen.values()]
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, candidateLimit);
}

/**
 * Fast session listing from EventStore (SQLite) — no filesystem scan.
 * Returns the same shape as getSessions() for API compatibility.
 */
export function getSessionsCached(offset = 0, limit = SESSION_PAGE_SIZE) {
  const now = Date.now();
  const all = eventStore.listSessions().filter((m) => {
    if (m.isHidden || !isRegisteredConversation(m)) return false;
    if (m.conversationSource === 'external_import') return true;
    if (m.symposiumConfig) return true;
    // Hide sessions that were never used through Mitzo (e.g. automated
    // code review sessions discovered from filesystem).  Active sessions
    // always show regardless of turn count. Controller-created conversations
    // get the startup grace period; provider files cannot grant ownership.
    if (m.numTurns === 0 && m.promptCount === 0 && !m.isActive) {
      return (
        Boolean(m.initialPrompt || m.accountBinding || m.conversationSource === 'mitzo') &&
        now - m.createdAt < ZERO_TURN_GRACE_MS
      );
    }
    return true;
  });
  all.sort((a, b) => b.updatedAt - a.updatedAt);
  const page = all.slice(offset, offset + limit);
  const hasMore = all.length > offset + limit;
  return {
    sessions: page.map((m) => ({
      id: m.sessionId,
      summary:
        m.summary ||
        (m.manuallyRenamed
          ? ''
          : generateSessionNameFallback([
              m.initialPrompt ||
                String(eventStore.getLatestEvent(m.sessionId, 'user_message')?.payload.text ?? ''),
            ])),
      lastModified: m.updatedAt,
      branch: m.branch ?? undefined,
      cwd: m.cwd ?? undefined,
    })),
    hasMore,
  };
}

/**
 * Background recovery updates only conversations already admitted by the controller.
 * Unknown provider files remain separate import candidates.
 * Call fire-and-forget after serving cached results.
 */
// Guard against concurrent reconciliation runs. While `_reconciling` is true,
// subsequent page-1 loads that call reconcileSessionsBackground() are no-ops.
// This is safe because the in-flight sync will pick up any changes, and the
// next page-1 request after it completes will trigger a fresh reconciliation.
let _reconciling = false;
export function reconcileSessionsBackground(): void {
  if (_reconciling) return;
  _reconciling = true;
  syncSessionTimestamps()
    .catch(() => {})
    .finally(() => {
      _reconciling = false;
    });
}

/**
 * Full timestamp sync: scan filesystem and update EventStore timestamps
 * for all sessions to match their actual lastModified time.
 */
export async function syncSessionTimestamps(): Promise<void> {
  const seen = new Map<
    string,
    { lastModified: number; summary: string; branch?: string; cwd?: string }
  >();
  const fetchLimit = 250;
  for (const dir of getSessionDirs()) {
    try {
      const sessions = await listSessions({ dir, limit: fetchLimit, includeWorktrees: true });
      for (const s of sessions) {
        const registered = eventStore.getSession(s.sessionId);
        if (!isRegisteredConversation(registered) || registered.isHidden) continue;
        if (!registered.sdkTranscriptVerified && !(await hasSdkConversation(s, dir))) continue;
        const existing = seen.get(s.sessionId);
        if (!existing || s.lastModified > existing.lastModified) {
          seen.set(s.sessionId, {
            lastModified: s.lastModified,
            summary: s.summary,
            branch: s.gitBranch,
            cwd: s.cwd || undefined,
          });
        }
      }
    } catch {
      // Expected when session dir doesn't exist
    }
  }

  let synced = 0;
  for (const [sessionId, entry] of seen) {
    const existing = eventStore.getSession(sessionId);
    if (
      custodianControllerMode &&
      (existing?.sessionType === 'symposium' || existing?.symposiumConfig != null)
    )
      continue;
    if (!isRegisteredConversation(existing)) continue;
    if (Math.abs(existing.updatedAt - entry.lastModified) > 60_000) {
      // Timestamp drifted from filesystem — sync it back.
      // Preserves summary from EventStore if it was manually renamed.
      eventStore.upsertSession({
        sessionId,
        sdkTranscriptVerified: true,
        updatedAt: entry.lastModified,
        summary: existing.manuallyRenamed ? undefined : entry.summary || undefined,
        branch: entry.branch ?? undefined,
      });
      synced++;
    } else if (!existing.sdkTranscriptVerified) {
      eventStore.upsertSession({
        sessionId,
        sdkTranscriptVerified: true,
        updatedAt: existing.updatedAt,
      });
    }
  }
  if (synced > 0) {
    log.info('reconciled session timestamps', { synced, total: seen.size });
  }
}

/** Explicit import invoked by the user, scoped to configured project histories. */
export async function importSdkConversation(
  sessionId: string,
): Promise<import('./event-store.js').SessionMeta | null> {
  if (eventStore.getInternalSdkExecution(sessionId) || eventStore.isSessionHidden(sessionId))
    return null;
  const registered = eventStore.getSession(sessionId);
  if (isRegisteredConversation(registered)) return registered;
  for (const dir of getSessionDirs().filter(Boolean)) {
    try {
      const info = await getSessionInfo(sessionId, { dir });
      if (!info || info.sessionId !== sessionId || !(await hasSdkConversation(info, dir))) continue;
      // Provider reads yield; controller ownership may have changed while loading history.
      if (eventStore.getInternalSdkExecution(sessionId) || eventStore.isSessionHidden(sessionId))
        return null;
      const existing = eventStore.getSession(sessionId);
      if (isRegisteredConversation(existing)) return existing;
      eventStore.upsertSession({
        sessionId,
        conversationSource: 'external_import',
        summary: info.summary || null,
        sdkTranscriptVerified: true,
        cwd: info.cwd ?? dir,
        branch: info.gitBranch ?? null,
        isActive: false,
        createdAt: info.createdAt ?? info.lastModified,
        updatedAt: info.lastModified,
      });
      return eventStore.getSession(sessionId);
    } catch {
      /* A session may be in another configured project. */
    }
  }
  return null;
}

/** Recover legacy workspace metadata without changing session identity or permissions. */
async function recoverSessionWorkspace(sessionId: string, dirs?: string[]) {
  const session = eventStore.getSession(sessionId);
  if (session?.cwd) return;
  // Only Claude SDK history can supply legacy workspace metadata. In
  // particular, a native provider's missing cwd must not scan Claude files.
  const provider = session?.accountBinding?.provider;
  if (provider && provider !== 'anthropic-vertex') return;
  // Discover directories only after the cheap metadata checks above.
  for (const dir of dirs ?? getSessionDirs()) {
    try {
      const info = await getSessionInfo(sessionId, { dir });
      if (typeof info?.cwd !== 'string' || !isAbsolute(info.cwd)) continue;
      // Preserve a workspace recorded while the SDK lookup was in flight.
      const current = eventStore.getSession(sessionId);
      if (!current?.cwd)
        eventStore.upsertSession({
          sessionId,
          cwd: info.cwd,
          ...(current?.updatedAt !== undefined ? { updatedAt: current.updatedAt } : {}),
        });
      return;
    } catch {
      // Missing metadata must not prevent reading the saved transcript.
    }
  }
}

function sessionReplayProjection(
  sessionId: string,
  events: import('./event-store.js').StoredEvent[],
) {
  const session = eventStore.getSession(sessionId);
  if (session?.accountBinding?.provider !== 'anthropic-vertex')
    return { events, initialPrompt: session?.initialPrompt ?? undefined };
  const custody = eventStore.getOrdinaryLocalVertexCustody(sessionId);
  const command = custody ? eventStore.getSendCommand(custody.initialCommandId) : undefined;
  return restoreOwnedVertexInitialPrompt(
    events,
    session?.initialPrompt ?? undefined,
    custody && command?.sessionId === sessionId && typeof command.payload.text === 'string'
      ? { sessionId, commandId: custody.initialCommandId, text: command.payload.text }
      : undefined,
  );
}

export async function getMessages(sessionId: string, throughSeq?: number) {
  if (!eventStore.getSession(sessionId)) return [];
  // Primary: replay from durable event store
  const events =
    throughSeq === undefined
      ? eventStore.getSessionEvents(sessionId)
      : eventStore.getSessionEventsThroughCursor(sessionId, throughSeq);
  if (events.length > 0) {
    if (throughSeq === undefined) await recoverSessionWorkspace(sessionId);
    const projection = sessionReplayProjection(sessionId, events);
    return replayEventsToMessages(projection.events, projection.initialPrompt);
  }

  // A bounded request must never fall through to a mutable SDK transcript.
  if (throughSeq !== undefined) return [];

  // Fallback: SDK JSONL for pre-migration sessions
  let rawMessages: RawSdkMessage[] = [];
  for (const dir of [
    ...new Set(
      [eventStore.getSession(sessionId)?.cwd, ...getSessionDirs()].filter((dir): dir is string =>
        Boolean(dir),
      ),
    ),
  ]) {
    try {
      rawMessages = (await getSessionMessages(sessionId, {
        dir,
        limit: SESSION_MESSAGES_LIMIT,
      })) as RawSdkMessage[];
      if (rawMessages.length > 0) {
        await recoverSessionWorkspace(sessionId, [dir]);
        break;
      }
    } catch {
      // Session not in this dir — try next
    }
  }
  try {
    return reconstructMessages(rawMessages);
  } catch (err: unknown) {
    log.warn('failed to parse session messages', {
      sessionId,
      error: err instanceof Error ? err.message : 'unknown',
    });
    return [];
  }
}

/** REST restore at the immutable reconnect boundary; never falls back to SDK history. */
export function getReconnectTranscript(sessionId: string, throughSeq: number) {
  if (!eventStore.getSession(sessionId)) return { messages: [], current: null, currents: [] };
  const events = eventStore.getSessionEventsThroughCursor(sessionId, throughSeq);
  const projection = sessionReplayProjection(sessionId, events);
  return replayEventsToTranscript(projection.events, projection.initialPrompt);
}

/** Full durable transcript and its high-water mark for opening an active session. */
export async function getSessionTranscript(sessionId: string) {
  if (!eventStore.getSession(sessionId))
    return { messages: [], current: null, currents: [], cursor: 0 };
  const events = eventStore.getSessionEvents(sessionId);
  if (events.length === 0)
    return { messages: await getMessages(sessionId), current: null, currents: [], cursor: 0 };
  await recoverSessionWorkspace(sessionId);
  const projection = sessionReplayProjection(sessionId, events);
  return {
    ...replayEventsToTranscript(projection.events, projection.initialPrompt),
    cursor: events[events.length - 1].seq,
  };
}

/** Explicit API continuation uses the retained ordinary session owner. */
export function canResumeOwnedLocalResponsesDriver(
  sessionId: string,
  authSessionId: string,
): boolean {
  try {
    if (!hasPersistentRevocationAuthority()) return false;
    const meta = eventStore.getSession(sessionId),
      runtime = eventStore.getSessionRuntimeBinding(sessionId);
    if (
      !meta?.accountBinding ||
      !runtime ||
      runtime.harness.implementation !== 'gemini' ||
      (runtime.harness.implementation === 'gemini'
        ? process.env.MITZO_ORDINARY_LOCAL_GEMINI_ENABLED
        : process.env.MITZO_ORDINARY_LOCAL_RESPONSES_ENABLED) !== '1' ||
      runtime.execution.location !== 'local' ||
      (meta.executionPhase && meta.executionPhase !== 'TERMINAL') ||
      eventStore.hasUncertainOrdinaryCommand(sessionId)
    )
      return false;
    const native = getNativeResponsesStore(),
      custody = native.readOrdinaryCustody(sessionId, meta.accountBinding);
    OrdinaryLocalResponsesOwnedRuntime.assertRetainedCredential(meta.accountBinding, custody);
    if (
      meta.accountBinding.provider !==
      (runtime.harness.implementation === 'gemini' ? 'google-vertex' : 'openai')
    )
      return false;
    if (runtime.harness.implementation === 'gemini') {
      const frozen = native.frozenSettings(sessionId, meta.accountBinding);
      if (
        !frozen ||
        !isDeepStrictEqual(frozen.selection, custody?.nativeSelection) ||
        frozen.checkpointModel !== custody?.nativeSelection?.model
      )
        return false;
    }

    return (
      !!custody &&
      custody.authSessionId === authSessionId &&
      isDeepStrictEqual(custody.binding, runtime) &&
      custody.workspace.cwd === meta.cwd &&
      custody.workspace.workspaceId === meta.repositoryWorkspaceId &&
      native.status(sessionId, meta.accountBinding) !== 'running' &&
      (() => {
        const active = native.queue(sessionId, meta.accountBinding!).active;
        if (!active) return true;
        const admission = eventStore.getExecutionAdmission(sessionId, active);
        return (
          !!admission &&
          meta.executionPhase === 'TERMINAL' &&
          meta.executionId === admission.token.executionId &&
          meta.executionGeneration === admission.token.generation &&
          !!eventStore.getExecutionTerminalReason(admission.token)
        );
      })()
    );
  } catch {
    return false;
  }
}
export async function continueOwnedLocalResponsesQueue(
  sessionId: string,
  authorization: import('./auth.js').AuthSession | undefined,
  connectionId?: string,
) {
  const owned = registry.findBySessionId(sessionId)?.session.ordinaryRuntimeOwner;
  if (!authorization || authorization.expiresAt <= Date.now())
    throw Error('Original Responses operator required');
  if (owned) {
    if (
      owned.authSessionId !== authorization.id ||
      !(owned.identity instanceof OrdinaryLocalResponsesOwnedRuntime)
    )
      throw Error('Original live Responses owner required');
    owned.identity.resumeQueue();
    return;
  }
  if (!connectionId || !canResumeOwnedLocalResponsesDriver(sessionId, authorization.id))
    throw Error('Original Responses custody required');
  const captured = captureAgentLibraryAuthorization(connectionId);
  captured.assertCurrent();
  const transport = _connRegistry?.get(connectionId)?.transport;
  if (
    captured.auth.id !== authorization.id ||
    liveTransportAuthSessionId(connectionId) !== authorization.id ||
    !transport?.isOpen()
  )
    throw Error('Original signed connection required');
  const meta = eventStore.getSession(sessionId)!;
  const head = getNativeResponsesStore().queue(sessionId, meta.accountBinding!).queued[0];
  if (!head || !meta.repositoryWorkspaceId || !BASE_REPO || !isAbsolute(BASE_REPO))
    throw Error('Saved Responses queue unavailable');
  const releaseStartup = reserveRepositoryStartup(sessionId);
  const preparation = new AbortController();
  const timer = setTimeout(() => preparation.abort(), 120000);
  try {
    await startOwnedLocalResponsesCommand(transport, `${connectionId}:${sessionId}`, {
      command: { clientMsgId: head },
      reservation: {
        id: meta.repositoryWorkspaceId,
        conversationId: sessionId,
        binding: meta.accountBinding!,
        taskRoot: join(BASE_REPO, '.claude', 'repository-tasks'),
      },
      operatorConnectionId: connectionId,
      ownerConnectionId: connectionId,
      ownerAuthSessionId: authorization.id,
      resume: true,
      signal: preparation.signal,
      resumeQueue: true,
    });
  } finally {
    try {
      if (!transport.isOpen()) {
        const current = registry.findBySessionId(sessionId);
        if (current) detachChatIfCurrentTransport(current.clientId, transport);
      }
    } catch {
      log.warn('Responses chat attachment cleanup remains unconfirmed', { sessionId });
    }
    clearTimeout(timer);
    preparation.abort();
    releaseStartup();
  }
}
export async function sendOwnedLocalResponsesCommand(input: {
  sessionId: string;
  command: unknown;
  operatorConnectionId: string;
  signal?: AbortSignal;
}) {
  const captured = captureAgentLibraryAuthorization(input.operatorConnectionId);
  captured.assertCurrent();
  const session = registry.findBySessionId(input.sessionId)?.session,
    owner = session?.ordinaryRuntimeOwner;
  if (
    !session ||
    !owner ||
    owner.authSessionId !== captured.auth.id ||
    session.accountBinding?.provider !== 'google-vertex' ||
    eventStore.getSessionRuntimeBinding(input.sessionId)?.harness.implementation !== 'gemini'
  )
    throw Error('Owned Local Responses unavailable');
  const result = await owner.admit(input.command, input.signal);
  return { ...result, sessionId: input.sessionId };
}
export async function startOwnedLocalResponsesCommand(
  transport: SessionTransport,
  clientId: string,
  options: {
    command: unknown;
    reservation: Omit<HostRepositoryReservationInput, 'signal'>;
    operatorConnectionId: string;
    ownerConnectionId?: string;
    ownerAuthSessionId: string;
    /** Preparation deadline only; detached after successful startup. */
    signal?: AbortSignal;
    resume?: boolean;
    resumeQueue?: boolean;
  },
) {
  options.signal?.throwIfAborted();
  if (options.reservation.binding.provider !== 'google-vertex')
    throw Error('Custom Responses execution is retired; review a linked native continuation');
  const sessionId = options.reservation.conversationId,
    command = options.command as { clientMsgId: string };
  const live = registry.findBySessionId(sessionId)?.session.ordinaryRuntimeOwner;
  if (live) {
    const captured = captureAgentLibraryAuthorization(options.operatorConnectionId);
    captured.assertCurrent();
    if (
      live.authSessionId !== captured.auth.id ||
      live.authSessionId !== options.ownerAuthSessionId ||
      live.initialCommandId !== command.clientMsgId ||
      options.resume ||
      !['responses', 'gemini'].includes(
        eventStore.getSessionRuntimeBinding(sessionId)?.harness.implementation ?? '',
      )
    )
      throw Error('Responses owner already exists');
    return { ...(await live.retryInitial(options.command)), sessionId };
  }
  const native = getNativeResponsesStore(),
    controller = new AbortController();
  let query: QueryInstance | undefined, session: ManagedSession | undefined;
  const input = new AsyncQueue<{
    message: { content: string };
    mitzoMessageId?: string;
    mitzoImages?: { data: string; mediaType: string }[];
    providerAdmission?: ProviderDispatchAdmission;
  }>();
  let running = false,
    closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    input.close();
    query?.close();
    controller.abort();
    owner.close();
    const current = registry.findBySessionId(sessionId);
    if (current && current.session === session) registry.abort(current.clientId);
    if (session)
      eventStore.setSessionState(sessionId, 'ENDED', {
        clientId,
        reason: 'owned_responses_closed',
      });
  };
  const prepare = async (selected: OrdinaryLocalResponsesOwnedDispatch) => {
    await selected.owner.assertSetup(selected.commandId);
    if (!session) {
      registry.register(clientId, {
        transport,
        abortController: controller,
        sessionId,
        cwd: selected.expected.workspace.cwd,
        mode: selected.expected.selection.permission.mode,
        model: selected.expected.selection.model,
        branch: selected.workspace.featureBranch,
        accountBinding: selected.binding,
        sessionAllowList: new Set(),
        ownerConnectionId: options.ownerConnectionId,
        ownedLocalAuthSessionId: owner.authSessionId,
      });
      session = registry.get(clientId)!;
      session.worktreePaths.set('primary', {
        path: selected.expected.workspace.cwd,
        wtId: selected.workspace.id,
      });
      session.inputQueue = {
        push: () => {
          throw Error('Runtime-bound commands require guarded admission');
        },
        close: () => {},
      };
      eventStore.setSessionState(sessionId, 'CREATED', { clientId });
      const env = nativeExecutionEnv();
      env.MITZO_SESSION_ID = sessionId;
      query = await openResponsesChat({
        agentProfile: selected.expected.agentProfile,
        commandAuthority: owner,
        assertStartupCurrent: () => owner.assertSetupSync(selected.commandId),
        store: native,
        resume: selected.resume,
        conversationId: sessionId,
        binding: selected.binding,
        ...(selected.binding.provider === 'google-vertex'
          ? { gemini: owner.geminiOptions() }
          : {
              getApiKey: (signal?: AbortSignal) => {
                signal?.throwIfAborted();
                const active = owner.activeCommandId();
                if (!active) throw Error('Responses command unavailable');
                return owner.resolveKey(active, signal);
              },
            }),
        selectedModel: selected.expected.selection.model,
        reasoningEffort: selected.expected.selection.thinking,
        session,
        registry,
        input,
        eventStore,
        systemPrompt: selected.payload.systemPrompt,
        env,
        configuredSourceEnv: nativeExecutionEnv(),
        mcpServers: loadMcpServers(),
        publishingGitStorageRoots: [BASE_REPO, ...Object.values(getRepoConfig().repos)]
          .filter(Boolean)
          .map((root) => join(root, '.git')),
      });
      owner.assertSetupSync(selected.commandId);
      session.queryInstance = query;
      session.ordinaryRuntimeOwner = {
        location: 'local',
        authSessionId: owner.authSessionId,
        identity: owner,
        initialCommandId: selected.commandId,
        admit: async (raw, preparationSignal) => {
          const result = await owner.admitContinuation(raw, preparationSignal);
          if (result.dispatched) {
            echo((raw as { clientMsgId: string }).clientMsgId);
            void pump();
          }
          return result;
        },
        retryInitial: (raw) => (selected.resume ? owner.admitResume(raw) : owner.admit(raw)),
        close,
      };
      send(transport, { type: 'session_id', sessionId, clientMsgId: selected.commandId });
      send(transport, {
        type: 'session_info',
        sessionId,
        cwd: selected.expected.workspace.cwd,
        branch: selected.workspace.featureBranch,
        worktree: false,
      });
      _onSessionChange?.(clientId, 'start');
    }
  };
  const owner = new OrdinaryLocalResponsesOwnedRuntime({
    enabled:
      (options.reservation.binding.provider === 'google-vertex'
        ? process.env.MITZO_ORDINARY_LOCAL_GEMINI_ENABLED
        : process.env.MITZO_ORDINARY_LOCAL_RESPONSES_ENABLED) === '1',
    eventStore,
    library: getAgentLibrary(),
    workspace: getRepositoryWorkspaces(true),
    reservation: options.reservation,
    nativeStore: native,
    commandId: command.clientMsgId,
    operatorConnectionId: options.operatorConnectionId,
    signal: controller.signal,
    dispatch: prepare,
    dispatchContinuation: prepare,
    onCommandTerminal: () => {
      void pump();
    },
  });
  let releaseStartup: () => void;
  try {
    releaseStartup = eventStore.reserveOrdinaryStartup([sessionId]);
  } catch (error) {
    owner.close();
    throw error;
  }
  owner.signal.addEventListener('abort', close, { once: true });
  if (owner.authSessionId !== options.ownerAuthSessionId) {
    owner.close();
    releaseStartup();
    throw Error('Responses operator changed');
  }
  const echo = (commandId: string) => {
    const selected = owner.snapshot(commandId);
    storeAndEchoIfNew(
      sessionId,
      commandId,
      selected.payload.text,
      clientId,
      session!.transport,
      session!.observers,
      imagePreviews(selected.payload.images),
      undefined,
      selected.payload.sourceSnapshots,
      'user',
      false,
    );
  };
  let scheduling = false;
  let pumpRequested = false;
  const pump = async () => {
    if (closed) return;
    if (scheduling) {
      pumpRequested = true;
      return;
    }
    scheduling = true;
    try {
      const commandId = await owner.claimNextCommand();
      if (!commandId || closed) return;
      const selected = owner.snapshot(commandId);
      const providerPrompt = assembleSourceSnapshots(
        selected.payload.text,
        selected.payload.sourceSnapshots,
      );
      const provider = admitProviderDispatch({
        store: eventStore,
        request: {
          sessionId,
          clientMsgId: commandId,
          effectivePrompt: providerPrompt,
          fingerprintSource: providerFingerprintSource(providerPrompt, selected.payload.images),
          model: selected.expected.selection.model,
          reasoningEffort: selected.expected.selection.thinking,
          accountBinding: options.reservation.binding,
        },
        prepare: () =>
          getResponsesRuntime(session!)!.prepare(
            commandId,
            responsesUserContent(providerPrompt, selected.payload.images),
            {
              model: selected.expected.selection.model,
              reasoningEffort: selected.expected.selection.thinking,
            },
          ),
      });
      if (provider.duplicate) throw Error('Responses provider command already attempted');
      trackResponsesProviderAdmission(session!, provider, eventStore);
      session!.model = selected.expected.selection.model;
      input.push({
        message: { content: providerPrompt },
        mitzoMessageId: commandId,
        mitzoImages: selected.payload.images,
        providerAdmission: provider,
      });
      if (!running) {
        running = true;
        void runQueryLoop(query!, clientId, registry, controller, eventStore, undefined, {
          connRegistry: _connRegistry ?? undefined,
          initialClientMsgId: commandId,
          onTurnEnd: (ownerClientId) => _onSessionChange?.(ownerClientId, 'turn_end'),
        })
          .catch(() => {})
          .finally(close);
      }
    } catch (error) {
      owner.interruptQueue();
      reportRetainedRuntimeFailure({ store: eventStore, sessionId, session, transport, error });
    } finally {
      scheduling = false;
      if (pumpRequested) {
        pumpRequested = false;
        void pump();
      }
    }
  };
  const onPreparationAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onPreparationAbort, { once: true });
  try {
    options.signal?.throwIfAborted();
    const result = options.resumeQueue
      ? await owner.reopenRetainedQueue()
      : options.resume
        ? await owner.admitResume(options.command)
        : await owner.admit(options.command);
    if (result.dispatched) {
      if (!options.resumeQueue) echo(command.clientMsgId);
      void pump();
    } else owner.close();
    return { ...result, sessionId };
  } catch (error) {
    close();
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', onPreparationAbort);
    releaseStartup();
  }
}
