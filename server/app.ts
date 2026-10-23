import { initializeTelosMainPublicationRuntime } from './telos-main-publication-runtime.js';
import { resolveTelosWorkCommandScope } from './telos-work-command-scope.js';
import { ordinaryWorkspacePreparedCommandStatus } from './ordinary-workspace-prepared-command.js';
import { requireSameOriginJson } from './connections-router.js';
import {
  ordinaryWorkspaceArtifactRoot,
  hasOrdinaryWorkspaceArtifactScope,
} from './ordinary-workspace-artifact-root.js';
import { hasPersistentRevocationAuthority, isAuthSessionCurrent } from './auth.js';
import { createOrdinaryWorkspacePreparationRouter } from './ordinary-workspace-router.js';
import { ordinaryWorkspaceTaskRoot } from './ordinary-workspace-runtime.js';
import {
  getOrdinaryWorkspaces,
  getLocalRepositoryWorkspaces,
} from './repository-workspace-runtime.js';
import { assertAgentToolRoute } from './agent-tool-selection.js';
import { OrdinaryWorkspaceSettingsSchema } from '@mitzo/protocol';
import { readSandboxOwnershipReview } from './sandbox-ownership-review.js';
import { createSessionRemovalRouter, sessionNeedsSandboxReview } from './session-removal.js';
import { summarizeSandboxInventory } from './sandbox-inventory.js';
import {
  readOpenShellSandboxInventory,
  previewLegacyOpenShellDeletion,
} from './openshell-lifecycle-controller.js';
import { getApiToolCatalog } from './api-tool-runtime.js';
import { getToolBuilderStore } from './tool-builder-runtime.js';
import { createTelosOutcomeHandler } from './telos-outcome-handler.js';
import { getConfiguredToolCatalog } from './configured-tool-runtime.js';
import { loadMcpServers } from './mcp-config.js';

import { createWarmPoolRouter, type SandboxConversation } from './openshell-warm-pool-router.js';
import { getOpenShellWarmPool } from './openshell-warm-pool-binding.js';
import { sessionListMetadata } from './session-list-metadata.js';
import { projectCompactions } from './compaction-history.js';
import {
  readOwnedVertexQueue,
  readOwnedVertexQueueOverview,
  cancelOwnedVertexQueuedCommand,
} from './ordinary-local-vertex-queue.js';
import { assertOwnedCodexQueueControl } from './owned-codex-queue-control.js';
import { getNativeResponsesStore } from './responses-chat-session.js';
import {
  continueOwnedLocalResponsesQueue,
  canResumeOwnedLocalResponsesDriver,
  nativeExecutionEnv,
} from './chat.js';
import {
  readOwnedNativeContinuationConstraint,
  readOwnedResponsesQueue,
  readOwnedResponsesQueueOverview,
  cancelOwnedResponsesQueuedCommand,
} from './ordinary-local-responses-queue.js';
import { ownedLocalCodexMetadata } from './ordinary-local-codex-metadata.js';
import { repositoryPreparedCommandStatus } from './repository-prepared-command.js';
import { ordinaryCodexContinuationStatus } from './ordinary-codex-continuation-status.js';
import { createTelemetryRelay } from './telemetry-relay.js';
import { traceAuthCheck } from './auth-check-tracing.js';
import type {
  SymposiumReviewPhysicalHost,
  SymposiumReviewRouteHost,
} from './symposium-review-host-contract.js';
import { withAgentLibraryRecoveryAuthorization } from './agent-library-transport.js';
import { terminalAccountRoute } from './terminal-account-route.js';
import { TerminalAdviser } from './terminal-adviser.js';
import { AgentLibraryAdviser } from './agent-library-adviser.js';
import { createTerminalAdviserSession } from './terminal-adviser-model.js';
import { TerminalService, TerminalStore } from './terminal-service.js';
import { terminalAdviserCatalog } from './terminal-adviser-catalog.js';
import { TmuxTerminalBackend } from './terminal-backend.js';
import { createTerminalTargetResolver } from './terminal-targets.js';
import { createTerminalRouter } from './terminal-router.js';
import { getTerminalPlanAdviserHost } from './terminal-plan-adviser.js';
import { createWorkspaceRuntimeCommandRunner } from './protected-sdk-command.js';
import {
  createSymposiumPersonalConnectionRouter,
  type SymposiumPersonalConnectionService,
} from './symposium-personal-connection-router.js';
import { createRepositoryWorkspaceRouter } from './repository-workspace-router.js';
import { canonicalRepositorySelection } from './github-repository-source.js';
import {
  closeIdleRepositoryWorkspaces,
  getRepositoryWorkspaces,
  repositoryWorkspaceBinding,
  repositoryWorkspaceCatalog,
} from './repository-workspace-runtime.js';
import { createSdkConversationImportRouter } from './sdk-conversation-import-routes.js';
import {
  CAPACITY_REATTACH_READY_TIMEOUT_MS,
  retryCapacityAfterReattachment,
  waitForReattachedCodexRuntime,
} from './codex-capacity-reattachment.js';
import type { AccountBinding } from '@mitzo/protocol';
import { SymposiumReviewActionAuthority } from './symposium-review-action-authority.js';
import { createSymposiumSuccessorFixAuthority } from './symposium-artifact-successor-authority.js';
import { createSymposiumReaderAuthorityBridge } from './symposium-reader-authority-bridge.js';
import { createSymposiumProductionReviewComposition } from './symposium-production-review-composition.js';
import type { InitialSourceExportReceipt } from './symposium-source-artifact-seal.js';
import type { ArtifactGenerationRequest } from './symposium-artifact-generations.js';
import type { SuccessorArtifactExportReceipt } from './symposium-physical-artifact-seal.js';
import {
  createSymposiumApplicationDispatchPolicy,
  selectSymposiumApplicationClaim,
} from './symposium-application-dispatch.js';
import { createGithubPublicationOperatorRouter } from './github-publication-operator-router.js';
import { createKnowledgeLibraryRouter } from './knowledge-library-router.js';
import { knowledgeLibraryFromEnvironment } from './knowledge-library-runtime.js';
import { installKnowledgeDraftRuntime } from './session-knowledge-tools.js';
import { createKnowledgeLibraryLoader } from './knowledge-library-loader.js';
import { requestOperatorGithubPublication } from './github-publishing-tool.js';
import { createCredentialConnectionsRouter } from './credential-connections-router.js';
import { bindConnectionSetupApplication } from './credential-setup-application.js';
import { getResponsesRuntime } from './responses-chat-session.js';
import {
  getCredentialConnectionsRuntime,
  keychainConnectionConfig,
  createCredentialConnectionsRuntime,
  setCredentialConnectionsRuntime as setActiveCredentialConnectionsRuntime,
} from './credential-connections-runtime.js';
import type { CredentialConnections } from './credential-connections.js';
import { createHostBackupService } from './backup/host.js';
import { createBackupRouter } from './backup/router.js';
import { bindMitzoTelosCoreCapture } from './backup/mitzo-telos-binding.js';
import { NotificationStore } from './notification-store.js';
import { NotificationCenter, setNotificationCenter } from './notification-center.js';
import { notificationRouter } from './notification-routes.js';
import { unifiedInboxRouter } from './unified-inbox-routes.js';
import { discardInboxSource } from './unified-inbox.js';
import {
  deliverNotification,
  sendBadgeUpdate,
  isConfigured as apnsConfigured,
  getTokens as pushTokens,
} from './apns.js';
import { OPEN_SHELL_ARTIFACT_HELPER } from './openshell-artifact-reader.js';
import { createTelosArtifactRouter, telosArtifactSaveJson } from './telos-artifact-routes.js';
import { createTelosItemRouter } from './telos-item-routes.js';
import { createTelosWorkRouter, type TelosWorkRoleRequest } from './telos-work-routes.js';
import { projectCanonicalTelosLifecycleList } from './telos-lifecycle-list.js';
import { TelosWorkLifecycleListSchema } from '@mitzo/protocol';
import { createTelosWorkRoleHost } from './telos-work-role-host.js';
import { createTelosWorkDelegationHost } from './telos-work-delegation-host.js';
import type { TelosWorkDelegationScope } from './telos-work-delegation.js';
import { resolveTelosWorkRoleContext } from './telos-work-role-context.js';
import { resolveTelosWorkRolePresentation } from './telos-work-role-presentation.js';
import { resolveTelosWorkTaskToolContext } from './telos-work-execution-authority.js';
import { TelosWorkError, TelosWorkStore } from './telos-work-store.js';
import { TelosWorkAdvisorDraft } from './telos-work-advisor-draft.js';
import { TelosArtifactStore } from './telos-artifact-store.js';
import { resolveOrdinaryCodexAgentProfile } from './ordinary-codex-agent-profile.js';
import { OrdinarySilentPreparationSelectionSchema } from './ordinary-repository-preparation.js';
import { assertOrdinarySilentPreparationAuthority } from './ordinary-repository-preparation-authority.js';
import { loadOrdinaryOpenShellCodexTarget } from './ordinary-openshell-codex-entry-owner.js';
import { isDeepStrictEqual } from 'node:util';
import { createTelosSourceRouter } from './telos-source-routes.js';
import { createCanonicalTelosOutcome } from './telos-outcome-owner.js';
import {
  isAvailableTelosWorkConversation,
  isAvailableTelosSourceConversation,
} from './telos-work-conversation.js';
import { writeHostArtifact } from './host-artifact-writer.js';
import { writeOpenShellArtifact } from './artifact-writer.js';
import { custodianPublicationApproval } from './symposium-custodian-authority.js';
import {
  custodianControllerClient,
  custodianOwnerMode,
  receiveCustodianEvents,
} from './symposium-custodian-mode.js';
import { createCustodianProxy } from './symposium-custodian-proxy.js';
import { drainRetainedSymposiumControllers } from './symposium-controller-drain.js';
import { createSessionMessagesHandler } from './session-messages-route.js';
import { mountSymposiumArtifactRoutes } from './symposium-artifact-route-composition.js';
import { getConnectionRegistry } from './chat.js';
import {
  publicationControllerApproval,
  clearPublicationControllerSessionGrants,
} from './symposium-publication-approval.js';
import {
  PublicationRegistration,
  publicationAuthorityPath,
  type PublicationCredentialRegistration,
} from './symposium-publication-registration.js';
import {
  completedPublicationArtifact,
  completedSealHash,
  publicationSealFenceForRecord,
  type CompletedPublicationHost,
} from './symposium-publication-artifact.js';
import { capabilityOperationStore } from './capability-operation-owner.js';
import {
  ownedEvidenceHandler,
  sessionOwnedEvidenceHandler,
  sessionEvidenceRequestAuthority,
} from './symposium-owned-evidence.js';

import type { SandboxCreationFence } from './symposium-workspace-lifecycle.js';
import type { ConnectionSelection } from './symposium-personal-connections.js';
import { SymposiumReviewStore } from './symposium-review-workflows.js';
import { SymposiumAccessRequests } from './symposium-access-tools.js';
import { createSymposiumAccessRouter } from './symposium-access-router.js';
import { createSymposiumSessionRouter } from './symposium-session-create.js';
import { createSubscriptionLoginController } from './symposium-subscription-login-route.js';
import { AccountAliases } from './account-aliases.js';
import { SymposiumConfigSchema } from '@mitzo/protocol';
import { SymposiumProfileStore } from './symposium-profiles.js';
import { authorizeSymposiumSeat } from './symposium-seat-authorization.js';
import { closeAgentLibrary, getAgentLibrary } from './agent-library-runtime.js';
import { closeAgentTasks, getAgentTasks } from './agent-task-runtime.js';
import { createAgentTaskRouter } from './agent-task-router.js';
import { createAgentLibraryRouter } from './agent-library-router.js';
import { createContextPackRouter } from './context-pack-router.js';
import {
  createAcceptedContextPacks,
  installContextPackRuntime,
  contextPackSourceRef,
} from './context-pack-runtime.js';
import { contextPackRouterDependencies } from './context-pack-composition.js';
import {
  SymposiumAgentContextStore,
  createSymposiumAgentContextBinding,
} from './symposium-agent-context.js';
import { SessionOutputReferences } from './session-output-references.js';
import { createSessionOutputRouter } from './session-output-routes.js';
import { createOutputContributors } from './output-contributors.js';
import { createOutputContributorRouter } from './output-contributor-routes.js';
import { createSessionCollaborationRouter } from './session-collaboration-router.js';
import { CollaborationApplicationReview } from './collaboration-application-review.js';
import { readAgentLibraryProfile } from './agent-library-transport.js';
import { createSymposiumProfileRouter } from './symposium-profile-routes.js';
import { SymposiumProfileProposalStore } from './symposium-profile-proposals.js';
import { createSymposiumProfileProposalRouter } from './symposium-profile-proposal-routes.js';
import {
  readCodexQueue,
  getCodexRuntime,
  getCodexConversationStore,
  waitForCodexRuntimeBySessionId,
  readCodexQueueOverview,
  cancelCodexQueuedCommand,
  stopCodexCapacityRecovery,
  readCodexCapacityRecovery,
} from './codex-chat-session.js';
import { createCodexQueueRouter } from './codex-queue-routes.js';
import { createCodexPathProtection } from './codex-private-path.js';
import { isWorkspaceRuntimeAuthorityWritePath } from './workspace-runtime-private-paths.js';
import { selectedOpenShellAccountRoute } from './codex-chat-session.js';
import { openShellRuntimeConfig, OpenShellRuntimeManager } from './openshell-runtime.js';
import { readOpenShellArtifact, OpenShellArtifactReadError } from './openshell-artifact-reader.js';
import {
  createSessionArtifactReader,
  SessionArtifactUnavailableError,
  validateSessionArtifactRuntime,
} from './session-artifact-reader.js';
import { loadAccountProfiles, type AccountProfiles } from './account-profiles.js';
import { SymposiumOrchestrator } from './symposium-orchestrator.js';
import {
  createOpenShellProviderIdentityResolver,
  createSymposiumSessionRuntime,
} from './symposium-session-runtime.js';
import { SymposiumNativeEventSink } from './symposium-native-event-sink.js';
import type { OpenShellRuntimeConfig } from './openshell-runtime.js';
import {
  readSymposiumProductionAttestation,
  verifySymposiumProductionGate,
  type SymposiumProductionPhysicalProof,
} from './symposium-production-gate.js';
import { SYMPOSIUM_CODEX_CONTROLLER_COMMAND } from './symposium-codex-native.js';
import {
  SYMPOSIUM_SUBSCRIPTION_CONTROLLER_COMMAND,
  type VerifySymposiumSubscriptionAuth,
} from './symposium-subscription-native.js';
import type { ArtifactLeaseRequest } from './symposium-artifact-lease.js';
import { mountSymposiumDirectorRoutes } from './symposium-director-route-composition.js';
import { SymposiumHostGrants } from './symposium-host-grants.js';
import express from 'express';
import { storedEventToClientMessage } from '@mitzo/protocol';
import cookieParser from 'cookie-parser';
import { createAppSecurityHeaders } from './security-headers.js';
import { createHtmlPreviewRouter } from './html-preview-shell.js';
import rateLimit from 'express-rate-limit';
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'fs';
import { join, dirname, resolve, extname, basename, relative, isAbsolute, sep } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash, randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { createVoiceProxy } from './voice-proxy.js';
import {
  login,
  authenticateToken,
  authMiddleware,
  operatorAuthMiddleware,
  registerAuthSession,
  revokeOperatorSessions,
  verifyLogoutToken,
  COOKIE_NAME,
  MAX_AGE_HOURS,
  type AuthSession,
} from './auth.js';
import {
  getSessions,
  listImportableSdkConversations,
  importSdkConversation,
  getSessionsCached,
  reconcileSessionsBackground,
  getMessages,
  getReconnectTranscript,
  getSessionTranscript,
  hideSession,
  hideAllSessions,
  renameSessionById,
  startChat,
  stopChat,
  sendToChat,
  AVAILABLE_MODELS,
  BASE_REPO,
  getMcpServerNames,
  getRepoConfig,
  isIsolationEnabled,
  eventStore,
  broadcastDurableSymposiumEvent,
  registry,
  generateWtId,
} from './chat.js';
import { NullTransport } from './null-transport.js';
import { getAccountUseStore } from './account-use-store.js';
import { getImage } from './image-store.js';
import {
  createWorktree,
  createSessionWorktrees as createAllWorktrees,
  listWorktrees,
} from './worktree.js';
import { createGitInfoDiscovery, createGitInfoHandler } from './git-discovery.js';
import { isValidInternalToken } from './internal-token.js';
import { createConnectionsRouter, recentAppReauthorizationHandlers } from './connections-router.js';
import { createConnectionsAccessRouter } from './connections-access-router.js';
import {
  personalInventorySource,
  symposiumAccountsInventorySource,
} from './connections-access-custodian.js';
import { createCapabilityOperationsRouter } from './connections/capabilities/router.js';
import { capabilityApprovalForConversation } from './connections/capabilities/approval.js';
import { getLiveCapabilityConversationBinding } from './capability-conversation-binding.js';
import {
  setConnectionsRuntime as setActiveConnectionsRuntime,
  getConnectionsRuntime,
  type ConnectionsRuntime,
} from './connections-runtime.js';
import { getLocalCommit, isUpdateAvailable } from './git-version.js';
import { requestPerformance } from './request-performance.js';
import { authenticationRoute } from './auth-route-boundary.js';
import {
  resolvePending,
  getPendingRequestsBySession,
  configureTelosSourcePermissionRecovery,
} from './permissions.js';
import { createTelosSourcePermissionRecovery } from './telos-source-recovery.js';
import { createSessionAccessRouter, projectSessionAccess } from './session-access.js';
import { createLogger } from './logger.js';
import {
  handleTaskSet,
  handleTaskComplete,
  handleTaskStatus,
  handleTaskBlock,
  handleTaskArtifact,
} from './task-tools.js';
import { setTaskStore } from './chat.js';
import {
  LoginBody,
  FileWriteBody,
  PermissionDecision,
  CalendarResponse,
  TodoListResponse,
  TodoCreateBody,
  TodoOutcomeCreateBody,
  TodoActionBody,
  TodoActionResponse,
  TaskCreateBody,
  TaskUpdateBody,
  LoopStartBody,
  WorkflowInstantiateBody,
  TemplateCreateBody,
  SignalBody,
  SignalResolveBody,
  WorkSignalBody,
  WorkSignalBatchBody,
  WorkloadItemUpdateBody,
  WorkloadPromoteBody,
  SessionCreateBody,
} from './api-schemas.js';
import type { TaskOrchestrator } from './task-orchestrator.js';
import type { SessionOverviewEmitter } from './session-overview.js';
import type { WorkflowTemplateStore, TemplateCreateInput } from './workflow-templates.js';
import { instantiateTemplate } from './workflow-templates.js';
import type { SignalProcessor } from './signal-processor.js';
import { listInboxItems, readInboxItem, approveInboxItem, createInboxItem } from './inbox.js';
import {
  getLatestMorningBriefing,
  readMorningBriefing,
  readMorningBriefingSnapshot,
} from './briefings.js';
import {
  createWorkspaceRuntimeClient,
  workspaceRuntimeConfigured,
} from './workspace-runtime-client.js';
import { createHomeRouter } from './home-router.js';
import { HomeStore } from './home-store.js';
import { readQuoteCatalog } from './quote-catalog.js';
import { registerToken, removeToken, setTokenStorePath } from './apns.js';
import { SkillRegistry } from './skills.js';
import type { SkillWatcher } from './skill-watcher.js';

import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { TaskStore, type TaskCreateInput, type TaskUpdateInput } from './task-store.js';
import { SseRegistry } from '@mitzo/harness';
import { SessionSseRegistry } from './session-sse-registry.js';
import { isTransportConnectionOwnedBy } from './transport-auth-ownership.js';
import { WorkloadStore, type WorkSignal, type TodoItemUpdateInput } from './workload-store.js';
import type { OpenShellLifecycleService } from './openshell-lifecycle-service.js';

const log = createLogger('server');

const __dirname = dirname(fileURLToPath(import.meta.url));

// Skill registry directories
export const BUNDLED_SKILLS_DIR = join(__dirname, '..', 'skills');
export const USER_SKILLS_DIR = join(homedir(), '.mitzo', 'skills');

/** Reserved native command names — skills with these names are ignored. */
export const NATIVE_COMMAND_NAMES = new Set(['skills', 'models', 'deliberate', 'fuse']);

/** Cached registries keyed by cwd — avoids re-scanning the filesystem on every request. */
const registryCache = new Map<string, SkillRegistry>();

let skillWatcher: SkillWatcher | null = null;

/** Register the skill file watcher so new repo dirs get watched automatically. */
export function setSkillWatcher(watcher: SkillWatcher): void {
  skillWatcher = watcher;
}

/** Build or retrieve a cached SkillRegistry for a given cwd (repo root). */
export function buildSkillRegistry(cwd?: string): SkillRegistry {
  const key = cwd ?? '';
  const cached = registryCache.get(key);
  if (cached) return cached;

  const repoDir = cwd ? join(cwd, '.mitzo', 'skills') : undefined;

  // Watch repo skill dir for changes (idempotent). If the directory doesn't
  // exist yet, watchDir silently skips it. A later invalidation (e.g. from a
  // change in bundled/user skill dirs) will rebuild the registry and retry.
  if (repoDir && skillWatcher) {
    skillWatcher.watchDir(repoDir);
  }

  const registry = new SkillRegistry({
    bundledDir: BUNDLED_SKILLS_DIR,
    userDir: USER_SKILLS_DIR,
    repoDir,
    nativeNames: NATIVE_COMMAND_NAMES,
  });
  registryCache.set(key, registry);
  return registry;
}

/** Invalidate all cached registries — forces rediscovery on next request. */
export function invalidateSkillRegistries(): void {
  for (const reg of registryCache.values()) reg.invalidate();
  registryCache.clear();
}

const app = express();
let idleApplicationClosing = false;
let idleApplicationClose: Promise<void> | undefined;
let activeApplicationRequests = 0;
app.use(requestPerformance((message, fields) => log.warn(message, fields)));

const codexReattachments = new Map<string, Promise<void>>();

app.use(createAppSecurityHeaders());
app.use((_req, res, next) => {
  if (idleApplicationClosing) {
    res.status(503).json({ error: 'Application resources are unavailable' });
    return;
  }
  activeApplicationRequests++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeApplicationRequests--;
  };
  res.once('finish', release);
  res.once('close', release);
  next();
});

// --- CORS for non-same-origin clients (Capacitor iOS, etc.) ---
// Mounted before yapper proxy so cross-origin voice requests get CORS headers.
// Auth preflight must be observed before CORS responds without reaching the route.
app.use(traceAuthCheck);
const CORS_ALLOWED_ORIGINS =
  process.env.CORS_ALLOWED_ORIGINS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean) ?? [];

if (CORS_ALLOWED_ORIGINS.length > 0) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && CORS_ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      res.vary('Origin');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-CSRF-Token, X-Connection-ID, traceparent',
      );
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      // Cache transport permission, not authentication or API responses.
      if (req.method === 'OPTIONS') res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
}

app.use(createHtmlPreviewRouter(CORS_ALLOWED_ORIGINS));

// --- Yapper proxy (mounted before body parsing and authMiddleware — no login required for voice) ---

const YAPPER_TARGET = process.env.YAPPER_PROXY_TARGET || 'http://localhost:8700';

export const yapperHttpProxy = createVoiceProxy(YAPPER_TARGET, '/api/yapper').http;
export const yapperWsProxy = createVoiceProxy(YAPPER_TARGET, '/api/yapper-ws');

app.use('/api/yapper', yapperHttpProxy);
app.use('/api/yapper-ws', yapperWsProxy.http);

app.use(cookieParser());

// This protected route is deliberately ahead of the global 10MB JSON parser.
// Its local parsers cap sensitive connection inputs at a few KiB. Runtime setup
// is injected from index after explicit feature configuration; importing app
// never creates a database or starts a gateway process.
let connectionsRouter: express.Router | null = null;
let capabilityOperationsRouter: express.Router | null = null;
export function setConnectionsRuntime(runtime: ConnectionsRuntime | null): void {
  setActiveConnectionsRuntime(runtime);
  connectionsRouter = runtime
    ? createConnectionsRouter({
        store: runtime.store,
        service: runtime.service,
        eligibleAccounts: runtime.eligibleAccountIds,
        gateway: runtime.gateway,
        workspace: runtime.workspace,
        legacyProviders: runtime.legacyProviders,
        capabilities: runtime.capabilities,
        googleWorkspace: runtime.googleWorkspace,
        openAIKeys: runtime.openAIKeys,
        openAIAccounts: runtime.openAIAccounts,
      })
    : null;
  capabilityOperationsRouter = runtime
    ? createCapabilityOperationsRouter({
        service: runtime.capabilities,
        resolveConversationBinding: (req, res, authSessionId, conversationId) => {
          const connectionId = req.header('x-connection-id');
          if (!connectionId || !isTransportConnectionOwnedBy(connectionId, authSessionId))
            return undefined;
          const found = registry.findBySessionId(conversationId);
          if (!found) return undefined;
          const ownerConnection =
            found.session?.ownerConnectionId ??
            (found.clientId.includes(':')
              ? found.clientId.slice(0, found.clientId.indexOf(':'))
              : found.clientId);
          if (ownerConnection !== connectionId) return undefined;
          const accountId = eventStore.getSession(conversationId)?.accountBinding?.accountId;
          const live = getLiveCapabilityConversationBinding(conversationId);
          if (!accountId || !live || live.accountId !== accountId) return undefined;
          return {
            accountId,
            connectionId: live.connectionId,
            connectionRevision: live.connectionRevision,
          };
        },
        resolveConversationReadBinding: (req, _res, authSessionId, conversationId) => {
          const connectionId = req.header('x-connection-id');
          if (!connectionId || !isTransportConnectionOwnedBy(connectionId, authSessionId))
            return undefined;
          const found = registry.findBySessionId(conversationId);
          if (!found) return undefined;
          const ownerConnection =
            found.session?.ownerConnectionId ??
            (found.clientId.includes(':')
              ? found.clientId.slice(0, found.clientId.indexOf(':'))
              : found.clientId);
          if (ownerConnection !== connectionId) return undefined;
          const accountId = eventStore.getSession(conversationId)?.accountBinding?.accountId;
          return accountId ? { accountId } : undefined;
        },
        sessionId: (_req, res) => (res.locals.authSession as AuthSession | undefined)?.id,
        approveForConversation: (conversationId) =>
          capabilityApprovalForConversation(registry, conversationId),
      })
    : null;
}
let credentialConnectionsRouter: express.Router | null = null;
let credentialSetupApplication: ReturnType<typeof bindConnectionSetupApplication> | undefined;
export function setCredentialConnectionsRuntime(service: CredentialConnections | null) {
  credentialSetupApplication?.dispose();
  setActiveCredentialConnectionsRuntime(service);
  credentialSetupApplication = service
    ? bindConnectionSetupApplication(service, {
        registry,
        send: (clientId, prompt, messageId) =>
          sendToChat(clientId, prompt, undefined, undefined, messageId),
        isBusy: (session) => {
          const codex = getCodexRuntime(session);
          return (
            !!session.currentSnapshot ||
            !!codex?.queue().some((command) => ['queued', 'running'].includes(command.status)) ||
            !!codex?.isPaused() ||
            !!codex?.isRecovering() ||
            !!getResponsesRuntime(session)?.isRunning()
          );
        },
      })
    : undefined;
  credentialConnectionsRouter = service
    ? createCredentialConnectionsRouter(service, credentialSetupApplication)
    : null;
}
/** Both ordinary startup and the retained owner install the same private runtime.
 * The supervised app child receives no Keychain configuration or metadata store. */
export function configureCredentialConnectionsRuntime() {
  setCredentialConnectionsRuntime(null);
  let runtime: ReturnType<typeof createCredentialConnectionsRuntime> | undefined;
  try {
    const config = keychainConnectionConfig(process.env);
    if (!config) return null;
    runtime = createCredentialConnectionsRuntime(config);
    setCredentialConnectionsRuntime(runtime.service);
    return runtime;
  } catch {
    setCredentialConnectionsRuntime(null);
    runtime?.store.close();
    log.error('Apple Keychain connections disabled: invalid signed helper configuration');
    return null;
  }
}
// Reauthorization belongs to the authenticated browser process, even when the
// connection owner is retained elsewhere. It creates no connection runtime.
app.post(
  '/api/credential-connections/reauthorize',
  operatorAuthMiddleware,
  ...recentAppReauthorizationHandlers(),
);
app.use('/api/credential-connections', operatorAuthMiddleware, (req, res, next) => {
  if (!res.locals.authSession)
    return res.status(401).json({ error: 'Browser authentication required' });
  if (!credentialConnectionsRouter)
    return res.status(503).json({
      error: 'Apple Keychain connections require a signed Mac helper. Complete setup on the Mac.',
    });
  return credentialConnectionsRouter(req, res, next);
});
app.use('/api/connections', authMiddleware, (req, res, next) => {
  if (!connectionsRouter)
    return res.status(503).json({
      error:
        'Connections is not configured. Set MITZO_CONNECTIONS_ENABLED=1 with the reviewed OpenShell Jira profile before enabling it.',
    });
  return connectionsRouter(req, res, next);
});
app.use('/api/capability-operations', authMiddleware, (req, res, next) => {
  if (!capabilityOperationsRouter)
    return res.status(503).json({ error: 'Capability operations are not configured.' });
  return capabilityOperationsRouter(req, res, next);
});
// Two 5 MiB UTF-8 documents can each expand sixfold when JSON escapes control bytes.
app.put('/api/files/write', authMiddleware, express.json({ limit: 60 * 1024 * 1024 + 64 * 1024 }));
// Authenticate before accepting the expanded JSON envelope; decoded document bytes remain capped at 5 MiB.
app.post('/api/internal/telos/artifacts/save', authMiddleware, telosArtifactSaveJson);
app.put('/api/telos/artifacts/:id/document', operatorAuthMiddleware, telosArtifactSaveJson);
app.post(
  '/api/telos/items/:itemId/artifacts/upload',
  operatorAuthMiddleware,
  express.json({ limit: '8mb' }),
);
app.use(
  '/api/telemetry',
  authMiddleware,
  createTelemetryRelay(process.env.OTEL_EXPORTER_OTLP_ENDPOINT),
);
app.use(express.json({ limit: '10mb' }));

const getKnowledgeLibraryRuntime = createKnowledgeLibraryLoader(() =>
  knowledgeLibraryFromEnvironment(process.env, {
    workspaceRoots: [
      BASE_REPO,
      ...Object.values(getRepoConfig().repos),
      ...getRepoConfig().allowedPaths,
    ].filter(Boolean),
  }),
);
installContextPackRuntime(getKnowledgeLibraryRuntime);
installKnowledgeDraftRuntime(getKnowledgeLibraryRuntime);
app.use(
  '/api/knowledge',
  operatorAuthMiddleware,
  createKnowledgeLibraryRouter(getKnowledgeLibraryRuntime),
);

const loginLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts, try again in a minute' },
});

// --- Version / update state ---

const indexHtmlPath = join(__dirname, '..', 'frontend', 'dist', 'index.html');
let buildHash = '';
try {
  buildHash = createHash('md5').update(readFileSync(indexHtmlPath)).digest('hex').slice(0, 8);
} catch {
  // Expected when frontend hasn't been built yet
}

const startupCommit = getLocalCommit();
let updateAvailable = false;

let onUpdateAvailable: (() => void) | null = null;
let onInboxUpdated: (() => void) | null = null;
let onTaskBroadcast: ((event: Record<string, unknown>) => void) | null = null;
let onWorkloadBroadcast: ((event: Record<string, unknown>) => void) | null = null;
let orchestrator: TaskOrchestrator | null = null;
let templateStore: WorkflowTemplateStore | null = null;
let signalProcessor: SignalProcessor | null = null;
let overviewEmitter: SessionOverviewEmitter | null = null;
let healthMonitor: { getSnapshot: () => unknown } | null = null;
let openShellLifecycleService: OpenShellLifecycleService | null = null;

/** Installed by server startup only after durable stores and protection readers are ready. */
export function setOpenShellLifecycleService(service: OpenShellLifecycleService | null): void {
  openShellLifecycleService = service;
}

export function setOrchestrator(o: TaskOrchestrator): void {
  orchestrator = o;
}

export function setOverviewEmitter(emitter: SessionOverviewEmitter): void {
  overviewEmitter = emitter;
}

export function setHealthMonitor(monitor: { getSnapshot: () => unknown }): void {
  healthMonitor = monitor;
}

export function setTemplateStore(ts: WorkflowTemplateStore): void {
  templateStore = ts;
}

export function setSignalProcessor(sp: SignalProcessor): void {
  signalProcessor = sp;
}

// --- Task store ---

const mitzoDir = join(BASE_REPO, '.mitzo');
try {
  mkdirSync(mitzoDir, { recursive: true });
} catch {
  // may already exist
}
export const taskStore = new TaskStore(join(mitzoDir, 'tasks.db'));
setTaskStore(taskStore);
export const workloadStore = new WorkloadStore(taskStore.getDatabase());
setTokenStorePath(join(mitzoDir, 'device-tokens.json'));

export const sseRegistry = new SseRegistry();
export const chatSseRegistry = new SessionSseRegistry();
export const notificationCenter = new NotificationCenter(
  new NotificationStore(join(mitzoDir, 'notifications.db')),
  {
    push: deliverNotification,
    badge: sendBadgeUpdate,
    changed: () => sseRegistry.broadcast('notifications_changed', {}),
    configured: apnsConfigured,
    devices: () => pushTokens().length,
    sessionTitle: (id) => eventStore.getSession(id)?.summary ?? undefined,
  },
);
const inboxRouter = unifiedInboxRouter(notificationCenter, () => getRepoConfig().resolvedInboxPath);
setNotificationCenter(notificationCenter);
if (process.env.NODE_ENV !== 'test') notificationCenter.start();

export function setUpdateBroadcast(fn: () => void) {
  onUpdateAvailable = fn;
}

export function setInboxBroadcast(fn: () => void) {
  onInboxUpdated = fn;
}

export function setTaskBroadcast(fn: (event: Record<string, unknown>) => void) {
  onTaskBroadcast = fn;
}

export function setWorkloadBroadcast(fn: (event: Record<string, unknown>) => void) {
  onWorkloadBroadcast = fn;
}

/** Broadcast inbox_updated to all connected WS clients. */
export function broadcastInboxUpdate() {
  onInboxUpdated?.();
}

export async function runUpdateCheck() {
  const available = await isUpdateAvailable();
  const wasAvailable = updateAvailable;
  updateAvailable = available;
  if (updateAvailable && !wasAvailable) {
    log.info('update available — broadcasting to clients');
    onUpdateAvailable?.();
  }
}

// --- Routes ---

app.get('/api/version', (_req, res) =>
  res.json({ hash: buildHash, commit: startupCommit, updateAvailable }),
);

app.post('/api/version/check', authMiddleware, async (_req, res) => {
  await runUpdateCheck();
  res.json({ updateAvailable });
});

app.post('/api/permission/:permId/respond', (req, res) => {
  const token = req.query.token as string;
  const ntfyToken = process.env.NTFY_AUTH_TOKEN;
  if (!token || !ntfyToken || token !== ntfyToken) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  const raw = req.query.decision || req.body?.decision || 'deny';
  const parsed = PermissionDecision.safeParse(raw);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid decision' });
    return;
  }

  const ok = resolvePending(req.params.permId as string, parsed.data);
  if (!ok) {
    res.status(404).json({ error: 'Permission request not found or already resolved' });
    return;
  }

  res.json({ ok: true, decision: parsed.data });
});

// --- Repo registry API (internal-token auth, no cookie needed) ---

function verifyInternalToken(req: express.Request): boolean {
  return isValidInternalToken(req.headers['x-internal-token']);
}

app.get('/api/repos', (req, res) => {
  if (!verifyInternalToken(req)) {
    res.status(401).json({ error: 'Internal token required' });
    return;
  }
  res.json(Object.entries(getRepoConfig().repos).map(([name, path]) => ({ name, path })));
});

app.post('/api/repos/open', (req, res) => {
  if (!verifyInternalToken(req)) {
    res.status(401).json({ error: 'Internal token required' });
    return;
  }

  const { repoName, clientId } = req.body || {};

  if (!repoName || typeof repoName !== 'string') {
    res.status(400).json({ error: 'repoName is required' });
    return;
  }

  const config = getRepoConfig();
  const repoPath = config.repos[repoName];
  if (!repoPath) {
    const available = Object.keys(config.repos).join(', ');
    res.status(404).json({ error: `Unknown repo "${repoName}". Available: ${available}` });
    return;
  }

  if (!clientId || typeof clientId !== 'string') {
    res.status(400).json({ error: 'clientId is required' });
    return;
  }

  const session = registry.get(clientId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  // Idempotent: return existing worktree if already open for this repo
  const existing = session.worktreePaths.get(repoName);
  if (existing) {
    res.json({ path: existing.path, repoName, created: false });
    return;
  }

  // Create a new worktree for this repo using a unique ID
  const wtId = `wt-${Date.now().toString(36)}`;
  try {
    const worktreePath = createWorktree(wtId, repoPath);
    session.worktreePaths.set(repoName, { path: worktreePath, wtId });

    // Persist to event store for replay on reattach. Include sessionId
    // for v2 client demuxing — the client needs to know which session
    // this worktree belongs to.
    const event = {
      v: 2,
      type: 'worktree_opened',
      ts: Date.now(),
      repoName,
      path: worktreePath,
      ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    };
    let seq: number | undefined;
    if (session.sessionId) {
      seq = eventStore.append(session.sessionId, 'worktree_opened', event);
    }

    // Notify the frontend
    if (session.transport.isOpen()) {
      session.transport.send({ ...event, ...(seq != null ? { seq } : {}) });
    }

    log.info('opened repo worktree', { repoName, worktreePath, clientId });
    res.json({ path: worktreePath, repoName, created: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('failed to create repo worktree', { repoName, error: message });
    res.status(500).json({ error: `Failed to create worktree: ${message}` });
  }
});

app.post('/api/sessions', async (req, res) => {
  if (!verifyInternalToken(req)) {
    res.status(401).json({ error: 'Internal token required' });
    return;
  }

  // This hook/registration endpoint has no account or execution-target selection.
  // Reject before parsing: legacy fallback must not discard a malformed prompt
  // and allocate worktrees as though it were a registration-only request.
  if (Object.hasOwn(req.body ?? {}, 'initialPrompt')) {
    res.status(409).json({
      error: 'missing_runtime_selection',
      message:
        'Select an account, model and execution target through the ordinary chat or Telos workflow before starting a session.',
    });
    return;
  }

  const body = SessionCreateBody.safeParse(req.body);
  if (!body.success) {
    // Backwards-compatible: check for old-style { source: string } body
    const { source } = req.body || {};
    if (!source || typeof source !== 'string') {
      res.status(400).json({ error: 'source is required (cursor | claude | mitzo)' });
      return;
    }
    // Fall through with legacy shape
    await handleSessionCreate(res, { source });
    return;
  }

  await handleSessionCreate(res, body.data);
});

async function handleSessionCreate(
  res: express.Response,
  data: {
    source: string;
  },
) {
  const { source } = data;

  if (!isIsolationEnabled()) {
    log.info('session isolation disabled', { source });
    res.json({ sessionId: null, worktrees: null, isolation: false });
    return;
  }

  const config = getRepoConfig();
  const wtId = generateWtId();

  try {
    const worktrees = createAllWorktrees(wtId, BASE_REPO, config.repos, {
      prefix: source === 'cursor' ? '.cursor' : '.claude',
    });

    log.info('session worktrees created', {
      sessionId: wtId,
      source,
      repos: Object.keys(worktrees),
      hasInitialPrompt: false,
    });

    sseRegistry.broadcast('sessions_changed', {});

    res.status(200).json({
      sessionId: wtId,
      worktrees,
      isolation: true,
      headless: false,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('session creation failed', { source, error: message });
    res.status(500).json({ error: `Session creation failed: ${message}` });
  }
}

// --- Suspend endpoint (sendBeacon fallback) ---
// Above authMiddleware because sendBeacon cannot set custom headers.
// Auth is verified via the session cookie (sent automatically by sendBeacon
// on same-origin requests). The transport connection is bound to the same
// login session, and connectionId ownership is also checked per chat session.

app.post('/api/sessions/suspend', (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  authenticateToken(token).then((authSession) => {
    if (!authSession) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    const { connectionId, sessions } = req.body || {};

    if (!connectionId || typeof connectionId !== 'string') {
      res.status(400).json({ error: 'connectionId is required' });
      return;
    }
    if (!isTransportConnectionOwnedBy(connectionId, authSession.id)) {
      res.status(403).json({ error: 'Connection belongs to another login' });
      return;
    }
    if (!Array.isArray(sessions) || sessions.length === 0) {
      res.status(400).json({ error: 'sessions array is required' });
      return;
    }

    for (const entry of sessions) {
      if (!entry.sessionId || typeof entry.sessionId !== 'string') continue;
      const lastSeq = typeof entry.lastSeq === 'number' ? entry.lastSeq : 0;

      const found = registry.findBySessionId(entry.sessionId);
      if (!found) continue;

      // Verify the connectionId owns this session (same check as WS handler)
      const colonIdx = found.clientId.indexOf(':');
      const ownerConnection =
        found.session?.ownerConnectionId ??
        (colonIdx === -1 ? found.clientId : found.clientId.slice(0, colonIdx));
      if (ownerConnection !== connectionId) continue;

      registry.suspend(found.clientId, lastSeq);
      eventStore.setSessionState(entry.sessionId, 'SUSPENDED', {
        clientId: found.clientId,
        reason: 'ios_background_rest',
      });
      log.info('session suspended via REST', {
        connectionId,
        sessionId: entry.sessionId,
        clientId: found.clientId,
      });
    }

    res.status(204).end();
  });
});

// Logout must always reach cookie clearing, even when an explicit stale bearer
// would otherwise be rejected before the handler. Revoke every valid presented
// browser/native credential; invalid credentials do not prevent cookie removal.
app.post(
  '/api/auth/logout',
  authenticationRoute(
    async (req, res) => {
      const bearer = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7).trim()
        : undefined;
      const cookie = req.cookies?.[COOKIE_NAME] as string | undefined;
      const tokens = [
        ...new Set([bearer, cookie].filter((token): token is string => Boolean(token))),
      ];
      const sessions = await Promise.all(tokens.map((token) => verifyLogoutToken(token)));
      revokeOperatorSessions(sessions, (id) => custodianControllerClient?.invalidate(id));
      res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict' });
      res.json({ ok: true });
    },
    { warn: (message) => log.warn(message), logoutCookie: COOKIE_NAME },
  ),
);

app.use('/api', authMiddleware);
if (custodianControllerClient)
  app.use(
    createCustodianProxy(
      custodianControllerClient,
      (req, session, conversationId) =>
        publicationControllerApproval(
          registry,
          isTransportConnectionOwnedBy,
          conversationId,
          session.id,
          req.header('x-connection-id'),
          getConnectionRegistry() ?? undefined,
        ),
      (conversationId, connectionId) =>
        clearPublicationControllerSessionGrants(registry, conversationId, connectionId),
    ),
  );
receiveCustodianEvents(broadcastDurableSymposiumEvent);
// Only the canonical owner opens task persistence. Controllers use closed IPC above.
if (!custodianControllerClient)
  app.use('/api/agent-tasks', operatorAuthMiddleware, createAgentTaskRouter(getAgentTasks()));
app.use(
  '/api/context-packs',
  operatorAuthMiddleware,
  createContextPackRouter(async () => {
    const runtime = await getKnowledgeLibraryRuntime();
    return runtime ? contextPackRouterDependencies(runtime, getAgentLibrary()) : undefined;
  }),
);
app.use(
  '/api/agent-library',
  operatorAuthMiddleware,
  createAgentLibraryRouter(getAgentLibrary(), {
    toolBuilder: () => (custodianOwnerMode ? undefined : getToolBuilderStore()),
    apiTools: () => {
      const service = getCredentialConnectionsRuntime();
      return service ? { catalog: getApiToolCatalog(), service } : undefined;
    },
    configuredTools: () => ({
      catalog: getConfiguredToolCatalog(),
      cwd: BASE_REPO,
      env: nativeExecutionEnv(),
      readSources: loadMcpServers,
    }),
    adviser: new AgentLibraryAdviser(createTerminalAdviserSession),
    workspaceRoot: BASE_REPO,
    contextPacks: async (signal) => {
      const runtime = await getKnowledgeLibraryRuntime();
      if (!runtime) throw Error('Knowledge Library is not configured');
      return createAcceptedContextPacks(runtime, { assertCurrent: () => signal.throwIfAborted() });
    },
  }),
);
const symposiumProfileStore = new SymposiumProfileStore(
  join(BASE_REPO || '.', '.mitzo', 'events.db'),
);
const symposiumAgentContextStore = new SymposiumAgentContextStore(
  join(BASE_REPO || '.', '.mitzo', 'events.db'),
);
const symposiumAccessRequests = new SymposiumAccessRequests(
  join(BASE_REPO || '.', '.mitzo', 'events.db'),
);
const symposiumProfileProposalStore = new SymposiumProfileProposalStore(
  join(BASE_REPO || '.', '.mitzo', 'events.db'),
);
app.use(
  '/api/symposium/profile-proposals',
  operatorAuthMiddleware,
  createSymposiumProfileProposalRouter(symposiumProfileProposalStore, (sessionId) =>
    Boolean(eventStore.getSession(sessionId)),
  ),
);
app.use(
  '/api/symposium/profiles',
  operatorAuthMiddleware,
  createSymposiumProfileRouter(symposiumProfileStore),
);

let custodianBroadcast: typeof broadcastDurableSymposiumEvent | undefined;
export function setSymposiumCustodianBroadcast(value: typeof broadcastDurableSymposiumEvent) {
  if (!custodianOwnerMode) throw Error('Retained custodian mode required');
  custodianBroadcast = value;
}
const retainedCustodianSessions = new Set<string>();
export function hasRetainedCustodianSession(sessionId: string) {
  return retainedCustodianSessions.has(sessionId);
}
const symposiumNativeEvents = new SymposiumNativeEventSink(eventStore, (sessionId, event) =>
  (custodianBroadcast ?? broadcastDurableSymposiumEvent)(sessionId, event),
);
const symposiumSessionRuntimes = new Map<
  string,
  {
    orchestrator: SymposiumOrchestrator;
    runtimeFingerprint: string;
    runtime: ReturnType<typeof createSymposiumSessionRuntime>;
  }
>();
let symposiumShuttingDown = false;
let symposiumControllerPaused = false;
export function pauseSymposiumController() {
  symposiumControllerPaused = true;
}
export async function drainSymposiumController(identity: string, signal: AbortSignal) {
  pauseSymposiumController();
  await drainRetainedSymposiumControllers(eventStore, symposiumSessionRuntimes, identity, signal);
}
export function resumeSymposiumController() {
  if (symposiumShuttingDown || symposiumSessionRuntimes.size)
    throw Error('Retained runtime cleanup incomplete');
  symposiumControllerPaused = false;
}
export function beginSymposiumShutdown() {
  symposiumShuttingDown = true;
  symposiumPublication?.shutdown();
  for (const entry of symposiumSessionRuntimes.values()) entry.runtime.beginShutdown();
}
export async function drainSymposiumRuntimes(signal: AbortSignal) {
  beginSymposiumShutdown();
  const results = await Promise.allSettled(
    [...symposiumSessionRuntimes.values()].map((entry) => entry.runtime.drain(signal)),
  );
  signal.throwIfAborted();
  if (results.some((result) => result.status === 'rejected'))
    throw new Error('Symposium runtime cleanup incomplete');
}
/** Retire a live custodian's retained authority before its gateway exits.
 * Physical cleanup alone cannot leave active membership generations behind:
 * the next owner must see durable suspension and require explicit restore. */
export async function retireRetainedSymposiumRuntimes(identity: string, signal: AbortSignal) {
  if (!custodianOwnerMode) throw Error('Retained custodian mode required');
  beginSymposiumShutdown();
  await drainRetainedSymposiumControllers(eventStore, symposiumSessionRuntimes, identity, signal);
}
export interface SymposiumProductionHost
  extends SymposiumReviewPhysicalHost, SymposiumReviewRouteHost {
  activateSuccessorArtifact?(
    request: ArtifactGenerationRequest,
    generationId: string,
    exported: InitialSourceExportReceipt | SuccessorArtifactExportReceipt,
    bundle: Buffer,
    signal: AbortSignal,
  ): Promise<{ generationId: string; revision: number }>;
  publicationCredentials?: readonly PublicationCredentialRegistration[];
  exportCompletedArtifactBundle?: CompletedPublicationHost['exportCompletedArtifactBundle'];
  runSandboxCreation?: SandboxCreationFence;
  ensureSessionArtifacts?: (
    sessionId: string,
  ) => Promise<import('./symposium-session-artifacts.js').SessionArtifactPreparation>;
  /** Dedicated upstream routing; never inherit the legacy chat gateway. */
  runtimeConfig: OpenShellRuntimeConfig;
  attestationPath: string;
  admissionBuildSelection?: import('./symposium-owned-runtime-contract.js').SymposiumOwnedBuildSelection;
  collectSessionAdmissionCandidate?: (
    binding: { sessionId: string; configRevision: number },
    assertCurrent: () => void,
  ) => Promise<import('./symposium-owned-evidence.js').SessionOwnedEvidenceCapability>;
  collectSessionAdmissionEvidence?: (
    selection: unknown,
  ) => Promise<import('./symposium-owned-evidence.js').SessionOwnedEvidenceCapability>;
  collectAdmissionEvidence?: (
    selection: unknown,
  ) => Promise<import('./symposium-production-gate.js').SymposiumProductionAttestation>;
  beginDeviceLogin?: (
    selection?: ConnectionSelection,
  ) => Promise<import('./symposium-device-login.js').DeviceLogin>;
  beginLogin?: (selection?: ConnectionSelection) => Promise<{
    authorizationUrl: string;
    completed: Promise<unknown>;
    cancel(): void;
  }>;
  personalConnections?: SymposiumPersonalConnectionService;
  resolveSeatPolicy?: import('./symposium-owned-seat-policy.js').SymposiumSeatPolicySelector;
  observeDurableReviewToolResult?: import('./symposium-codex-native.js').OpenAiCodexSeatInput['observeDurableReviewToolResult'];
  /** Private host-only final RPC input metadata; omitted in ordinary production. */
  readonly observeNativeTurnInput?: boolean;
  observeStartupConfig?: import('./symposium-codex-native.js').OpenAiCodexSeatInput['observeStartupConfig'];
  observePrelaunch?: import('./symposium-codex-native.js').OpenAiCodexSeatInput['observePrelaunch'];
  readNativeObservation?: (
    claimToken: string,
  ) => import('./symposium-native-observations.js').NativeTurnObservation;
  verifySubscriptionPrivateAuth?: VerifySymposiumSubscriptionAuth;
  assertSubscriptionDispatch?: (input: Parameters<VerifySymposiumSubscriptionAuth>[0]) => void;
  physical: SymposiumProductionPhysicalProof;
  preinitialSource?: (sessionId: string) => boolean;
  artifactReady?: (sessionId: string, seatId: string, generation: number) => boolean;
  artifactRequest(
    sessionId: string,
    seatId: string,
    generation: number,
    purpose?: 'admission' | 'cleanup',
  ): ArtifactLeaseRequest;
}
let symposiumProductionHost: SymposiumProductionHost | undefined;
let symposiumPublication: PublicationRegistration | undefined;
/** Trusted server bootstrap only. No request handler accepts or supplies this capability. */
export function installSymposiumProductionHost(host: SymposiumProductionHost): void {
  if (symposiumProductionHost || symposiumSessionRuntimes.size)
    throw new Error('Symposium production host must be installed once before runtime creation');
  if (custodianOwnerMode && host.sourceImport?.requireSeal && !host.reviewHost) {
    const composed = createSymposiumProductionReviewComposition({
      host,
      events: eventStore,
      reviews: symposiumReviewStore,
      grants: symposiumHostGrants,
      actionAuthority: symposiumReviewActionAuthority,
      artifactResultsPath: join(BASE_REPO || '.', '.mitzo', 'events.db'),
      runtime: (sessionId) => symposiumRuntimeForSession(sessionId),
      retainedRuntime: (sessionId) => symposiumSessionRuntimes.get(sessionId) ?? null,
      retireSealedRuntime: (sessionId, runtime) => {
        const retained = symposiumSessionRuntimes.get(sessionId);
        if (!retained || retained.runtime !== runtime)
          throw new Error('Sealed runtime identity changed before retirement');
        symposiumSessionRuntimes.delete(sessionId);
      },
    });
    try {
      installSymposiumReaderAuthority({
        current: composed.assertReaderAdmissionCurrent,
        staged: composed.assertReaderAdmissionStaged,
      });
      host.reviewHost = composed.reviewHost;
    } catch (error) {
      composed.close();
      throw error;
    }
  }
  if (host.publicationCredentials?.length) {
    if (
      !host.requireCompletedArtifactSeal ||
      !host.inspectCompletedArtifact ||
      !host.exportCompletedArtifactBundle
    )
      throw new Error('Publication registration requires completed artifact custody');
    const artifact = completedPublicationArtifact({
      store: symposiumReviewStore,
      host: {
        requireCompletedArtifactSeal: host.requireCompletedArtifactSeal.bind(host),
        inspectCompletedArtifact: host.inspectCompletedArtifact.bind(host),
        exportCompletedArtifactBundle: host.exportCompletedArtifactBundle.bind(host),
      },
    });
    symposiumPublication = new PublicationRegistration({
      describeArtifact: async (sessionId, recordId, signal) => {
        const record = symposiumReviewStore.getReviewRecord('user', sessionId, recordId);
        const fenceId = record && publicationSealFenceForRecord(record);
        const intent = fenceId && eventStore.getSymposiumArtifactSealByFence(fenceId);
        if (!record || !intent)
          throw new Error('Trusted review record and completed seal required');
        const seal = await host.requireCompletedArtifactSeal!(intent.fenceId, signal);
        if (
          seal.sessionId !== sessionId ||
          seal.fenceId !== intent.fenceId ||
          seal.git.commit !== record.snapshot.artifactRevision ||
          seal.git.committedTreeDigest !== record.snapshot.artifactHash ||
          intent.selection.sessionId !== sessionId
        )
          throw new Error('Trusted review record seal changed');
        return {
          recordId: record.recordId,
          recordHash: record.contentHash,
          sealId: seal.fenceId,
          sealHash: completedSealHash(seal),
          commit: seal.git.commit,
        };
      },
      authorityPath: publicationAuthorityPath(join(BASE_REPO || '.', '.mitzo')),
      operations: capabilityOperationStore(join(BASE_REPO || '.', '.mitzo')),
      credentials: host.publicationCredentials,
      artifact,
    });
  }
  symposiumProductionHost = host;
}
let symposiumRuntimeForSession: (sessionId: string) => SymposiumOrchestrator | null = (
  sessionId,
) => {
  if (symposiumShuttingDown || symposiumControllerPaused) return null;
  if (custodianOwnerMode && !retainedCustodianSessions.has(sessionId)) return null;
  if (eventStore.getSession(sessionId)?.sessionType !== 'symposium') return null;
  const host = symposiumProductionHost;
  if (!host) return null;
  const baseConfig = host.runtimeConfig;
  const attestationPath = host.attestationPath;
  if (!attestationPath) return null;
  let verified: ReturnType<typeof verifySymposiumProductionGate>;
  let attestationIdentity: string | undefined;
  const verifyHostCapability = () => {
    if (symposiumShuttingDown) throw new Error('Symposium is shutting down');
    if (!attestationPath || !symposiumProductionHost)
      throw new Error('Symposium production host or attestation is unavailable');
    const attestation = readSymposiumProductionAttestation(attestationPath);
    const identity = JSON.stringify(attestation);
    if (attestationIdentity && identity !== attestationIdentity)
      throw new Error('Symposium production attestation changed during session');
    const result = verifySymposiumProductionGate(
      baseConfig,
      attestation,
      symposiumProductionHost.physical,
      undefined,
      symposiumProductionHost.admissionBuildSelection,
    );
    attestationIdentity = identity;
    return result;
  };
  try {
    verified = verifyHostCapability();
    if (
      verified.allowedAccountProviders.has('openai-codex') &&
      (!host.verifySubscriptionPrivateAuth || !host.assertSubscriptionDispatch)
    )
      return null;
  } catch {
    return null;
  }
  const runtimeConfig = verified.runtimeConfig;
  const runtimeFingerprint = JSON.stringify({
    runtimeConfig,
    allowedRoles: [...verified.allowedRoles].sort(),
    allowedAccountProviders: [...verified.allowedAccountProviders].sort(),
    attestationIdentity,
  });
  const cached = symposiumSessionRuntimes.get(sessionId);
  if (cached && cached.runtimeFingerprint !== runtimeFingerprint) return null;
  let runtime = cached?.orchestrator;
  if (!runtime) {
    const retainedRuntime = createSymposiumSessionRuntime({
      sessionId,
      store: eventStore,
      profiles: host.currentProfiles(),
      currentProfiles: host.currentProfiles,
      observeDurableReviewToolResult: host.observeDurableReviewToolResult,
      observeNativeTurnInput: host.observeNativeTurnInput,
      observeStartupConfig: host.observeStartupConfig,
      observePrelaunch: host.observePrelaunch,
      hostGrants: symposiumHostGrants,
      codexStore: getCodexConversationStore(),
      profileProposalStore: symposiumProfileProposalStore,
      accessRequests: symposiumAccessRequests,
      profileCatalogStore: symposiumProfileStore,
      agentContext: createSymposiumAgentContextBinding({
        store: symposiumAgentContextStore,
        profiles: symposiumProfileStore,
        assertCurrent: (execution) => {
          execution.signal.throwIfAborted();
          const generation = execution.provenance.membershipGeneration;
          if (generation === undefined) throw Error('Context membership generation is unavailable');
          symposiumHostGrants.verifySeat({
            sessionId: execution.sessionId,
            seat: execution.seat,
            membershipGeneration: generation,
          });
          const recipe = execution.seat.contextRecipe;
          if (
            recipe?.source === 'packs' &&
            recipe.packs.some(
              (pin) => !execution.seat.contextGrant?.sourceRefs.includes(contextPackSourceRef(pin)),
            )
          )
            throw Error('The selected context packs are outside the host-issued context grant');
        },
        compileOptions: async (execution) => {
          const runtime = await getKnowledgeLibraryRuntime();
          if (!runtime) throw Error('Knowledge Library is not configured for this agent');
          return {
            packs: createAcceptedContextPacks(runtime, {
              assertCurrent: () => {
                execution.signal.throwIfAborted();
                const generation = execution.provenance.membershipGeneration;
                if (generation === undefined)
                  throw Error('Context membership generation is unavailable');
                symposiumHostGrants.verifySeat({
                  sessionId: execution.sessionId,
                  seat: execution.seat,
                  membershipGeneration: generation,
                });
              },
            }),
          };
        },
      }),
      reviewStore: symposiumReviewStore,
      resolveProviderIdentity: createOpenShellProviderIdentityResolver(runtimeConfig),
      runtimeConfig,
      perSeatSandboxVerified: true,
      allowedSeatRoles: verified.allowedRoles,
      allowedAccountProviders: verified.allowedAccountProviders,
      verifyHostCapability,
      attemptRegistry: host.attemptRegistry,
      claimIdFactory: (input) =>
        selectSymposiumApplicationClaim(symposiumReviewStore, input) ?? randomUUID(),
      assertArtifactAdmissionCurrent: host.assertArtifactAdmissionCurrent,
      applicationPolicy: createSymposiumApplicationDispatchPolicy({
        store: symposiumReviewStore,
        observations: host.attemptRegistry.observations,
        assertArtifactCurrent(attempt) {
          const current = host.reviewHost?.currentArtifact({ owner: 'user', sessionId });
          if (
            !current ||
            current.revision !== attempt.artifactRevision ||
            current.hash !== attempt.artifactHash
          )
            throw new Error('Trusted current application artifact unavailable');
        },
      }),
      artifactLeaseHost: host.artifactLeaseHost,
      artifactRequest: host.artifactRequest,
      preinitialSource: host.preinitialSource,
      artifactReady: host.artifactReady,
      resolveSeatPolicy: host.resolveSeatPolicy,
      runSandboxCreation: host.runSandboxCreation,
      verifiedCodexControllerCommand: SYMPOSIUM_CODEX_CONTROLLER_COMMAND,
      ...(host.verifySubscriptionPrivateAuth
        ? {
            verifiedSubscriptionControllerCommand: SYMPOSIUM_SUBSCRIPTION_CONTROLLER_COMMAND,
            verifySubscriptionPrivateAuth: host.verifySubscriptionPrivateAuth,
            assertSubscriptionDispatch: host.assertSubscriptionDispatch,
          }
        : {}),
      readOnlyEnforced: {
        openaiApi: verified.readOnlyEnforced,
        chatgptSubscription: verified.readOnlyEnforced,
        claudeVertex: verified.claudeProviders.size > 0,
      },
      recordAccepted: (receipt) => eventStore.markSymposiumRecipientAccepted(receipt),
      recordEvent: (execution, event) => symposiumNativeEvents.record(execution, event),
    });
    runtime = retainedRuntime.orchestrator;
    symposiumSessionRuntimes.set(sessionId, {
      orchestrator: runtime,
      runtimeFingerprint,
      runtime: retainedRuntime,
    });
  }
  return runtime;
};
const symposiumSafetyOrchestrator = new SymposiumOrchestrator({ store: eventStore, executors: {} });
function symposiumAccountProfiles(): AccountProfiles {
  if (!symposiumProductionHost) throw new Error('Symposium account catalog is unavailable');
  return symposiumProductionHost.currentProfiles();
}
const symposiumHostGrants = new SymposiumHostGrants(join(BASE_REPO || '.', '.mitzo', 'events.db'), {
  getConfig: (sessionId) => {
    const raw = eventStore.getSession(sessionId)?.symposiumConfig;
    return raw ? SymposiumConfigSchema.parse(JSON.parse(raw)) : null;
  },
  commitConfig: (sessionId, config, expectedRevision, operation) =>
    operation
      ? eventStore.setSymposiumConfig(sessionId, config, expectedRevision, operation)
      : eventStore.setSymposiumConfig(sessionId, config, expectedRevision),
  getMembership: (sessionId, seatId) =>
    eventStore.getLatestSymposiumMembership(sessionId, seatId) ?? null,
  validateSelection: (seat) => {
    if (!seat.accountBinding) throw new Error('Seat account binding is required');
    symposiumAccountProfiles().validateModel(seat.accountBinding, seat.model, seat.reasoningEffort);
  },
  resolveProfile: (selection) =>
    symposiumProfileStore.get('user', selection.profileId, selection.revision),
  authorizeSeat: authorizeSymposiumSeat,
});
const symposiumReaderAuthorityBridge = createSymposiumReaderAuthorityBridge();

/** Trusted app composition installs the concrete owner once; requests never supply this callback. */
export function installSymposiumReaderAuthority(
  assertAdmissionCurrent: Parameters<typeof symposiumReaderAuthorityBridge.install>[0],
): void {
  symposiumReaderAuthorityBridge.install(assertAdmissionCurrent);
}

export function getSymposiumBootstrapDependencies() {
  return {
    collectSessionAdmissionEvidence: (selection: unknown) => {
      const collect = symposiumProductionHost?.collectSessionAdmissionEvidence;
      if (!collect) throw new Error('Original admission evidence owner unavailable');
      return collect(selection);
    },
    reviews: symposiumReviewStore,
    readNativeObservation: (claimToken: string) => {
      const read = symposiumProductionHost?.readNativeObservation;
      if (!read) throw new Error('Original native observation owner unavailable');
      return read(claimToken);
    },
    facts: eventStore,
    hostGrants: symposiumHostGrants,
    successorAuthority: createSymposiumSuccessorFixAuthority({
      workflows: symposiumReviewStore,
      events: eventStore,
      grants: symposiumHostGrants,
    }),
    readerAuthority: symposiumReaderAuthorityBridge.authority,
  };
}

/** Runtime integration installs a verified session-scoped orchestrator, never config-only admission. */
export function setSymposiumDirectorRuntimeFactory(
  factory: (sessionId: string) => SymposiumOrchestrator | null,
): void {
  symposiumRuntimeForSession = factory;
}
app.use(
  '/api/symposium/sessions',
  operatorAuthMiddleware,
  createSymposiumSessionRouter({
    store: eventStore,
    profiles: symposiumProfileStore,
    currentAccounts: symposiumAccountProfiles,
    onSessionCreated: (sessionId) => retainedCustodianSessions.add(sessionId),
    ensureSessionArtifacts: async (sessionId) => {
      if (custodianOwnerMode && !retainedCustodianSessions.has(sessionId))
        throw Error('Session was not created by this retained custodian');
      return symposiumProductionHost?.ensureSessionArtifacts?.(sessionId) ?? { state: 'pending' };
    },
  }),
);
const symposiumReviewActionAuthority = new SymposiumReviewActionAuthority();
const symposiumReviewStore = new SymposiumReviewStore(
  join(BASE_REPO || '.', '.mitzo', 'events.db'),
);
app.use(
  '/api/sessions/:id/symposium/access-requests',
  operatorAuthMiddleware,
  createSymposiumAccessRouter(
    symposiumAccessRequests,
    (id) => eventStore.getSession(id)?.sessionType === 'symposium',
  ),
);
app.use(
  '/api/sessions/:id/github-publication',
  operatorAuthMiddleware,
  createGithubPublicationOperatorRouter({
    hasOrdinarySession: (id) => {
      const session = eventStore.getSession(id);
      return !!session && session.sessionType !== 'symposium';
    },
    invoke: (id, input, signal) => requestOperatorGithubPublication(id, registry, input, signal),
  }),
);
mountSymposiumArtifactRoutes(app, {
  events: eventStore,
  currentHost: () => symposiumProductionHost,
  repositories: () => getRepoConfig().repos,
  publication: {
    onConsentInvalidated: (conversationId, connectionId) =>
      clearPublicationControllerSessionGrants(registry, conversationId, connectionId),
    onPublicationCompleted: (sessionId, publication, operation) =>
      symposiumAccessRequests.publicationCompleted(sessionId, publication, operation),
    registration: () => symposiumPublication,
    approval: (req, session, conversationId) =>
      custodianPublicationApproval(req) ??
      publicationControllerApproval(
        registry,
        isTransportConnectionOwnedBy,
        conversationId,
        session.id,
        req.header('x-connection-id'),
        getConnectionRegistry() ?? undefined,
      ),
  },
  reviews: {
    store: symposiumReviewStore,
    actionAuthority: symposiumReviewActionAuthority,
    runtime: (sessionId) => symposiumRuntimeForSession(sessionId),
  },
});
mountSymposiumDirectorRoutes(app, {
  store: eventStore,
  currentHost: () => symposiumProductionHost,
  currentAccounts: symposiumAccountProfiles,
  runtime: (sessionId) => symposiumRuntimeForSession(sessionId),
  safetyOrchestrator: symposiumSafetyOrchestrator,
  grants: symposiumHostGrants,
  registry,
});

app.use(
  '/api/sandboxes',
  createWarmPoolRouter({
    pool: getOpenShellWarmPool,
    authorize: operatorAuthMiddleware,
    ownershipReview: async (physicalId, signal) => {
      const physical = (await readOpenShellSandboxInventory(signal)).find(
        (item) => item.id === physicalId,
      );
      if (!physical) throw new Error('Physical sandbox is no longer present');
      const managed = summarizeSandboxInventory(
        [physical],
        openShellLifecycleService?.inventory() ?? [],
        getOpenShellWarmPool()?.snapshot().spares ?? [],
      ).items[0];
      if (managed?.management !== 'needs_review')
        throw new Error('Resource is now managed; refresh inventory');
      return readSandboxOwnershipReview(physical, getCodexConversationStore(), eventStore);
    },
    physicalInventory: async (signal) =>
      summarizeSandboxInventory(
        await readOpenShellSandboxInventory(signal),
        openShellLifecycleService?.inventory() ?? [],
        getOpenShellWarmPool()?.snapshot().spares ?? [],
      ),
    conversations: () => {
      const records = new Map<string, Omit<SandboxConversation, 'title'>>(
        (openShellLifecycleService?.inventory() ?? []).map((record) => [
          record.conversationId,
          { ...record, canReviewCleanup: true },
        ]),
      );
      for (const record of getOpenShellWarmPool()?.snapshot().owned ?? []) {
        if (!records.has(record.conversationId!))
          records.set(record.conversationId!, {
            conversationId: record.conversationId!,
            sandboxName: record.name,
            state: record.state === 'claimed' ? 'conversation_owned' : 'needs_review',
            account: record.provider ?? 'Unverified',
            canReviewCleanup: false,
          });
      }
      return [...records.values()].map((record) => ({
        ...record,
        title: eventStore.getSession(record.conversationId)?.summary ?? 'Conversation',
        account:
          eventStore.getSession(record.conversationId)?.accountBinding?.accountLabel ??
          record.account,
      }));
    },
  }),
);

app.get('/api/openshell/lifecycle/:conversationId/preview', async (req, res) => {
  if (!openShellLifecycleService) {
    res.status(503).json({ error: 'OpenShell lifecycle service is unavailable' });
    return;
  }
  try {
    res.json(
      await openShellLifecycleService.preview(
        req.params.conversationId,
        AbortSignal.timeout(120_000),
        req.query.intent === 'delete' ? 'delete' : 'policy',
      ),
    );
  } catch (error) {
    res.status(409).json({
      error: error instanceof Error ? error.message : 'OpenShell lifecycle preview failed',
    });
  }
});
app.post('/api/openshell/lifecycle/confirm', operatorAuthMiddleware, async (req, res) => {
  if (!openShellLifecycleService) {
    res.status(503).json({ error: 'OpenShell lifecycle service is unavailable' });
    return;
  }
  const token = req.body?.token;
  if (typeof token !== 'string' || !token) {
    res.status(400).json({ error: 'Lifecycle preview token is required' });
    return;
  }
  try {
    res.json({
      action: await openShellLifecycleService.confirm(token, AbortSignal.timeout(120_000)),
    });
  } catch (error) {
    res.status(409).json({
      error: error instanceof Error ? error.message : 'OpenShell lifecycle confirmation failed',
    });
  }
});
app.post(
  '/api/openshell/lifecycle/:conversationId/retention-consent',
  operatorAuthMiddleware,
  async (req, res) => {
    if (!openShellLifecycleService) {
      res.status(503).json({ error: 'OpenShell lifecycle service is unavailable' });
      return;
    }
    if (typeof req.body?.enabled !== 'boolean') {
      res.status(400).json({ error: 'Retention consent enabled must be a boolean' });
      return;
    }
    const conversationId = req.params.conversationId;
    if (typeof conversationId !== 'string') {
      res.status(400).json({ error: 'Lifecycle conversation ID is required' });
      return;
    }
    try {
      await openShellLifecycleService.setRetentionConsent(conversationId, req.body.enabled);
      res.json({ enabled: req.body.enabled });
    } catch (error) {
      res
        .status(409)
        .json({ error: error instanceof Error ? error.message : 'Retention consent failed' });
    }
  },
);

// --- SSE Event Bus ---

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx: don't buffer SSE
  });

  const clientId = randomUUID();
  sseRegistry.add(clientId, res);
  const authSession = res.locals.authSession as AuthSession | undefined;
  let cleaned = false;
  let unregisterAuth: () => void = () => undefined;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    unregisterAuth();
    sseRegistry.remove(clientId);
  };
  req.on('close', cleanup);
  unregisterAuth = authSession
    ? registerAuthSession(authSession, (reason) => {
        sseRegistry.sendTo(clientId, 'auth_expired', { reason });
        res.end();
        cleanup();
      })
    : () => undefined;
  if (cleaned) {
    unregisterAuth();
    return;
  }

  // Hydrate: send server version + session overview on connect
  sseRegistry.sendTo(clientId, 'connected', {
    serverVersion: buildHash,
  });

  if (overviewEmitter) {
    sseRegistry.sendTo(clientId, 'session_activity', overviewEmitter.getSnapshot());
  }

  if (healthMonitor) {
    sseRegistry.sendTo(clientId, 'health', healthMonitor.getSnapshot());
  }
});

// REST fallback for service health (iOS WebKit can't do SSE with self-signed certs)
app.get('/api/service-health', (_req, res) => {
  res.json(healthMonitor?.getSnapshot() ?? { services: [], checkedAt: 0 });
});

// --- Task Board API ---

app.get('/api/tasks', (_req, res) => {
  res.json({ tasks: taskStore.getTree() });
});

app.post('/api/tasks', (req, res) => {
  const body = TaskCreateBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }
  try {
    const task = taskStore.create(body.data as TaskCreateInput);
    res.status(201).json({ task });
    // Broadcast full tree so child tasks appear correctly in all clients
    onTaskBroadcast?.({ type: 'task_state', tasks: taskStore.getTree() });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

app.get('/api/tasks/:id', (req, res) => {
  const task = taskStore.get(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json({ task });
});

app.patch('/api/tasks/:id', (req, res) => {
  const body = TaskUpdateBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }
  const task = taskStore.update(req.params.id, body.data as TaskUpdateInput);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (body.data.status === 'done' && orchestrator) {
    orchestrator.onTaskCompleted(req.params.id);
  }
  res.json({ task });
  onTaskBroadcast?.({ type: 'task_updated', task });
});

app.delete('/api/tasks/:id', (req, res) => {
  const ok = taskStore.delete(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json({ ok: true });
  onTaskBroadcast?.({ type: 'task_deleted', taskId: req.params.id });
});

// --- Internal task-tool endpoints (MCP server callback) ---

function resolveTaskContext(req: express.Request): string | null {
  const clientId = req.headers['x-client-id'] as string | undefined;
  if (!clientId) return null;
  const session = registry.get(clientId);
  const taskId = session?.taskContext?.currentTaskId;
  if (!session?.sessionId || !taskId) return null;
  let work: TelosWorkStore | undefined;
  try {
    return resolveTelosWorkTaskToolContext(
      {
        events: eventStore,
        tasks: taskStore,
        work: () =>
          (work ??= new TelosWorkStore(telosDatabasePath(), {
            ordinaryConversation: (id) =>
              isAvailableTelosWorkConversation(eventStore.getSession(id)),
          })),
      },
      {
        sessionId: session.sessionId,
        taskId,
        accountBinding: eventStore.getSession(session.sessionId)?.accountBinding ?? undefined,
      },
      { sessionId: req.headers['x-task-session-id'], taskId: req.headers['x-task-id'] },
    );
  } catch {
    return null;
  } finally {
    work?.close();
  }
}

app.post('/api/internal/task-tools/set', (req, res) => {
  if (!verifyInternalToken(req)) {
    res.status(401).json({ error: 'Internal token required' });
    return;
  }
  const taskId = resolveTaskContext(req);
  if (!taskId) {
    res.status(400).json({ error: 'No active task context' });
    return;
  }
  const result = handleTaskSet(taskStore, taskId, req.body.tasks ?? []);
  res.json({ result });
  onTaskBroadcast?.({
    type: 'task_state',
    tasks: taskStore.getTree(),
  });
});

app.post('/api/internal/task-tools/complete', (req, res) => {
  if (!verifyInternalToken(req)) {
    res.status(401).json({ error: 'Internal token required' });
    return;
  }
  const taskId = resolveTaskContext(req);
  if (!taskId) {
    res.status(400).json({ error: 'No active task context' });
    return;
  }
  const result = handleTaskComplete(taskStore, taskId, req.body.summary ?? '');
  if (orchestrator) {
    orchestrator.onTaskCompleted(taskId);
  }
  res.json({ result });
  onTaskBroadcast?.({
    type: 'task_state',
    tasks: taskStore.getTree(),
  });
});

app.get('/api/internal/task-tools/status', (req, res) => {
  if (!verifyInternalToken(req)) {
    res.status(401).json({ error: 'Internal token required' });
    return;
  }
  const taskId = resolveTaskContext(req);
  if (!taskId) {
    res.status(400).json({ error: 'No active task context' });
    return;
  }
  const result = handleTaskStatus(taskStore, taskId);
  res.json({ result });
});

app.post('/api/internal/task-tools/block', (req, res) => {
  if (!verifyInternalToken(req)) {
    res.status(401).json({ error: 'Internal token required' });
    return;
  }
  const taskId = resolveTaskContext(req);
  if (!taskId) {
    res.status(400).json({ error: 'No active task context' });
    return;
  }
  const result = handleTaskBlock(taskStore, taskId, req.body.reason ?? '');
  res.json({ result });
  onTaskBroadcast?.({
    type: 'task_state',
    tasks: taskStore.getTree(),
  });
});

app.post('/api/internal/task-tools/artifact', (req, res) => {
  if (!verifyInternalToken(req)) {
    res.status(401).json({ error: 'Internal token required' });
    return;
  }
  const taskId = resolveTaskContext(req);
  if (!taskId) {
    res.status(400).json({ error: 'No active task context' });
    return;
  }
  const result = handleTaskArtifact(taskStore, taskId, req.body.key ?? '', req.body.value ?? '');
  res.json({ result });
  onTaskBroadcast?.({
    type: 'task_state',
    tasks: taskStore.getTree(),
  });
});

const telosDatabasePath = () =>
  resolve(process.env.TELOS_DB_PATH || join(BASE_REPO, 'command_center', 'data', 'smart_todo.db'));
initializeTelosMainPublicationRuntime({
  registry,
  events: eventStore,
  databasePath: telosDatabasePath,
});

/** Compose ordinary role setup with the existing profile, preparation and runtime
 * owners. This is independent of Symposium joining and grants no first command. */
async function resolveTelosOrdinaryPreparation(
  raw: unknown,
  signal: AbortSignal,
  operatorConnectionId?: string,
  retainedLeadId?: string,
) {
  const settings = OrdinarySilentPreparationSelectionSchema.parse(raw);
  signal.throwIfAborted();
  const location = settings.binding.execution.location;
  if (
    custodianControllerClient ||
    custodianOwnerMode ||
    (location === 'local'
      ? process.env.MITZO_ORDINARY_LOCAL_CODEX_ENABLED
      : process.env.MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED) !== '1'
  )
    throw new Error('Selected ordinary role route unavailable');
  const { ordinaryRepositoryRuntimeInventory } = await import('./ordinary-local-codex-entry.js');
  const inventory = ordinaryRepositoryRuntimeInventory(location, 'codex');
  const resolved = inventory.catalog.resolve({
    account: settings.binding.account,
    harness: 'codex',
    targetId: settings.binding.execution.targetId,
    mode: settings.selection.permission.mode,
  });
  if (
    resolved.status !== 'compatible' ||
    !isDeepStrictEqual(resolved.binding, settings.binding) ||
    !inventory.result.routes.some(
      (route) =>
        isDeepStrictEqual(route.account, settings.binding.account) &&
        route.targetId === settings.binding.execution.targetId,
    )
  )
    throw new Error('Selected ordinary role binding unavailable');
  signal.throwIfAborted();
  const binding = repositoryWorkspaceBinding(
    settings.binding.account.accountId,
    settings.selection.model,
  );
  if (
    !isDeepStrictEqual(settings.binding.account, {
      accountId: binding.accountId,
      provider: binding.provider,
      profileRevision: binding.profileRevision,
    })
  )
    throw new Error('Original role account unavailable');
  loadAccountProfiles().validateModelSelection(
    binding,
    settings.selection.model,
    settings.selection.thinking,
  );
  const agentProfile = await resolveOrdinaryCodexAgentProfile({
    requested: settings.selection.agent,
    provider: binding.provider,
    execution: resolved.binding.execution,
    ...(retainedLeadId
      ? { stored: eventStore.getSession(retainedLeadId)?.agentProfile ?? undefined, resume: true }
      : {}),
    lookup: (selection) => {
      if (retainedLeadId)
        throw new TelosWorkError('unauthorized', 'Original lead profile unavailable');
      return readAgentLibraryProfile(selection, operatorConnectionId);
    },
  });
  signal.throwIfAborted();
  if (!agentProfile) throw new Error('Selected ordinary agent revision unavailable');
  const sandboxWorkdir =
    settings.binding.execution.location === 'openshell'
      ? loadOrdinaryOpenShellCodexTarget()?.config.workdir
      : undefined;
  if (settings.binding.execution.location === 'openshell' && !sandboxWorkdir)
    throw new Error('Original ordinary OpenShell target unavailable');
  return {
    binding,
    taskRoot: join(BASE_REPO, '.claude', 'repository-tasks'),
    agentProfile,
    ...(sandboxWorkdir ? { sandboxWorkdir } : {}),
  };
}
async function authorizeTelosOrdinaryPreparation(
  raw: unknown,
  signal: AbortSignal,
  operatorConnectionId?: string,
  retainedLeadId?: string,
) {
  const settings = OrdinarySilentPreparationSelectionSchema.parse(raw);
  const selected = await resolveTelosOrdinaryPreparation(
    settings,
    signal,
    operatorConnectionId,
    retainedLeadId,
  );
  const record = getRepositoryWorkspaces().get(settings.repositoryWorkspaceId);
  if (!record.ordinaryPreparation) throw new Error('Original ordinary preparation unavailable');
  await assertOrdinarySilentPreparationAuthority(
    record.ordinaryPreparation,
    selected.binding,
    settings,
    signal,
  );
}
async function resolveTelosOrdinaryWorkspaceSelection(
  raw: unknown,
  signal: AbortSignal,
  operatorConnectionId?: string,
  retainedLeadId?: string,
) {
  const settings = OrdinaryWorkspaceSettingsSchema.parse(raw);
  signal.throwIfAborted();
  if (
    custodianControllerClient ||
    custodianOwnerMode ||
    process.env.MITZO_ORDINARY_LOCAL_CODEX_ENABLED !== '1' ||
    settings.binding.execution.location !== 'local' ||
    settings.binding.harness.implementation !== 'codex' ||
    settings.binding.account.provider !== 'openai-codex'
  )
    throw new TelosWorkError(
      'invalid',
      'Ordinary workspaces currently require a supported Local Mac Codex account and target',
    );
  const { ordinaryRepositoryRuntimeInventory } = await import('./ordinary-local-codex-entry.js');
  const inventory = ordinaryRepositoryRuntimeInventory('local', 'codex');
  const resolved = inventory.catalog.resolve({
    account: settings.binding.account,
    harness: 'codex',
    targetId: settings.binding.execution.targetId,
    mode: settings.selection.permission.mode,
  });
  if (
    resolved.status !== 'compatible' ||
    !isDeepStrictEqual(resolved.binding, settings.binding) ||
    !inventory.result.routes.some(
      (route) =>
        isDeepStrictEqual(route.account, settings.binding.account) &&
        route.targetId === settings.binding.execution.targetId,
    )
  )
    throw new TelosWorkError(
      'invalid',
      'The selected ordinary account or target is unavailable; confirm the current execution choices',
    );
  const profiles = loadAccountProfiles(),
    binding = profiles.resolve(settings.binding.account.accountId, settings.selection.model);
  profiles.validateModelSelection(binding, settings.selection.model, settings.selection.thinking);
  const agentProfile = await resolveOrdinaryCodexAgentProfile({
    requested: settings.selection.agent,
    provider: binding.provider,
    execution: resolved.binding.execution,
    ...(retainedLeadId
      ? { stored: eventStore.getSession(retainedLeadId)?.agentProfile ?? undefined, resume: true }
      : {}),
    lookup: (selection) => {
      if (retainedLeadId)
        throw new TelosWorkError('unauthorized', 'Original ordinary lead profile unavailable');
      return readAgentLibraryProfile(selection, operatorConnectionId);
    },
  });
  if (!agentProfile) throw new TelosWorkError('invalid', 'Select a published ordinary agent');
  assertAgentToolRoute(agentProfile.definition, 'codex-owned-local');
  const selected = {
    binding,
    agentProfile,
    taskRoot: ordinaryWorkspaceTaskRoot(),
    requiredCapabilities: ['ordinary_conversation', 'retained_artifacts', 'task_execution'],
  };
  await getOrdinaryWorkspaces().qualifyOrdinaryWorkspace({
    ...selected,
    preparationId: settings.workspace.preparationId,
    settings,
    signal,
  });
  signal.throwIfAborted();
  ordinaryWorkspaceTaskRoot(true);
  return selected;
}
function telosRoleHost(operatorConnectionId?: string, ordinary = false) {
  return createTelosWorkRoleHost({
    dbPath: telosDatabasePath,
    events: eventStore,
    ordinaryConversation: (id) => isAvailableTelosWorkConversation(eventStore.getSession(id)),
    sourceConversation: (id) => isAvailableTelosSourceConversation(eventStore.getSession(id)),
    workspaces: () => (ordinary ? getOrdinaryWorkspaces() : getRepositoryWorkspaces()),
    ordinary: {
      resolveSelection: (scope, signal) =>
        resolveTelosOrdinaryWorkspaceSelection(scope.input.settings, signal, operatorConnectionId),
      authorizeSettings: async (scope, signal) => {
        await resolveTelosOrdinaryWorkspaceSelection(
          scope.setup.input.settings,
          signal,
          operatorConnectionId,
        );
      },
    },
    resolvePreparation: async (scope, signal) => {
      const selected = await resolveTelosOrdinaryPreparation(
        scope.setup.input.settings,
        signal,
        operatorConnectionId,
      );
      if (scope.setup.input.settings.binding.execution.location === 'local') {
        if (!BASE_REPO) throw new Error('Ordinary task root unavailable');
        mkdirSync(selected.taskRoot, { recursive: true, mode: 0o700 });
      }
      return selected;
    },
    authorizeSettings: (scope, signal) =>
      authorizeTelosOrdinaryPreparation(scope.setup.input.settings, signal, operatorConnectionId),
  });
}
async function setupTelosRole(request: TelosWorkRoleRequest, reviewed = false, ordinary = false) {
  request.assertAuthorized();
  if (!request.authorization)
    throw new TelosWorkError('unauthorized', 'Interactive operator required');
  return withAgentLibraryRecoveryAuthorization(request.authorization, (connectionId) =>
    ordinary
      ? reviewed
        ? telosRoleHost(connectionId, true).setupReviewedOrdinary(request)
        : telosRoleHost(connectionId, true).setupOrdinary(request)
      : reviewed
        ? telosRoleHost(connectionId).setupReviewed(request)
        : telosRoleHost(connectionId).setup(request),
  );
}
async function delegateTelosSlice(request: TelosWorkRoleRequest, explicitOrdinary = false) {
  request.assertAuthorized();
  const ordinary =
    explicitOrdinary ||
    (request.actor.kind === 'conversation' &&
      eventStore.getSession(request.actor.id)?.ordinaryWorkspaceId != null);
  const run = (connectionId?: string) => {
    const leadId = request.actor.kind === 'conversation' ? request.actor.id : undefined;
    const resolve = async (scope: TelosWorkDelegationScope, signal: AbortSignal) => {
      const selected = await resolveTelosOrdinaryPreparation(
        scope.settings,
        signal,
        connectionId,
        leadId,
      );
      if (scope.settings.binding.execution.location === 'local') {
        if (!BASE_REPO) throw new Error('Ordinary task root unavailable');
        mkdirSync(selected.taskRoot, { recursive: true, mode: 0o700 });
      }
      return selected;
    };
    const host = createTelosWorkDelegationHost({
      dbPath: telosDatabasePath,
      events: eventStore,
      tasks: taskStore,
      workspaces: () => (ordinary ? getOrdinaryWorkspaces() : getRepositoryWorkspaces()),
      ordinary: {
        qualifySettings: (scope, signal) =>
          resolveTelosOrdinaryWorkspaceSelection(
            scope.input.settings,
            signal,
            connectionId,
            leadId,
          ),
        resolvePreparation: (scope, signal) =>
          resolveTelosOrdinaryWorkspaceSelection(scope.settings, signal, connectionId, leadId),
        authorizeSettings: async (scope, signal) => {
          await resolveTelosOrdinaryWorkspaceSelection(
            scope.settings,
            signal,
            connectionId,
            leadId,
          );
        },
        dispatch: (owner, actor, input, signal) => {
          if (!orchestrator)
            throw new TelosWorkError('conflict', 'Ordinary delegation dispatcher unavailable');
          return orchestrator.delegateSlice(owner, actor, input, signal);
        },
      },
      ordinaryConversation: (id) => isAvailableTelosWorkConversation(eventStore.getSession(id)),
      sourceConversation: (id) => isAvailableTelosSourceConversation(eventStore.getSession(id)),
      resolvePreparation: resolve,
      authorizeSettings: (scope, signal) =>
        authorizeTelosOrdinaryPreparation(scope.settings, signal, connectionId, leadId),
      dispatch: (owner, actor, input, signal) => {
        if (!orchestrator)
          throw new TelosWorkError('conflict', 'Ordinary delegation dispatcher unavailable');
        return orchestrator.delegateSlice(owner, actor, input, signal);
      },
    });
    return explicitOrdinary ? host.delegateOrdinary(request) : host.delegate(request);
  };
  return request.actor.kind === 'operator'
    ? withAgentLibraryRecoveryAuthorization(request.authorization, run)
    : run();
}
async function saveTelosAdvisorDraft(operation: 'preview' | 'save', request: TelosWorkRoleRequest) {
  request.assertAuthorized();
  const work = new TelosWorkStore(telosDatabasePath(), {
    ordinaryConversation: (id) => isAvailableTelosWorkConversation(eventStore.getSession(id)),
    sourceConversation: (id) => isAvailableTelosSourceConversation(eventStore.getSession(id)),
  });
  let artifacts: TelosArtifactStore | undefined;
  try {
    artifacts = new TelosArtifactStore(telosDatabasePath());
    const owner = new TelosWorkAdvisorDraft({
      events: eventStore,
      work,
      artifacts,
      assertAuthorized: request.assertAuthorized,
      authorizeSource: (actor, id) =>
        actor.kind === 'operator' &&
        actor.id === request.actor.id &&
        isAvailableTelosWorkConversation(eventStore.getSession(id)),
      authorizeArtifact: (actor, itemId) =>
        actor.kind === 'operator' &&
        actor.id === request.actor.id &&
        artifacts!.userUploadAllowed(itemId),
    });
    const receipt = await owner[operation](structuredClone(request.raw), request.actor);
    request.assertAuthorized();
    return receipt;
  } finally {
    artifacts?.close();
    work.close();
  }
}
/** Host-only capture capability. No route, scheduler or upload is enabled here. */
export const captureMitzoTelosCoreBackup = bindMitzoTelosCoreCapture({
  events: eventStore,
  tasks: taskStore,
  telosPath: telosDatabasePath,
  knowledge: async () => (await getKnowledgeLibraryRuntime())?.store,
});

app.use(
  '/api/backups',
  createBackupRouter(createHostBackupService(captureMitzoTelosCoreBackup), operatorAuthMiddleware),
);

app.use(createOrdinaryWorkspacePreparationRouter());

app.use(
  createTelosWorkRouter({
    dbPath: telosDatabasePath,
    operatorAuth: operatorAuthMiddleware,
    verifyInternal: verifyInternalToken,
    sessionId: (clientId) => registry.get(clientId)?.sessionId,
    ordinaryConversation: (id) => isAvailableTelosWorkConversation(eventStore.getSession(id)),
    sourceConversation: (id) => isAvailableTelosSourceConversation(eventStore.getSession(id)),
    ordinaryRoleSetup: (request) => setupTelosRole(request, false, true),
    ordinaryRoleSetupReviewed: (request) => setupTelosRole(request, true, true),
    roleSetup: setupTelosRole,
    roleSetupReviewed: (request) => setupTelosRole(request, true),
    delegateSlice: delegateTelosSlice,
    ordinaryDelegateSlice: (request) => delegateTelosSlice(request, true),
    roleContext: (request) => telosRoleHost().context(request),
    roleReview: (request) => telosRoleHost().review(request),
    advisorPreview: (request) => saveTelosAdvisorDraft('preview', request),
    advisorSave: (request) => saveTelosAdvisorDraft('save', request),
    assertRoleAssignment: (itemId, role, conversationId) => {
      const context = resolveTelosWorkRoleContext(
        eventStore,
        conversationId,
        eventStore.getSession(conversationId)?.accountBinding ?? undefined,
      );
      if (context?.itemId !== itemId || context.role !== role)
        throw new TelosWorkError('unauthorized', 'Reviewed ordinary role context required');
    },
  }),
);

app.use(
  createTelosItemRouter({
    dbPath: telosDatabasePath,
    verifyInternal: verifyInternalToken,
    sessionId: (clientId) => registry.get(clientId)?.sessionId,
  }),
);

app.use(
  createTelosSourceRouter({
    verifyInternal: verifyInternalToken,
    sessionId: (clientId) => registry.get(clientId)?.sessionId,
    dbPath: telosDatabasePath,
    events: eventStore,
    operatorAuth: operatorAuthMiddleware,
    ordinaryConversation: (id) => isAvailableTelosWorkConversation(eventStore.getSession(id)),
    sourceConversation: (id) => isAvailableTelosSourceConversation(eventStore.getSession(id)),
    createOutcome: (input, assertCurrentSync) =>
      createCanonicalTelosOutcome(
        {
          script: TODO_SCRIPT,
          timeoutMs: TODO_TIMEOUT_MS,
          maxBufferBytes: TODO_MAX_BUFFER_BYTES,
          execute: (command, args, options) =>
            execFileAsync(command, args, {
              ...options,
              env: { ...process.env, TELOS_DB_PATH: telosDatabasePath() },
            }),
        },
        input,
        assertCurrentSync,
      ),
  }),
);
configureTelosSourcePermissionRecovery(createTelosSourcePermissionRecovery(telosDatabasePath));

app.use(
  createTelosArtifactRouter({
    operatorAuth: operatorAuthMiddleware,
    dbPath: telosDatabasePath,
    verifyInternal: verifyInternalToken,
    sessionId: (clientId) => registry.get(clientId)?.sessionId,
    readFile: async (sessionId, requestedPath) => {
      if (isRemoteSessionArtifact(sessionId))
        return readRemoteSessionArtifact(sessionId, requestedPath);
      const session = registry.findBySessionId(sessionId)?.session;
      const roots = [
        session?.cwd,
        ...[...(session?.worktreePaths?.values() ?? [])].map((entry) => entry.path),
      ].filter((path): path is string => !!path);
      const filePath = resolveArtifactPath(requestedPath, sessionId);
      const root = roots.find((candidate) => containsPath(candidate, filePath));
      if (!root || !isAllowedPath(filePath, sessionId))
        throw new OpenShellArtifactReadError(403, 'Path is outside this session workspace');
      const { stdout } = await execFileAsync(
        'python3',
        ['-I', '-c', OPEN_SHELL_ARTIFACT_HELPER, resolve(root), filePath],
        { timeout: 15_000, maxBuffer: 7 * 1024 * 1024 },
      );
      const result = JSON.parse(stdout);
      if (result.error || result.path !== filePath || typeof result.data !== 'string')
        throw new OpenShellArtifactReadError(
          result.error === 'too_large' ? 413 : 403,
          'Workspace artifact unavailable',
        );
      const bytes = Buffer.from(result.data, 'base64');
      if (bytes.toString('base64') !== result.data)
        throw new OpenShellArtifactReadError(503, 'Invalid workspace artifact');
      return { path: filePath, bytes };
    },
  }),
);

app.post(
  '/api/internal/telos/outcomes',
  createTelosOutcomeHandler({
    verifyInternal: verifyInternalToken,
    sessionId: (clientId) => registry.get(clientId)?.sessionId,
    availableSource: (id) => isAvailableTelosSourceConversation(eventStore.getSession(id)),
  }),
);

// --- Loop orchestrator API ---

app.get('/api/loop/status', (req, res) => {
  if (!orchestrator) {
    res.json({
      state: 'idle',
      goalId: null,
      activeTaskId: null,
      progress: null,
      specMode: false,
      awaitingApproval: false,
      spawnEnabled: false,
    });
    return;
  }
  res.json(orchestrator.getStatus());
});

app.post('/api/loop/spawn', (req, res) => {
  if (!orchestrator) {
    res.status(503).json({ error: 'Orchestrator not initialized' });
    return;
  }
  const { enabled } = req.body ?? {};
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled (boolean) is required' });
    return;
  }
  orchestrator.setSpawnEnabled(enabled);
  res.json(orchestrator.getStatus());
});

app.post('/api/loop/start', (req, res) => {
  const body = LoopStartBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'goalId is required' });
    return;
  }
  if (!orchestrator) {
    res.status(503).json({ error: 'Orchestrator not initialized' });
    return;
  }
  const status = orchestrator.getStatus();
  if (status.state === 'running') {
    res.status(409).json({ error: 'Loop already running' });
    return;
  }
  if (!taskStore.get(body.data.goalId)) {
    res.status(404).json({ error: 'Goal not found' });
    return;
  }
  // Resolve the user-selected conversation to the driver identity used by
  // sendToChat. A WebSocket connection ID is not a session client ID.
  const selectedSession = body.data.sessionId
    ? registry.findBySessionId(body.data.sessionId)
    : undefined;
  if (body.data.sessionId && !selectedSession) {
    res.status(422).json({
      code: 'session_unavailable',
      error: 'The selected chat is not active on this server',
    });
    return;
  }
  const clientId = selectedSession?.clientId ?? body.data.clientId;
  if (clientId && !registry.get(clientId)) {
    res.status(422).json({
      code: 'session_unavailable',
      error: 'The selected chat is not active on this server',
    });
    return;
  }
  if (orchestrator.requiresClientId(body.data.goalId, { ...body.data, clientId })) {
    res.status(422).json({
      code: 'client_id_required',
      error: 'This workflow needs an explicitly selected existing chat',
      requiredField: 'sessionId',
      hint: 'Pass the selected chat sessionId. Dedicated spawn tasks can start without one when spawning is enabled.',
    });
    return;
  }
  try {
    const result = orchestrator.start(body.data.goalId, {
      specMode: body.data.specMode,
      clientId,
    });
    res.json(result);
  } catch {
    res.status(403).json({
      code: 'work_scope_denied',
      error: 'The selected conversation does not authorize this task execution',
    });
  }
});

app.post('/api/loop/pause', (_req, res) => {
  if (!orchestrator) {
    res.status(503).json({ error: 'Orchestrator not initialized' });
    return;
  }
  res.json(orchestrator.pause());
});

app.post('/api/loop/resume', (_req, res) => {
  if (!orchestrator) {
    res.status(503).json({ error: 'Orchestrator not initialized' });
    return;
  }
  res.json(orchestrator.resume());
});

app.post('/api/loop/stop', (_req, res) => {
  if (!orchestrator) {
    res.status(503).json({ error: 'Orchestrator not initialized' });
    return;
  }
  res.json(orchestrator.stop());
});

app.post('/api/tasks/:id/approve', (req, res) => {
  if (!orchestrator) {
    res.status(503).json({ error: 'Orchestrator not initialized' });
    return;
  }
  const ok = orchestrator.approveTask(req.params.id);
  if (!ok) {
    res.status(400).json({ error: 'Task not in pending_review state' });
    return;
  }
  res.json({ ok: true });
});

app.post('/api/tasks/:id/reject', (req, res) => {
  if (!orchestrator) {
    res.status(503).json({ error: 'Orchestrator not initialized' });
    return;
  }
  const ok = orchestrator.rejectTask(req.params.id, req.body.feedback ?? '');
  if (!ok) {
    if (taskStore.get(req.params.id)?.status === 'pending_review') {
      res
        .status(409)
        .json({ error: 'No chat available for retry feedback; review remains pending' });
    } else {
      res.status(400).json({ error: 'Task not in pending_review state' });
    }
    return;
  }
  res.json({ ok: true });
});

app.post('/api/loop/spec/approve', (_req, res) => {
  if (!orchestrator) {
    res.status(503).json({ error: 'Orchestrator not initialized' });
    return;
  }
  res.json(orchestrator.approveSpec());
});

app.post('/api/loop/spec/reject', (_req, res) => {
  if (!orchestrator) {
    res.status(503).json({ error: 'Orchestrator not initialized' });
    return;
  }
  res.json(orchestrator.rejectSpec());
});

// --- Workflow Templates ---

app.get('/api/templates', (_req, res) => {
  if (!templateStore) {
    res.status(503).json({ error: 'Template store not initialized' });
    return;
  }
  res.json(templateStore.list());
});

app.get('/api/templates/:id', (req, res) => {
  if (!templateStore) {
    res.status(503).json({ error: 'Template store not initialized' });
    return;
  }
  const tmpl = templateStore.get(req.params.id);
  if (!tmpl) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  res.json({ template: tmpl });
});

app.post('/api/templates', (req, res) => {
  if (!templateStore) {
    res.status(503).json({ error: 'Template store not initialized' });
    return;
  }
  const body = TemplateCreateBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }
  const tmpl = templateStore.create(body.data as TemplateCreateInput);
  res.status(201).json(tmpl);
});

app.delete('/api/templates/:id', (req, res) => {
  if (!templateStore) {
    res.status(503).json({ error: 'Template store not initialized' });
    return;
  }
  const ok = templateStore.delete(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  res.json({ ok: true });
});

app.post('/api/workflows/instantiate', (req, res) => {
  if (!templateStore) {
    res.status(503).json({ error: 'Template store not initialized' });
    return;
  }
  const body = WorkflowInstantiateBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }
  try {
    const goal = instantiateTemplate(
      taskStore,
      templateStore,
      body.data.templateId,
      body.data.title,
      body.data.variables,
    );
    res.status(201).json({ task: goal });
    onTaskBroadcast?.({ type: 'task_state', tasks: taskStore.getTree() });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

// --- Signal injection ---

app.post('/api/tasks/:id/signal', (req, res) => {
  if (!signalProcessor) {
    res.status(503).json({ error: 'Signal processor not initialized' });
    return;
  }
  const body = SignalBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }
  const task = taskStore.get(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (task.stageType !== 'wait_for_signal') {
    res.status(400).json({ error: 'Task is not a wait_for_signal stage' });
    return;
  }
  if (task.status !== 'active') {
    res.status(400).json({ error: `Task is ${task.status}, not active` });
    return;
  }
  signalProcessor.resolveSignal(req.params.id, {
    status: body.data.status,
    artifacts: body.data.artifacts,
  });
  res.json({ ok: true });
  onTaskBroadcast?.({ type: 'task_state', tasks: taskStore.getTree() });
});

/**
 * Resolve a signal by gate metadata (type + repo/PR).
 * External agents (e.g. Centaur) POST here after completing work —
 * they don't need to know task IDs, just the gate parameters.
 */
app.post('/api/signals/resolve', (req, res) => {
  if (!verifyInternalToken(req)) {
    res.status(401).json({ error: 'Internal token required' });
    return;
  }
  if (!signalProcessor) {
    res.status(503).json({ error: 'Signal processor not initialized' });
    return;
  }
  const body = SignalResolveBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }

  const { type, repo, pr, pr_url, status, artifacts } = body.data;

  // Find active wait_for_signal tasks matching this gate type
  const candidates = taskStore.findActiveSignalTasks(type);
  const matched: string[] = [];

  for (const task of candidates) {
    const gc = task.gateConfig;
    if (!gc) continue;

    const { repo: taskRepo, pr: taskPr, pr_url: taskPrUrl } = gc as Record<string, unknown>;
    // taskPr is parsed from JSON (could be string or number); pr is Zod-validated (number).
    // Coerce both to Number for safe comparison.
    const prMatch = pr != null && taskPr != null && Number(taskPr) === Number(pr);
    let isMatch = false;
    switch (type) {
      case 'centaur_review': {
        if (pr_url && taskPrUrl && taskPrUrl === pr_url) isMatch = true;
        if (repo && taskRepo === repo && prMatch) isMatch = true;
        break;
      }
      case 'gh_ci':
      case 'gh_review': {
        if (repo && taskRepo === repo && prMatch) isMatch = true;
        break;
      }
      case 'human_approval': {
        // human_approval signals match any active task of this gate type.
        // Intentionally broad: for MVP, only one pending human_approval at
        // a time is expected. If multiple concurrent approvals are needed,
        // add a discriminator field (e.g. gate_id) to gateConfig.
        isMatch = true;
        break;
      }
    }

    if (isMatch) {
      signalProcessor.resolveSignal(task.id, { status, artifacts });
      matched.push(task.id);
    }
  }

  res.json({ ok: true, matched });
  if (matched.length > 0) {
    onTaskBroadcast?.({ type: 'task_state', tasks: taskStore.getTree() });
  }
});

app.post(
  '/api/auth/login',
  loginLimiter,
  authenticationRoute(
    async (req, res) => {
      const body = LoginBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'passphrase is required' });
        return;
      }
      const token = await login(body.data.passphrase);
      if (!token) {
        res.status(401).json({ error: 'Invalid passphrase' });
        return;
      }
      res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'strict',
        maxAge: MAX_AGE_HOURS * 60 * 60 * 1000,
      });
      res.json({ ok: true, token });
    },
    { warn: (message) => log.warn(message) },
  ),
);

app.get('/api/auth/check', (_req, res) => {
  // Public correlation only: authentication and revocation retain the actual token.
  const session = res.locals.authSession as import('./auth.js').AuthSession | undefined;
  res.set('Cache-Control', 'private, no-store');
  res.json({ ok: true, ...(session ? { authSessionId: session.id } : {}) });
});

const accountAliases = new AccountAliases(join(BASE_REPO || '.', '.mitzo', 'account-aliases.json'));

app.put('/api/accounts/:id/alias', (req, res) => {
  try {
    const account = loadAccountProfiles()
      .catalog()
      .find((a) => a.id === req.params.id);
    if (!account) {
      res.status(404).json({ error: 'Account unavailable' });
      return;
    }
    accountAliases.set(account.id, req.body.alias);
    res.json({ label: accountAliases.label(account.id, account.label) });
  } catch {
    res
      .status(400)
      .json({ error: 'Cannot save alias. Use at most 80 characters and check storage.' });
  }
});

const subscriptionLogin = createSubscriptionLoginController(
  () => symposiumProductionHost,
  (_req, res) => (res.locals.authSession as AuthSession | undefined)?.id,
);
// Retained owned-host candidate collection; never writes or activates admission.
app.post(
  '/api/symposium/admission-evidence',
  operatorAuthMiddleware,
  ownedEvidenceHandler(() => symposiumProductionHost?.collectAdmissionEvidence),
);
app.post(
  '/api/symposium/sessions/:sessionId/admission-evidence',
  operatorAuthMiddleware,
  sessionOwnedEvidenceHandler(
    () => symposiumProductionHost?.collectSessionAdmissionCandidate,
    (req, res) =>
      sessionEvidenceRequestAuthority(req, res, {
        session: res.locals.authSession as AuthSession | undefined,
        hasSession: (id) =>
          (!custodianOwnerMode || retainedCustodianSessions.has(id)) &&
          eventStore.getSession(id)?.sessionType === 'symposium',
        register: registerAuthSession,
      }),
  ),
);
app.use(
  '/api/symposium/personal/connections',
  createSymposiumPersonalConnectionRouter(() => symposiumProductionHost?.personalConnections),
);
app.get('/api/symposium/personal/login/status', operatorAuthMiddleware, subscriptionLogin.status);
app.post('/api/symposium/personal/login', operatorAuthMiddleware, subscriptionLogin.start);
app.post('/api/symposium/personal/login/cancel', operatorAuthMiddleware, subscriptionLogin.cancel);

// Reads the dedicated host catalog (including its cached model discovery); no refresh or legacy fallback.
app.get('/api/symposium/accounts', (_req, res) => {
  try {
    if (!symposiumProductionHost) throw new Error('Symposium host is unavailable');
    res.json(symposiumProductionHost.currentProfiles().catalog());
  } catch {
    res.status(503).json({ error: 'Symposium account catalog unavailable.' });
  }
});

app.use(
  '/api/connections-access',
  operatorAuthMiddleware,
  createConnectionsAccessRouter((auth) => {
    const runtime = getConnectionsRuntime();
    const keychain = getCredentialConnectionsRuntime();
    return {
      ...(keychain ? { keychain: () => keychain.catalog() } : {}),
      accounts: async (signal: AbortSignal) => {
        const profiles = loadAccountProfiles();
        await profiles.checkSignIn(signal);
        return profiles.catalog().map((account) => {
          // Missing history must not hide otherwise available accounts.
          let lastSuccessfulUse;
          try {
            lastSuccessfulUse = getAccountUseStore().latest(
              profiles.resolve(account.id, account.models[0].id),
              account.models.map((model) => model.id),
            );
          } catch {
            /* History is best effort; it is not an access check. */
          }
          return {
            ...account,
            label: accountAliases.label(account.id, account.label),
            lastSuccessfulUse,
          };
        });
      },
      ...(runtime
        ? {
            canManageOpenAIKey: (accountId: string) =>
              runtime.openAIKeys?.manages(accountId) ?? false,
            managed: () =>
              runtime.store.list('operator').map((connection) => ({
                ...connection,
                capabilityGrants: runtime.capabilityStore.grants(connection.id),
                publishingEnabled: runtime.githubPublishEnabled,
              })),
            legacy: runtime.legacyProviders,
            gateway: runtime.gateway,
            workspace: runtime.workspace,
            ...(runtime.googleWorkspace
              ? { google: (signal: AbortSignal) => runtime.googleWorkspace!.status(signal) }
              : {}),
          }
        : {}),
      symposiumAccounts: symposiumAccountsInventorySource(
        auth,
        custodianControllerClient,
        symposiumProductionHost
          ? () => symposiumProductionHost!.currentProfiles().catalog()
          : undefined,
      ),
      personal: personalInventorySource(
        auth,
        custodianControllerClient,
        symposiumProductionHost?.personalConnections
          ? () => symposiumProductionHost!.personalConnections!.list()
          : undefined,
      ),
    };
  }),
);

app.get('/api/accounts', async (req, res) => {
  try {
    const profiles = loadAccountProfiles();
    await profiles.refresh(req.query.refresh === '1');
    res.json(profiles.catalog().map((a) => ({ ...a, label: accountAliases.label(a.id, a.label) })));
  } catch {
    res
      .status(503)
      .json({ error: 'Account configuration unavailable. Check the profile file on the Mac.' });
  }
});

app.get('/api/models', (_req, res) => {
  try {
    const profiles = process.env.MITZO_ACCOUNT_PROFILES_FILE ? loadAccountProfiles() : undefined;
    // Legacy sessions inherit routing overrides that explicit account sessions strip.
    // Only apply a profile allowlist when the process route is unambiguous.
    const matchesDefaultVertexRoute =
      (process.env.CLAUDE_CODE_USE_VERTEX || '1') === '1' &&
      !Object.entries(process.env).some(
        ([key, value]) =>
          value &&
          (key.startsWith('VERTEX_REGION_') ||
            ((key.startsWith('CLAUDE_CODE_SKIP_') ||
              (key.startsWith('CLAUDE_CODE_USE_') && key !== 'CLAUDE_CODE_USE_VERTEX')) &&
              value !== '0' &&
              value !== 'false') ||
            [
              'ANTHROPIC_BASE_URL',
              'ANTHROPIC_VERTEX_BASE_URL',
              'ANTHROPIC_AUTH_TOKEN',
              'ANTHROPIC_API_KEY',
            ].includes(key) ||
            key === 'GOOGLE_API_KEY' ||
            key === 'CLAUDE_CODE_OAUTH_TOKEN'),
      );
    const models =
      profiles && matchesDefaultVertexRoute
        ? (profiles.legacyModels(
            process.env.ANTHROPIC_VERTEX_PROJECT_ID,
            process.env.CLOUD_ML_REGION || 'us-east5',
            process.env.GOOGLE_APPLICATION_CREDENTIALS,
          ) ?? AVAILABLE_MODELS)
        : AVAILABLE_MODELS;
    res.json(models);
  } catch {
    res
      .status(503)
      .json({ error: 'Model configuration unavailable. Check the profile file on the Mac.' });
  }
});

app.use(
  '/api/repository-workspaces',
  createRepositoryWorkspaceRouter({
    resolveBinding: repositoryWorkspaceBinding,
    catalog: repositoryWorkspaceCatalog,
    selectLocal: (binding, repositoryId, runtime, signal, requestId) =>
      getLocalRepositoryWorkspaces().selectLocalRepository(
        binding,
        repositoryId,
        runtime,
        signal,
        requestId,
      ),
    chatPreparation: (id) => {
      const service = getRepositoryWorkspaces(true);
      const record = service.get(id);
      const binding = repositoryWorkspaceBinding(record.binding.accountId, record.binding.model);
      return { repositoryChat: service.chatPreparation(id, binding) };
    },
    preview: (binding, connectionId, repository, signal, ordinaryRuntime, requestId) =>
      getRepositoryWorkspaces().preview(
        binding,
        connectionId,
        repository,
        signal,
        ordinaryRuntime,
        requestId,
      ),
    prepare: (id, binding, signal) => getRepositoryWorkspaces().prepare(id, binding, signal),
    status: (id, binding) => getRepositoryWorkspaces(true).qualifiedStatus(id, binding),
    discard: (id, binding) => getRepositoryWorkspaces(true).discard(id, binding),
  }),
);

app.get('/api/config', (_req, res) => {
  const config = getRepoConfig();
  const actions = config.quickActions.map((a) => ({
    ...a,
    cwd: a.cwd ? join(BASE_REPO, a.cwd) : undefined,
  }));
  const contextBlocks: Record<string, { path: string; sizeBytes: number }> = {};
  for (const [name, path] of Object.entries(config.contextBlocks)) {
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(path).size;
    } catch {
      // File may not exist yet — show 0 size
    }
    contextBlocks[name] = { path, sizeBytes };
  }
  const fileViewerRoots =
    config.roots.length > 0 ? config.roots : [{ label: 'Root', path: BASE_REPO }];
  res.json({
    repoPath: BASE_REPO,
    mcpServers: getMcpServerNames(),
    quickActions: actions,
    contextBlocks,
    fileViewerRoots,
  });
});

app.get('/api/skills', (req, res) => {
  const cwd = (req.query.cwd as string) || BASE_REPO;
  if (cwd && !isAllowedPath(cwd)) {
    res.status(403).json({ error: 'Path not allowed' });
    return;
  }
  const skillRegistry = buildSkillRegistry(cwd);
  res.json(skillRegistry.listPublic());
});

app.get('/api/commands', (_req, res) => {
  const descriptions: Record<string, string> = {
    skills: 'List skills, or inspect a named skill',
    models: 'List account models; accepts “refresh”',
    deliberate: 'Deliberate on a task using multiple models; may incur model charges',
    fuse: 'Combine model perspectives on a task; may incur model charges',
  };
  res.json(
    [...NATIVE_COMMAND_NAMES].map((name) => ({
      name,
      description: descriptions[name] ?? name,
      scope: 'native',
    })),
  );
});

app.get('/api/sessions/active', (_req, res) => {
  res.json(registry.getActiveSessions());
});

app.get('/api/sessions/search', (req, res) => {
  const q = (req.query.q as string) || '';
  const limit = Math.min(Math.max(1, parseInt(req.query.limit as string) || 20), 50);
  if (!q.trim()) {
    res.json({ results: [] });
    return;
  }
  try {
    const results = eventStore.searchSessions(q, limit);
    res.json({ results });
  } catch (err: unknown) {
    log.error('GET /api/sessions/search failed', { error: err });
    res.status(500).json({ error: 'Search failed' });
  }
});

app.use(
  '/api/sessions',
  createSdkConversationImportRouter({
    list: () => listImportableSdkConversations(),
    adopt: (id) => importSdkConversation(id),
  }),
);

app.get('/api/sessions', async (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const limit = Math.min(Math.max(1, parseInt(req.query.limit as string) || 20), 100);
  const full = req.query.full === '1';

  /** Annotate raw session list with live-status and token metadata. */
  function annotate(sessions: Array<{ id: string; [k: string]: unknown }>) {
    const activeMap = new Map<string, { attached: boolean }>();
    for (const s of registry.getActiveSessions()) {
      if (s.sessionId) activeMap.set(s.sessionId, { attached: s.attached });
    }
    return sessions.map((s) => {
      const live = activeMap.get(s.id);
      const meta = eventStore.getSession(s.id);
      return {
        ...s,
        isActive: !!live,
        isAttached: live?.attached ?? false,
        totalTokens: meta
          ? meta.inputTokens + meta.outputTokens + meta.cacheReadTokens + meta.cacheCreationTokens
          : undefined,
        ...sessionListMetadata(meta ?? {}, eventStore.getLatestEvent(s.id, 'token_update')),
        numTurns: meta?.numTurns,
        closedBy: meta?.closedBy ?? undefined,
      };
    });
  }

  try {
    if (!full) {
      // Fast path: serve from EventStore (SQLite, <1ms)
      const { sessions, hasMore } = getSessionsCached(offset, limit);
      res.json({ sessions: annotate(sessions), hasMore });

      // Background: reconcile with filesystem so EventStore stays fresh
      if (offset === 0) reconcileSessionsBackground();
      return;
    }

    // Full path: filesystem scan (original behavior, for ?full=1)
    const { sessions, hasMore } = await getSessions(offset, limit);
    res.json({ sessions: annotate(sessions), hasMore });
  } catch (err) {
    log.error('GET /api/sessions failed', { error: err });
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// Pinned Today sessions need their own read-only observation, beyond the recent page.
app.get('/api/sessions/:id/context', (req, res) => {
  const meta = eventStore.getSession(req.params.id);
  if (!meta || meta.isHidden) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const { contextUsage } = sessionListMetadata(
    meta,
    eventStore.getLatestEvent(meta.sessionId, 'token_update'),
  );
  res.json({ sessionId: meta.sessionId, contextUsage: contextUsage ?? null });
});

app.get(
  '/api/sessions/:id/messages',
  createSessionMessagesHandler({
    getDurableSessionTranscript: (sessionId) => eventStore.getDurableSessionTranscript(sessionId),
    getMessages: (sessionId) => getMessages(sessionId),
    getSessionTranscript: (sessionId) => getSessionTranscript(sessionId),
    getReconnectTranscript: (sessionId, cursor) => getReconnectTranscript(sessionId, cursor),
  }),
);

app.use(
  '/api/session-collaborations',
  operatorAuthMiddleware,
  createSessionCollaborationRouter({
    store: eventStore,
    review: () =>
      new CollaborationApplicationReview({
        store: eventStore,
        workspaces: getRepositoryWorkspaces(true),
      }),
  }),
);

app.use(
  '/api/sessions/:id/outputs',
  operatorAuthMiddleware,
  createSessionOutputRouter({
    references: new SessionOutputReferences(eventStore),
    hasSession: (id) => Boolean(eventStore.getSession(id)),
  }),
);

const outputContributors = createOutputContributors({
  store: eventStore,
  databasePath: join(process.env.REPO_PATH || '.', '.mitzo', 'events.db'),
  currentAccounts: loadAccountProfiles,
  port: {
    startChat: (transport, clientId, prompt, options) =>
      startChat(transport, clientId, prompt, options),
    stopChat: (clientId) => stopChat(clientId),
  },
  workspaceForSession: (id) => {
    const source = eventStore.getSession(id);
    if (!source || source.sessionType === 'symposium' || source.isHidden) return null;
    const cwd = registry.findBySessionId(id)?.session.cwd ?? source.cwd;
    try {
      return cwd && isAllowedPath(cwd, id) && statSync(cwd).isDirectory() ? { cwd } : null;
    } catch {
      return null;
    }
  },
  resolveProfile: readAgentLibraryProfile,
});
app.use(
  '/api/sessions/:id/contributors',
  operatorAuthMiddleware,
  createOutputContributorRouter({
    service: outputContributors,
    hasSession: (id) => Boolean(eventStore.getSession(id)),
  }),
);

app.use(
  '/api/sessions',
  createSessionRemovalRouter({
    authorize: operatorAuthMiddleware,
    lifecycle: () => openShellLifecycleService,
    previewLegacy: (id, signal) =>
      previewLegacyOpenShellDeletion(id, eventStore, getCodexConversationStore(), signal),
    hasSandbox: (id) => {
      const meta = eventStore.getSession(id);
      return sessionNeedsSandboxReview(meta, {
        runtimeLocation:
          registry.findBySessionId(id)?.session.ordinaryRuntimeOwner?.location ??
          (meta ? eventStore.getSessionRuntimeBinding(id)?.execution.location : undefined),
        legacyOpenShellConfigured:
          !!process.env.MITZO_OPENSHELL_SANDBOX_NAME || process.env.MITZO_OPENSHELL_ENABLED === '1',
      });
    },
    hide: hideSession,
    changed: (id) => {
      clearPublicationControllerSessionGrants(registry, id);
      overviewEmitter?.scheduleBroadcast();
      sseRegistry.broadcast('sessions_changed', {});
    },
  }),
);

app.use(
  '/api/sessions/:id/access',
  operatorAuthMiddleware,
  createSessionAccessRouter({
    hasSession: (id) => {
      const meta = eventStore.getSession(id);
      return Boolean(
        meta && !meta.isHidden && meta.sessionType !== 'symposium' && !meta.symposiumConfig,
      );
    },
    read: (id) =>
      projectSessionAccess(
        id,
        registry.findBySessionId(id)?.session,
        getPendingRequestsBySession(id),
        undefined,
        { binding: eventStore.getSessionRuntimeBinding(id) },
      ),
  }),
);

app.get('/api/sessions/:id/meta', async (req, res) => {
  const meta = eventStore.getSession(req.params.id);
  if (!meta) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const continuationStatus = ordinaryCodexContinuationStatus(
    meta.sessionId,
    res.locals.authSession?.id,
  );
  let routingMetadata: ReturnType<typeof ownedLocalCodexMetadata>;
  try {
    routingMetadata = ownedLocalCodexMetadata(
      eventStore,
      meta.sessionId,
      continuationStatus.available,
    );
  } catch {
    res.status(409).json({
      error:
        'The original conversation workspace identity is unavailable. Preserve this conversation and recover its original settings.',
    });
    return;
  }
  const runtimeMetadata = {
    ...routingMetadata,
    ...(continuationStatus.reason ? { runtimeCommandReason: continuationStatus.reason } : {}),
    ...(meta.accountBinding?.provider === 'google-vertex' &&
    eventStore.getSessionRuntimeBinding(meta.sessionId)?.harness.implementation === 'gemini'
      ? {
          runtimeNativeConstraint: readOwnedNativeContinuationConstraint(
            getNativeResponsesStore(),
            meta.sessionId,
            meta.accountBinding,
          ),
        }
      : {}),
  };
  const lastAdmittedSelection = eventStore.getLatestOrdinaryCommandAdmission?.(
    meta.sessionId,
  )?.selection;
  const totalTokens =
    meta.inputTokens + meta.outputTokens + meta.cacheReadTokens + meta.cacheCreationTokens;
  const symposiumConfigured = Boolean(meta.symposiumConfig);
  const codexBacked =
    !symposiumConfigured &&
    (meta.accountBinding?.provider === 'openai-codex' ||
      (meta.accountBinding?.provider === 'openai' &&
        !!meta.cwd?.startsWith('/sandbox/workspaces/')));
  const responsesBacked = ['responses', 'gemini'].includes(
    eventStore.getSessionRuntimeBinding(meta.sessionId)?.harness.implementation ?? '',
  );
  const vertexBacked =
    eventStore.getSessionRuntimeBinding(meta.sessionId)?.harness.implementation === 'claude-sdk';
  const codexQueue = vertexBacked
    ? readOwnedVertexQueue(
        eventStore,
        meta.sessionId,
        !!registry.findBySessionId(meta.sessionId)?.session.ordinaryRuntimeOwner,
      )
    : responsesBacked && meta.accountBinding
      ? readOwnedResponsesQueue(
          eventStore,
          getNativeResponsesStore(),
          meta.sessionId,
          meta.accountBinding,
          !!registry.findBySessionId(meta.sessionId)?.session.ordinaryRuntimeOwner,
          !!res.locals.authSession &&
            canResumeOwnedLocalResponsesDriver(meta.sessionId, res.locals.authSession.id),
        )
      : codexBacked && meta.accountBinding
        ? readCodexQueue(
            meta.sessionId,
            meta.accountBinding,
            registry.findBySessionId(meta.sessionId)?.session,
          )
        : undefined;
  let modelSelection:
    | {
        model: string;
        reasoningEffort?: string | null;
        models: Array<{
          id: string;
          label: string;
          reasoningEfforts?: string[];
          defaultReasoningEffort?: string;
        }>;
      }
    | undefined;
  if (meta.accountBinding && !symposiumConfigured) {
    const retainedModel =
      lastAdmittedSelection?.model ??
      meta.selectedModel ??
      codexQueue?.model ??
      meta.accountBinding.model;
    const retainedThinking = lastAdmittedSelection
      ? lastAdmittedSelection.thinking
      : (meta.reasoningEffort ?? codexQueue?.reasoningEffort ?? null);
    if (retainedModel)
      modelSelection = { model: retainedModel, reasoningEffort: retainedThinking, models: [] };
    try {
      const profiles = loadAccountProfiles();
      const refresh = req.query.refresh === '1';
      await profiles.refresh(refresh, { discoverApi: refresh });
      const profile = profiles
        .catalog()
        .find((account) => account.id === meta.accountBinding!.accountId);
      const defaultModel = profile?.models[0];
      if (profile && defaultModel)
        modelSelection = {
          model: retainedModel ?? defaultModel.id,
          models: profile.models,
          reasoningEffort: retainedThinking,
        };
    } catch {
      // Keep metadata available when the optional account catalog is temporarily unreadable.
    }
  }
  let telosWorkRoleContext: ReturnType<typeof resolveTelosWorkRoleContext>;
  let telosWorkRolePresentation: ReturnType<typeof resolveTelosWorkRolePresentation>;
  try {
    telosWorkRoleContext = resolveTelosWorkRoleContext(
      eventStore,
      meta.sessionId,
      meta.accountBinding ?? undefined,
    );
    telosWorkRolePresentation = resolveTelosWorkRolePresentation(
      eventStore,
      meta.sessionId,
      meta.accountBinding ?? undefined,
    );
  } catch {
    res.status(503).json({ error: 'Work conversation context unavailable' });
    return;
  }
  let repositoryContext: { workspaceId: string; repository: string } | undefined;
  if (
    meta.sessionId === req.params.id &&
    typeof meta.repositoryWorkspaceId === 'string' &&
    /^\S{1,200}$/.test(meta.repositoryWorkspaceId) &&
    meta.accountBinding
  ) {
    try {
      const current = eventStore.getSession(meta.sessionId);
      const workspace = getRepositoryWorkspaces(true).get(meta.repositoryWorkspaceId);
      if (
        current?.repositoryWorkspaceId === meta.repositoryWorkspaceId &&
        isDeepStrictEqual(current.accountBinding, meta.accountBinding) &&
        workspace.id === meta.repositoryWorkspaceId &&
        workspace.state === 'claimed' &&
        workspace.conversationId === meta.sessionId &&
        isDeepStrictEqual(workspace.binding, meta.accountBinding) &&
        typeof workspace.repository === 'string' &&
        workspace.repository.length <= 201 &&
        canonicalRepositorySelection(workspace.repository) === workspace.repository
      )
        repositoryContext = {
          workspaceId: workspace.id,
          repository: workspace.repository,
        };
    } catch {
      // Repository presentation is optional; preserve ordinary metadata on read failure.
    }
  }
  const preparedController = new AbortController();
  const abortPreparedStatus = () => preparedController.abort();
  res.once('close', abortPreparedStatus);
  let preparedWork: TelosWorkStore | undefined;
  let preparedStatus: Awaited<ReturnType<typeof ordinaryWorkspacePreparedCommandStatus>>;
  try {
    preparedStatus = await (
      meta.repositoryWorkspaceId
        ? repositoryPreparedCommandStatus
        : ordinaryWorkspacePreparedCommandStatus
    )({
      events: eventStore,
      workspaces: () =>
        meta.repositoryWorkspaceId ? getRepositoryWorkspaces(true) : getOrdinaryWorkspaces(true),
      sessionId: meta.sessionId,
      signal: preparedController.signal,
      assertCurrent: () => {
        const auth = res.locals.authSession;
        if (
          !auth ||
          !hasPersistentRevocationAuthority() ||
          !isAuthSessionCurrent(auth) ||
          custodianControllerClient ||
          custodianOwnerMode ||
          (eventStore.getSessionRuntimeBinding(meta.sessionId)?.execution.location === 'openshell'
            ? process.env.MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED
            : process.env.MITZO_ORDINARY_LOCAL_CODEX_ENABLED) !== '1'
        )
          throw Error('Current ordinary operator unavailable');
        resolveTelosWorkCommandScope(
          {
            events: eventStore,
            tasks: taskStore,
            work: () =>
              (preparedWork ??= new TelosWorkStore(telosDatabasePath(), {
                ordinaryConversation: (id) =>
                  isAvailableTelosWorkConversation(eventStore.getSession(id)),
              })),
          },
          meta.sessionId,
          eventStore.getSession(meta.sessionId)?.accountBinding ?? undefined,
        );
      },
    });
  } finally {
    preparedWork?.close();
    res.removeListener('close', abortPreparedStatus);
  }
  if (res.destroyed) return;
  res.json({
    sessionId: meta.sessionId,
    ...(Number.isSafeInteger(meta.createdAt) &&
    meta.createdAt >= 0 &&
    Number.isFinite(new Date(meta.createdAt).getTime())
      ? { createdAt: meta.createdAt }
      : {}),
    ...(repositoryContext ? { repositoryContext } : {}),
    ...(telosWorkRoleContext ? { telosWorkRoleContext } : {}),
    ...(telosWorkRolePresentation ? { telosWorkRolePresentation } : {}),
    ...runtimeMetadata,
    ...(preparedStatus.prepared
      ? { runtimeCommandScope: 'prepared-first-command', runtimeCommandReason: undefined }
      : preparedStatus.reason
        ? { runtimeCommandScope: 'first-command-only', runtimeCommandReason: preparedStatus.reason }
        : {}),
    ...(meta.agentProfile ? { agentProfile: meta.agentProfile } : {}),
    sessionType: symposiumConfigured ? 'symposium' : meta.sessionType,
    branch: meta.branch,
    wtId: meta.wtId,
    cwd: meta.cwd,
    repositoryWorkspaceId: meta.repositoryWorkspaceId,
    ordinaryWorkspaceId: meta.ordinaryWorkspaceId,
    mode: meta.mode,
    isActive: meta.isActive,
    // Optional catalog refresh may yield while this conversation is deleted.
    isHidden: eventStore.getSession(meta.sessionId)?.isHidden ?? true,
    state: meta.state,
    totalTokens,
    ...(meta.accountBinding
      ? {
          accountBinding: {
            ...meta.accountBinding,
            accountLabel: accountAliases.label(
              meta.accountBinding.accountId,
              meta.accountBinding.accountLabel,
            ),
          },
        }
      : {}),
    ...(modelSelection ? { modelSelection } : {}),
    ...(codexBacked || responsesBacked ? { codexQueue } : {}),
    totalCostUsd: meta.totalCostUsd,
    numTurns: meta.numTurns,
  });
});

async function reattachCodexQueue(
  id: string,
  binding: AccountBinding,
  authorization?: AuthSession,
  waitForReady = false,
  deadline = Date.now() + CAPACITY_REATTACH_READY_TIMEOUT_MS,
): Promise<'ready' | 'reattaching' | 'unavailable'> {
  if (
    ['responses', 'gemini'].includes(
      eventStore.getSessionRuntimeBinding(id)?.harness.implementation ?? '',
    )
  )
    return 'unavailable';
  const existing = registry.findBySessionId(id)?.session;
  // Bound cold continuation must reacquire its original owning route through runtime admission.
  if (eventStore.getSessionRuntimeBinding(id) && !existing?.ordinaryRuntimeOwner)
    return 'unavailable';
  if (existing && getCodexRuntime(existing)) return 'ready';
  const meta = eventStore.getSession(id);
  if (!meta) return 'unavailable';
  if (!existing && !codexReattachments.has(id)) {
    const operation = withAgentLibraryRecoveryAuthorization(authorization, (operatorConnectionId) =>
      startChat(new NullTransport(), `provider-recovery:${id}`, '', {
        resume: id,
        accountId: binding.accountId,
        model: meta.selectedModel ?? binding.model,
        reasoningEffort: meta.reasoningEffort,
        agentName: meta.agentName ?? undefined,
        reattachOnly: true,
        operatorConnectionId,
      }),
    )
      .then(() => undefined)
      .catch((error: unknown) => {
        log.warn('provider reattachment failed', {
          sessionId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => codexReattachments.delete(id));
    codexReattachments.set(id, operation);
  }
  const runtime = await waitForReattachedCodexRuntime(
    waitForReady ? codexReattachments.get(id) : undefined,
    async (signal) =>
      !!(await waitForCodexRuntimeBySessionId(
        registry,
        id,
        waitForReady ? Math.max(0, deadline - Date.now()) : 1000,
        signal,
      )),
  );
  return runtime ? 'ready' : codexReattachments.has(id) ? 'reattaching' : 'unavailable';
}

function assertQueueOperator(id: string, authorization?: import('./auth.js').AuthSession) {
  assertOwnedCodexQueueControl(
    {
      runtimeBinding: (sessionId) => eventStore.getSessionRuntimeBinding(sessionId),
      accountBinding: (sessionId) => eventStore.getSession(sessionId)?.accountBinding,
      custody: (sessionId, account, binding) => {
        if (
          binding.harness.implementation === 'claude-sdk' &&
          binding.execution.location === 'local'
        )
          return eventStore.getOrdinaryLocalVertexCustody(sessionId);
        if (
          ['responses', 'gemini'].includes(binding.harness.implementation) &&
          binding.execution.location === 'local'
        )
          return getNativeResponsesStore().readOrdinaryCustody(sessionId, account);
        if (binding.harness.implementation !== 'codex') throw Error('Queue owner unavailable');
        const native = getCodexConversationStore();
        return binding.execution.location === 'local'
          ? native.readHostCustody(sessionId, account)
          : native.readOpenShellCustody(sessionId, account);
      },
    },
    id,
    authorization,
  );
}

app.use(
  '/api/sessions',
  createCodexQueueRouter({
    authorizeMutation: assertQueueOperator,
    binding(sessionId) {
      const meta = eventStore.getSession(sessionId);
      const binding = meta?.accountBinding;
      return binding &&
        (['responses', 'claude-sdk', 'gemini'].includes(
          eventStore.getSessionRuntimeBinding(sessionId)?.harness.implementation ?? '',
        ) ||
          binding.provider === 'openai-codex' ||
          (binding.provider === 'openai' && !!meta?.cwd?.startsWith('/sandbox/workspaces/')))
        ? binding
        : undefined;
    },
    overview: (id, binding) =>
      eventStore.getSessionRuntimeBinding(id)?.harness.implementation === 'claude-sdk'
        ? readOwnedVertexQueueOverview(eventStore, id)
        : ['responses', 'gemini'].includes(
              eventStore.getSessionRuntimeBinding(id)?.harness.implementation ?? '',
            )
          ? readOwnedResponsesQueueOverview(eventStore, getNativeResponsesStore(), id, binding)
          : readCodexQueueOverview(id, binding),
    cancel: (id, binding, commandId, authorization) =>
      eventStore.getSessionRuntimeBinding(id)?.harness.implementation === 'claude-sdk'
        ? cancelOwnedVertexQueuedCommand(eventStore, id, commandId, authorization)
        : ['responses', 'gemini'].includes(
              eventStore.getSessionRuntimeBinding(id)?.harness.implementation ?? '',
            )
          ? cancelOwnedResponsesQueuedCommand(
              eventStore,
              getNativeResponsesStore(),
              id,
              binding,
              commandId,
              authorization,
            )
          : cancelCodexQueuedCommand(id, binding, commandId, registry.findBySessionId(id)?.session),
    retry: async (id, _binding, confirmAmbiguous) => {
      const session = registry.findBySessionId(id)?.session;
      const runtime = session ? getCodexRuntime(session) : undefined;
      return runtime ? runtime.retryLatestFailed(confirmAmbiguous) : 'unavailable';
    },
    capacityRetry: (id, binding, recoveryId, sourceCommandId, authorization) => {
      const deadline = Date.now() + CAPACITY_REATTACH_READY_TIMEOUT_MS;
      return retryCapacityAfterReattachment(
        { recoveryId, sourceCommandId },
        {
          read: () => readCodexCapacityRecovery(id, binding),
          reattach: () => reattachCodexQueue(id, binding, authorization, true, deadline),
          retry: async () => {
            const session = registry.findBySessionId(id)?.session;
            const runtime = session ? getCodexRuntime(session) : undefined;
            return runtime
              ? runtime.tryCapacityNow(recoveryId, sourceCommandId, deadline)
              : 'unavailable';
          },
        },
      );
    },
    capacityStop: (id, binding, recoveryId, sourceCommandId) =>
      stopCodexCapacityRecovery(
        id,
        binding,
        recoveryId,
        sourceCommandId,
        registry.findBySessionId(id)?.session,
      ),
    reattach: (id, binding, authorization) => reattachCodexQueue(id, binding, authorization),
  }),
);

app.post('/api/sessions/:id/codex-queue/continue', async (req, res) => {
  const sessionId = req.params.id;
  try {
    assertQueueOperator(sessionId, res.locals.authSession);
  } catch {
    res
      .status(403)
      .json({ error: 'Use the original sign-in to manage this conversation’s queue.' });
    return;
  }
  if (
    ['responses', 'gemini'].includes(
      eventStore.getSessionRuntimeBinding(sessionId)?.harness.implementation ?? '',
    )
  ) {
    try {
      await continueOwnedLocalResponsesQueue(
        sessionId,
        res.locals.authSession,
        typeof req.headers['x-connection-id'] === 'string'
          ? req.headers['x-connection-id']
          : undefined,
      );
      res.json({ ok: true });
    } catch {
      res.status(409).json({
        error:
          'Saved work could not reconnect. Check the original sign-in, account, settings and prior outcome before trying again.',
      });
    }
    return;
  }
  const live = registry.findBySessionId(sessionId);
  const recentSend = eventStore.hasRecentSendCommandForSession(sessionId, Date.now() - 10_000);
  if (!live && !recentSend) {
    res
      .status(409)
      .json({ error: 'Send a message to reconnect this task before continuing its queue.' });
    return;
  }
  const cancelled = new AbortController();
  const cancel = () => cancelled.abort();
  req.once('aborted', cancel);
  res.once('close', cancel);
  const runtime = await waitForCodexRuntimeBySessionId(registry, sessionId, 5000, cancelled.signal);
  req.off('aborted', cancel);
  res.off('close', cancel);
  if (cancelled.signal.aborted || res.destroyed) return;
  if (!runtime) {
    res
      .status(409)
      .json({ error: 'Send a message to reconnect this task before continuing its queue.' });
    return;
  }
  try {
    assertQueueOperator(sessionId, res.locals.authSession);
    await runtime.acknowledgeRecovery();
    res.json({ ok: true });
  } catch {
    res
      .status(409)
      .json({ error: 'Cannot continue this queue. Check account configuration and connection.' });
  }
});

app.get('/api/sessions/:id/events', (req, res) => {
  const afterSeq = parseInt(req.query.after as string, 10);
  if (isNaN(afterSeq)) {
    res.status(400).json({ error: 'after query parameter is required (number)' });
    return;
  }
  if (!eventStore.getSession(req.params.id)) {
    res.status(404).json({ error: 'Conversation not registered' });
    return;
  }
  const events = eventStore.getEventsAfter(req.params.id, afterSeq);
  res.json(events.map(storedEventToClientMessage));
});

app.get('/api/sessions/:id/compactions', (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  if (!eventStore.getSession(req.params.id))
    return res.status(404).json({ error: 'Conversation not registered' });
  const events = eventStore.getEventsOfType(req.params.id, 'context_compaction', 513);
  res.json({
    records: projectCompactions(events.slice(0, 512).reverse()),
    truncated: events.length > 512,
  });
});

app.delete('/api/sessions', (_req, res) => {
  hideAllSessions();
  clearPublicationControllerSessionGrants(registry);
  overviewEmitter?.scheduleBroadcast();
  sseRegistry.broadcast('sessions_changed', {});
  res.json({ ok: true });
});

app.put('/api/sessions/:id/rename', async (req, res) => {
  const { title } = req.body || {};
  if (!title || typeof title !== 'string') {
    res.status(400).json({ error: 'title is required' });
    return;
  }
  try {
    await renameSessionById(req.params.id, title.slice(0, 200));
    sseRegistry.broadcast('sessions_changed', {});
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Session not found' });
  }
});

app.get('/api/worktrees', (_req, res) => {
  const worktrees = listWorktrees(BASE_REPO).map((wt) => ({ ...wt, repo: 'primary' }));
  for (const [name, repoPath] of Object.entries(getRepoConfig().repos)) {
    try {
      const repoWts = listWorktrees(repoPath).map((wt) => ({ ...wt, repo: name }));
      worktrees.push(...repoWts);
    } catch {
      // Repo path may not exist yet
    }
  }
  res.json(worktrees);
});

// --- File viewer API ---

const privatePathSnapshot = createCodexPathProtection(() =>
  loadAccountProfiles().privateCodexRoots(),
);
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

function isRemoteSessionArtifact(sessionId: string) {
  const meta = eventStore.getSession(sessionId);
  // Ordinary identity covers both host and sandbox workspaces. Its retained
  // runtime binding selects the reader; custody validation still owns access.
  if (hasOrdinaryWorkspaceArtifactScope(eventStore, sessionId)) {
    const runtime = eventStore.getSessionRuntimeBinding(sessionId);
    return runtime?.version === 2 && runtime.execution.location === 'openshell';
  }
  if (!meta?.accountBinding)
    return Boolean(meta?.cwd?.startsWith('/sandbox/') && !isConfiguredAllowedPath(meta.cwd));
  if (!['openai', 'openai-codex'].includes(meta.accountBinding.provider)) return false;
  try {
    if (getCodexConversationStore().readArtifactRuntime(sessionId, meta.accountBinding))
      return true;
  } catch {
    /* Host API sessions do not have Codex conversation rows. */
  }
  // An OpenAI binding does not establish that an unknown workspace is local.
  // Only a recorded absolute cwd within the configured host roots can use
  // host filesystem resolution when no sandbox receipt exists.
  return !meta.cwd || !isAbsolute(meta.cwd) || !isConfiguredAllowedPath(meta.cwd);
}

async function readRemoteSessionArtifact(
  sessionId: string,
  requestedPath: string,
  edit?: { content: string; expectedContent: string },
) {
  const meta = eventStore.getSession(sessionId);
  if (!meta?.accountBinding || !meta.cwd)
    throw new SessionArtifactUnavailableError(
      'This conversation’s workspace metadata is unavailable. Resume this conversation once, then try again.',
    );
  const config = openShellRuntimeConfig(process.env);
  const reader = createSessionArtifactReader({
    readRuntime: (id, binding) => getCodexConversationStore().readArtifactRuntime(id, binding),
    currentRoute: (binding) => {
      const profiles = loadAccountProfiles();
      const model = meta.selectedModel ?? binding.model;
      if (binding.provider === 'openai') {
        const profile = profiles.apiProfile(binding);
        if (!profile.sandboxProvider) throw Error('Sandbox provider unavailable');
        return { kind: 'api', provider: profile.sandboxProvider, model };
      }
      return selectedOpenShellAccountRoute({
        binding,
        model,
        profile: profiles.codexProfile(binding),
      });
    },
    validateRuntime: (runtime) => validateSessionArtifactRuntime(runtime, config),
    inspect: (id, runtime, route, signal) => {
      if (!config) throw Error('Sandbox runtime unavailable');
      return new OpenShellRuntimeManager({ ...config, account: route }).inspect(
        id,
        runtime.sandboxId,
        signal,
        runtime.sandboxName,
      );
    },
    read: (runtime, path, signal, verify) =>
      edit
        ? writeOpenShellArtifact(runtime, path, edit.content, edit.expectedContent, verify, signal)
        : readOpenShellArtifact(runtime, path, verify, signal),
  });
  return reader(sessionId, meta.accountBinding, meta.cwd, requestedPath);
}

export const terminalService = new TerminalService(new TerminalStore(taskStore.getDatabase()), {
  backend: new TmuxTerminalBackend(
    `mitzo-${createHash('sha256').update(mitzoDir).digest('hex').slice(0, 16)}`,
  ),
  validateCleanupTarget: (target) => {
    if (target.kind === 'sandbox') {
      if (!target.runtime) throw Error('Original sandbox cleanup receipt unavailable');
      validateSessionArtifactRuntime(target.runtime, openShellRuntimeConfig(process.env));
    }
  },
  resolve: createTerminalTargetResolver({
    hostCwd: homedir(),
    session: (id) => {
      const meta = eventStore.getSession(id);
      return meta
        ? { ...meta, title: meta.summary || meta.initialPrompt || 'Chat workspace' }
        : undefined;
    },
    allowedHost: isConfiguredAllowedPath,
    remote: isRemoteSessionArtifact,
    runtime: (id, binding) => getCodexConversationStore().readArtifactRuntime(id, binding),
    currentRoute: (binding, id) =>
      terminalAccountRoute(
        loadAccountProfiles(),
        binding,
        eventStore.getSession(id)?.selectedModel ?? binding.model,
      ),
    validateRuntime: (runtime) =>
      validateSessionArtifactRuntime(runtime, openShellRuntimeConfig(process.env)),
    inspect: (id, runtime, route) => {
      const config = openShellRuntimeConfig(process.env);
      if (!config) throw Error('Sandbox runtime unavailable');
      return new OpenShellRuntimeManager({ ...config, account: route }).inspect(
        id,
        runtime.sandboxId,
        AbortSignal.timeout(15000),
        runtime.sandboxName,
      );
    },
  }),
});
terminalService.startOwnerMaintenance(registerAuthSession);
app.use(
  '/api/terminals',
  createTerminalRouter({
    service: terminalService,
    authorize: operatorAuthMiddleware,
    adviser: new TerminalAdviser(createTerminalAdviserSession),
    accounts: async () => {
      const profiles = loadAccountProfiles();
      // Subscription CLI agents do not establish an inference-only capability.
      return [
        ...terminalAdviserCatalog(profiles.catalog()).map((account) => ({
          ...account,
          label: accountAliases.label(account.id, account.label),
        })),
        ...(getTerminalPlanAdviserHost()?.catalog() ?? []),
      ];
    },
    context: (id) => {
      const meta = id ? eventStore.getSession(id) : undefined;
      return meta?.accountBinding
        ? {
            summary: {
              profile: accountAliases.label(
                meta.accountBinding.accountId,
                meta.accountBinding.accountLabel,
              ),
              model: meta.selectedModel ?? meta.accountBinding.model,
              thinking: `Thinking: ${meta.reasoningEffort ?? 'model default'}`,
            },
            selection: {
              accountId: meta.accountBinding.accountId,
              model: meta.selectedModel ?? meta.accountBinding.model,
              reasoningEffort: meta.reasoningEffort,
            },
          }
        : {};
    },
    destinations: () =>
      eventStore
        .listSessions(200)
        .filter(
          (meta) =>
            meta.cwd &&
            meta.sessionType !== 'symposium' &&
            !meta.isHidden &&
            isRemoteSessionArtifact(meta.sessionId),
        )
        .map((meta) => ({
          sessionId: meta.sessionId,
          label: meta.summary || meta.initialPrompt || 'Untitled chat',
        })),
  }),
);

function readPreviewFile(filePath: string): {
  content?: string;
  isFile: boolean;
  tooLarge: boolean;
} {
  const fd = openSync(filePath, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { isFile: false, tooLarge: false };
    if (stat.size > MAX_PREVIEW_BYTES) return { isFile: true, tooLarge: true };

    // Read at most one byte beyond the limit. Checking the descriptor while
    // reading closes the stat/read race when an artifact is still being written.
    const buffer = Buffer.allocUnsafe(MAX_PREVIEW_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk === 0) break;
      bytesRead += chunk;
    }
    if (bytesRead > MAX_PREVIEW_BYTES) return { isFile: true, tooLarge: true };
    return {
      content: buffer.toString('utf-8', 0, bytesRead),
      isFile: true,
      tooLarge: false,
    };
  } finally {
    closeSync(fd);
  }
}

function canonicalPath(filePath: string): string {
  const full = resolve(filePath);
  try {
    return realpathSync(full);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(full);
    return parent === full ? full : join(canonicalPath(parent), basename(full));
  }
}

function containsPath(root: string, target: string): boolean {
  const rel = relative(canonicalPath(root), canonicalPath(target));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/**
 * A session id selects that session's recorded workspace for relative links and
 * browsing. It never widens the configured path allow-list: cwd originates in a
 * client message, so a persisted session record is not itself authorization.
 */
function sessionArtifactRoot(sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  const ordinary = ordinaryWorkspaceArtifactRoot(
    eventStore,
    () => getOrdinaryWorkspaces(true),
    sessionId,
  );
  if (ordinary) return ordinary.root;
  const cwd = eventStore.getSession(sessionId)?.cwd;
  if (!cwd || !isAbsolute(cwd) || resolve(cwd) === dirname(resolve(cwd))) return null;
  return isConfiguredAllowedPath(cwd) ? cwd : null;
}

function artifactWorktreeParents(repo: string): string[] {
  return [
    join(repo, '.claude', 'worktrees'),
    join(repo, '.cursor', 'worktrees'),
    `${repo}-sessions`,
  ];
}

function sessionRepositoryWorkspaces(repo: string, sessionId: string, workspace: string): string[] {
  const worktreeId = basename(workspace);
  const recordedId = eventStore.getSession(sessionId)?.wtId;
  const repoName =
    Object.entries(getRepoConfig().repos).find(
      ([, root]) => resolve(root) === resolve(repo),
    )?.[0] ?? 'primary';
  const activePath = sessionId
    ? registry.findBySessionId(sessionId)?.session.worktreePaths?.get(repoName)?.path
    : undefined;
  const recordedPath = sessionId ? eventStore.getLatestWorktreePath(sessionId, repoName) : null;
  const explicitPath = activePath ?? (typeof recordedPath === 'string' ? recordedPath : undefined);
  const validExplicit =
    explicitPath &&
    artifactWorktreeParents(repo).some(
      (parent) => resolve(parent) === dirname(resolve(explicitPath)),
    );
  const ids = [
    ...new Set([worktreeId, recordedId].filter((id): id is string => !!id && basename(id) === id)),
  ];
  return validExplicit
    ? [explicitPath]
    : ids.flatMap((id) => artifactWorktreeParents(repo).map((parent) => join(parent, id)));
}

function sessionArtifactBrowserRoot(
  dir: string | undefined,
  sessionId: string | undefined,
): string {
  const workspace = sessionArtifactRoot(sessionId);
  if (hasOrdinaryWorkspaceArtifactScope(eventStore, sessionId)) return workspace!;
  if (!workspace || !sessionId || !dir) return workspace ?? BASE_REPO;
  const target = resolveArtifactPath(dir, sessionId);
  if (containsPath(workspace, target)) return workspace;
  const repos = [...new Set([BASE_REPO, ...Object.values(getRepoConfig().repos)].filter(Boolean))];
  for (const repo of repos) {
    for (const candidate of sessionRepositoryWorkspaces(repo, sessionId, workspace)) {
      if (isAllowedPath(candidate, sessionId) && containsPath(candidate, target)) return candidate;
    }
  }
  return workspace;
}

function resolveArtifactPath(filePath: string, sessionId: string | undefined): string {
  // Home shorthand is expanded on the host, then checked against the same
  // configured/session workspace boundaries as every absolute artifact path.
  if (filePath.startsWith('~/')) filePath = resolve(homedir(), filePath.slice(2));
  const workspace = sessionArtifactRoot(sessionId);
  if (!isAbsolute(filePath)) return resolve(workspace ?? BASE_REPO, filePath);
  const requested = resolve(filePath);
  if (hasOrdinaryWorkspaceArtifactScope(eventStore, sessionId)) return requested;
  if (!workspace || existsSync(requested) || !isAllowedPath(requested, sessionId)) return requested;

  // Agents sometimes post the repository path after writing in its worktree.
  // Resolve only missing links within that conversation's corresponding repo;
  // never search other worktrees or replace an existing explicit file.
  const repos = [
    ...new Set([BASE_REPO, ...Object.values(getRepoConfig().repos)].filter(Boolean)),
  ].sort((a, b) => resolve(b).length - resolve(a).length);
  const parentsFor = (repo: string) => [
    join(repo, '.claude', 'worktrees'),
    join(repo, '.cursor', 'worktrees'),
    `${repo}-sessions`,
  ];
  if (
    !repos.some((repo) =>
      parentsFor(repo).some((parent) => resolve(parent) === dirname(resolve(workspace))),
    )
  )
    return requested;
  for (const repo of repos) {
    if (!containsPath(repo, requested)) continue;
    const suffix = relative(resolve(repo), requested);
    if (['.claude', '.cursor', '.git', '.mitzo'].includes(suffix.split(sep)[0])) return requested;
    const workspaces = sessionRepositoryWorkspaces(repo, sessionId!, workspace);
    workspaces.sort(
      (a, b) =>
        Number(resolve(b) === resolve(workspace)) - Number(resolve(a) === resolve(workspace)),
    );
    for (const target of workspaces) {
      const candidate = resolve(target, suffix);
      if (
        containsPath(target, candidate) &&
        isAllowedPath(candidate, sessionId) &&
        existsSync(candidate)
      )
        return candidate;
    }
    // A nested configured repository owns its path; do not substitute a parent repo copy.
    return requested;
  }
  return requested;
}

function createAllowedPathChecker(sessionId?: string) {
  const isPrivate = privatePathSnapshot();
  const ordinary = hasOrdinaryWorkspaceArtifactScope(eventStore, sessionId);
  let artifactRoot: string | null;
  try {
    artifactRoot = sessionArtifactRoot(sessionId);
  } catch {
    return () => false;
  }
  return (filePath: string): boolean => {
    try {
      if (isPrivate(filePath)) return false;
      if (artifactRoot && containsPath(artifactRoot, filePath)) return true;
    } catch {
      return false;
    }
    return ordinary ? false : isConfiguredAllowedPath(filePath);
  };
}
export function isAllowedPath(filePath: string, sessionId?: string): boolean {
  return createAllowedPathChecker(sessionId)(filePath);
}
function isConfiguredAllowedPath(filePath: string): boolean {
  try {
    const roots = BASE_REPO ? [BASE_REPO, `${BASE_REPO}-sessions`] : [];
    const config = getRepoConfig();
    for (const repoPath of Object.values(config.repos)) {
      roots.push(repoPath, `${repoPath}-sessions`);
    }
    roots.push(...config.allowedPaths);
    return roots.some((root) => containsPath(root, filePath));
  } catch {
    return false;
  }
}

function resolveRoot(
  queryRoot: string | undefined,
  allowed = isAllowedPath,
  defaultRoot = BASE_REPO,
): string {
  if (!queryRoot) return defaultRoot;
  const resolved = resolve(queryRoot);
  if (!allowed(resolved)) return defaultRoot;
  return resolved;
}

app.get(
  '/api/git/info',
  createGitInfoHandler(createGitInfoDiscovery(), () => ({
    repoPath: BASE_REPO,
    repos: getRepoConfig().repos,
  })),
);

// Browser file access adds no agent capability; internal artifact routes retain their own scopes.
app.use('/api/files', (req, res, next) => {
  const sessionId =
    req.method === 'PUT' && typeof req.body?.sessionId === 'string'
      ? req.body.sessionId
      : req.method !== 'PUT' && typeof req.query.sessionId === 'string'
        ? req.query.sessionId
        : undefined;
  if (!hasOrdinaryWorkspaceArtifactScope(eventStore, sessionId)) return next();
  const auth = res.locals.authSession;
  if (!auth || !hasPersistentRevocationAuthority() || !isAuthSessionCurrent(auth))
    return res
      .status(403)
      .json({ error: 'A current interactive operator is required for this conversation’s files.' });
  const validate = () => {
    try {
      ordinaryWorkspaceArtifactRoot(eventStore, () => getOrdinaryWorkspaces(true), sessionId);
      res.setHeader('Cache-Control', 'private, no-store');
      const unregister = registerAuthSession(auth, () => res.destroy());
      res.once('close', unregister);
      next();
    } catch (error) {
      res.status(409).json({
        error:
          error instanceof SessionArtifactUnavailableError
            ? error.message
            : 'This conversation’s workspace is unavailable.',
      });
    }
  };
  return req.method === 'PUT' ? requireSameOriginJson(req, res, validate) : validate();
});
app.get('/api/files/roots', (req, res) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
  const ordinary = ordinaryWorkspaceArtifactRoot(
    eventStore,
    () => getOrdinaryWorkspaces(true),
    sessionId,
  );
  res.json(
    ordinary ? [{ label: 'Conversation files', path: ordinary.root }] : getRepoConfig().roots,
  );
});

app.get('/api/files/list', (req, res) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
  if (sessionId && isRemoteSessionArtifact(sessionId)) {
    res.status(409).json({
      error:
        'Directory browsing for this conversation’s sandbox workspace is unavailable. Open a file link in the conversation to view or download it.',
    });
    return;
  }

  const allowed = createAllowedPathChecker(sessionId);
  const root = resolveRoot(
    req.query.root as string | undefined,
    allowed,
    sessionArtifactBrowserRoot(req.query.dir as string | undefined, sessionId),
  );
  const requestedDir = req.query.dir as string | undefined;
  const dir = requestedDir ? resolveArtifactPath(requestedDir, sessionId) : root;
  if (!dir || !allowed(dir)) {
    res.status(403).json({ error: 'Path not allowed' });
    return;
  }
  if (!existsSync(dir)) {
    res.status(404).json({ error: 'Directory not found' });
    return;
  }
  try {
    const entries = readdirSync(dir)
      .filter((name) => !name.startsWith('.') && allowed(join(dir, name)))
      .map((name) => {
        const full = join(dir, name);
        try {
          const stat = statSync(full);
          return { name, isDir: stat.isDirectory() };
        } catch {
          return { name, isDir: false };
        }
      })
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ currentDir: dir, entries });
  } catch (err: unknown) {
    log.error('failed to read directory', {
      dir,
      error: err instanceof Error ? err.message : 'unknown',
    });
    res.status(500).json({ error: 'Failed to read directory' });
  }
});

app.get('/api/files', (req, res) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
  if (sessionId && isRemoteSessionArtifact(sessionId)) {
    res.status(409).json({
      error:
        'Directory browsing for this conversation’s sandbox workspace is unavailable. Open a file link in the conversation to view or download it.',
    });
    return;
  }

  const allowed = createAllowedPathChecker(sessionId);
  const root = resolveRoot(
    req.query.root as string | undefined,
    allowed,
    sessionArtifactBrowserRoot(req.query.dir as string | undefined, sessionId),
  );
  const requestedDir = req.query.dir as string | undefined;
  const dir = requestedDir ? resolveArtifactPath(requestedDir, sessionId) : root;
  if (!dir || !allowed(dir)) {
    res.status(403).json({ error: 'Path not allowed' });
    return;
  }
  if (!existsSync(dir)) {
    res.status(404).json({ error: 'Directory not found' });
    return;
  }
  try {
    const entries = readdirSync(dir)
      .filter((name) => !name.startsWith('.') && allowed(join(dir, name)))
      .map((name) => {
        const full = join(dir, name);
        try {
          const stat = statSync(full);
          return { name, isDir: stat.isDirectory() };
        } catch {
          return { name, isDir: false };
        }
      })
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ dir, root, entries });
  } catch (err: unknown) {
    log.error('failed to read directory', {
      dir,
      error: err instanceof Error ? err.message : 'unknown',
    });
    res.status(500).json({ error: 'Failed to read directory' });
  }
});

app.get('/api/files/read', async (req, res) => {
  const requestedPath = req.query.path as string;
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
  if (sessionId && isRemoteSessionArtifact(sessionId)) {
    try {
      if (!requestedPath) {
        res.status(403).json({ error: 'Path not allowed' });
        return;
      }
      const file = await readRemoteSessionArtifact(sessionId, requestedPath);
      res.json({
        path: file.path,
        content: file.bytes.toString('utf8'),
        ext: extname(file.path).toLowerCase(),
      });
    } catch (error) {
      const known =
        error instanceof SessionArtifactUnavailableError ||
        error instanceof OpenShellArtifactReadError;
      res.status(known ? error.status : 409).json({
        error: known
          ? error.message
          : 'This conversation’s workspace is unavailable. Resume this conversation once, then try again.',
      });
    }
    return;
  }
  const filePath = requestedPath ? resolveArtifactPath(requestedPath, sessionId) : '';
  if (!filePath || !isAllowedPath(filePath, sessionId)) {
    res.status(403).json({ error: 'Path not allowed' });
    return;
  }
  if (!existsSync(filePath)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  try {
    const preview = readPreviewFile(filePath);
    if (!preview.isFile) {
      res.status(400).json({ error: 'Path is not a file' });
      return;
    }
    if (preview.tooLarge) {
      res.status(413).json({ error: 'File is too large to preview (5 MB maximum)' });
      return;
    }
    const ext = extname(filePath).toLowerCase();
    res.json({ path: filePath, content: preview.content, ext });
  } catch (err: unknown) {
    log.error('failed to read file', {
      path: filePath,
      error: err instanceof Error ? err.message : 'unknown',
    });
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// ── Tool result images (served from in-memory store) ──────────────────────
app.get('/api/images/:imageId', (req, res) => {
  const img = getImage(req.params.imageId);
  if (!img) {
    res.status(404).json({ error: 'Image not found' });
    return;
  }
  res.setHeader('Content-Type', img.mediaType);
  res.setHeader('Content-Length', img.data.length);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(img.data);
});

app.get('/api/files/download', async (req, res) => {
  const requestedPath = req.query.path as string;
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
  if (sessionId && isRemoteSessionArtifact(sessionId)) {
    try {
      if (!requestedPath) {
        res.status(403).json({ error: 'Path not allowed' });
        return;
      }
      const file = await readRemoteSessionArtifact(sessionId, requestedPath);
      const filename = basename(file.path);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      res.setHeader('Content-Length', file.bytes.length);
      res.send(file.bytes);
    } catch (error) {
      const known =
        error instanceof SessionArtifactUnavailableError ||
        error instanceof OpenShellArtifactReadError;
      res.status(known ? error.status : 409).json({
        error: known
          ? error.message
          : 'This conversation’s workspace is unavailable. Resume this conversation once, then try again.',
      });
    }
    return;
  }
  const filePath = requestedPath ? resolveArtifactPath(requestedPath, sessionId) : '';
  if (!filePath || !isAllowedPath(filePath, sessionId)) {
    res.status(403).json({ error: 'Path not allowed' });
    return;
  }
  if (!existsSync(filePath)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  try {
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      res.status(400).json({ error: 'Cannot download a directory' });
      return;
    }
    const filename = basename(filePath);
    const safeFilename = filename.replace(/"/g, '\\"');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.setHeader('Content-Length', stat.size);
    res.sendFile(resolve(filePath));
  } catch (err: unknown) {
    log.error('failed to download file', {
      path: filePath,
      error: err instanceof Error ? err.message : 'unknown',
    });
    res.status(500).json({ error: 'Failed to download file' });
  }
});

app.put('/api/files/write', async (req, res) => {
  const body = FileWriteBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'path and content are required' });
    return;
  }
  const { path: requestedPath, content, sessionId, expectedContent } = body.data;
  if (expectedContent === undefined) {
    res.status(409).json({ error: 'Reopen the document in the updated editor before saving.' });
    return;
  }
  if (
    Buffer.byteLength(content) > MAX_PREVIEW_BYTES ||
    Buffer.byteLength(expectedContent) > MAX_PREVIEW_BYTES
  ) {
    res.status(413).json({ error: 'Document is too large to edit (5 MB maximum)' });
    return;
  }
  if (sessionId && isRemoteSessionArtifact(sessionId)) {
    try {
      const file = await readRemoteSessionArtifact(sessionId, requestedPath, {
        content,
        expectedContent,
      });
      res.json({ ok: true, path: file.path });
    } catch (error) {
      const known =
        error instanceof OpenShellArtifactReadError ||
        error instanceof SessionArtifactUnavailableError;
      res.status(known ? error.status : 503).json({
        error: known
          ? error.message
          : 'Sandbox document could not be saved. Your draft is preserved.',
      });
    }
    return;
  }

  const filePath = resolveArtifactPath(requestedPath, sessionId);
  if (!isAllowedPath(filePath, sessionId) || isWorkspaceRuntimeAuthorityWritePath(filePath)) {
    res.status(403).json({ error: 'Path not allowed' });
    return;
  }
  if (!existsSync(filePath)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  try {
    writeHostArtifact(filePath, content, expectedContent);
    res.json({ ok: true, path: filePath });
  } catch (err: unknown) {
    log.error('failed to write file', {
      path: filePath,
      error: err instanceof Error ? err.message : 'unknown',
    });
    res.status(err instanceof OpenShellArtifactReadError ? err.status : 500).json({
      error: err instanceof OpenShellArtifactReadError ? err.message : 'Failed to write file',
    });
  }
});

// --- Inbox API ---

/** Today and Home must select the same enrolled report under existing file authority. */
async function selectRuntimeBriefing(date: string, signal?: AbortSignal) {
  const client = createWorkspaceRuntimeClient(process.env.MITZO_WORKSPACE_RUNTIME_CONFIG ?? '');
  if (!isAllowedPath(client.briefingsRoot)) throw new Error('Briefing root is not readable');
  const briefing = await client.latestBriefing({ date }, signal);
  if (briefing && !isAllowedPath(briefing.path))
    throw new Error('Briefing artifact is not readable');
  return briefing;
}

app.use(
  '/api/home',
  createHomeRouter({
    store: new HomeStore(join(BASE_REPO || '.', '.mitzo', 'home.json')),
    catalog: readQuoteCatalog,
    briefing: async (date, signal) => {
      if (!workspaceRuntimeConfigured()) return readMorningBriefing(BASE_REPO || '.', date);
      const selected = await selectRuntimeBriefing(date, signal);
      return selected ? readMorningBriefingSnapshot(selected) : null;
    },
    session: (id) => eventStore.getSession(id),
    changed: () => sseRegistry.broadcast('home_preferences', {}),
  }),
);

app.get('/api/briefings/latest', async (req, res) => {
  const date = typeof req.query.date === 'string' ? req.query.date : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    return;
  }
  if (workspaceRuntimeConfigured()) {
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', cancel);
    try {
      const briefing = await selectRuntimeBriefing(date, controller.signal);
      res.json(briefing);
    } catch {
      if (!res.destroyed) res.status(503).json({ error: 'Workspace runtime briefing unavailable' });
    } finally {
      res.removeListener('close', cancel);
    }
    return;
  }
  try {
    res.json(getLatestMorningBriefing(BASE_REPO, date));
  } catch {
    res.status(503).json({ error: 'Saved briefing unavailable' });
  }
});

app.use('/api/inbox', inboxRouter);
app.get('/api/inbox', (_req, res) => {
  const inboxPath = getRepoConfig().resolvedInboxPath;
  if (!inboxPath) {
    res.json([]);
    return;
  }
  const privatePath = privatePathSnapshot();
  res.json(
    listInboxItems(inboxPath).filter((item) => {
      try {
        return !privatePath(join(inboxPath, item.filename));
      } catch {
        return false;
      }
    }),
  );
});

app.post('/api/inbox', (req, res) => {
  const inboxPath = getRepoConfig().resolvedInboxPath;
  if (!inboxPath) {
    res.status(404).json({ error: 'Inbox not configured' });
    return;
  }
  const { source, title, body, tags } = req.body || {};
  if (!title || typeof title !== 'string' || !body || typeof body !== 'string') {
    res.status(400).json({ error: 'title and body are required strings' });
    return;
  }
  const item = createInboxItem(inboxPath, {
    source: typeof source === 'string' ? source : 'chat',
    title,
    body,
    tags: Array.isArray(tags) ? tags : undefined,
  });
  if (!item) {
    res.status(500).json({ error: 'Failed to create inbox item' });
    return;
  }
  notificationCenter.update(item.filename, item.title, item.preview, item.filename);
  res.status(201).json(item);
  broadcastInboxUpdate();
});

// Inbox archive/delete can move documents too; enrolled operator authority is
// never a document, including a JSON file with an .md filename.
app.use('/api/inbox/:filename', (req, res, next) => {
  const inboxPath = getRepoConfig().resolvedInboxPath;
  if (!inboxPath) return next();
  try {
    const source = join(inboxPath, req.params.filename);
    const privatePath = privatePathSnapshot();
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    const destination = join(inboxPath, 'archive', req.params.filename);
    if (
      !privatePath(source) &&
      (!mutating ||
        (!isWorkspaceRuntimeAuthorityWritePath(source) &&
          !privatePath(destination) &&
          !isWorkspaceRuntimeAuthorityWritePath(destination)))
    )
      return next();
  } catch {
    /* Unreadable authority fails closed. */
  }
  res.status(403).json({ error: 'Path not allowed' });
});

app.get('/api/inbox/:filename', (req, res) => {
  const inboxPath = getRepoConfig().resolvedInboxPath;
  if (!inboxPath) {
    res.status(404).json({ error: 'Inbox not configured' });
    return;
  }
  const content = readInboxItem(inboxPath, req.params.filename);
  if (content === null) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  res.json({ content });
});

app.post('/api/inbox/:filename/approve', (req, res) => {
  const inboxPath = getRepoConfig().resolvedInboxPath;
  if (!inboxPath) {
    res.status(404).json({ error: 'Inbox not configured' });
    return;
  }
  const ok = approveInboxItem(inboxPath, req.params.filename);
  if (!ok) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  notificationCenter.feed('needs');
  res.json({ ok: true });
  broadcastInboxUpdate();
});

app.delete('/api/inbox/:filename', (req, res) => {
  const inboxPath = getRepoConfig().resolvedInboxPath;
  if (!inboxPath) {
    res.status(404).json({ error: 'Inbox not configured' });
    return;
  }
  const ok = discardInboxSource(notificationCenter.store, inboxPath, req.params.filename);
  if (!ok) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  notificationCenter.feed('needs');
  notificationCenter.changed();
  res.json({ ok: true });
  broadcastInboxUpdate();
});

app.use('/api/notifications', notificationRouter(notificationCenter));

// --- Push notification device token registration ---

app.post('/api/push/register', (req, res) => {
  const { token } = req.body || {};
  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'token is required' });
    return;
  }
  registerToken(token);
  notificationCenter.changed();
  void notificationCenter.syncBadge();
  res.json({ ok: true });
});

app.delete('/api/push/register', (req, res) => {
  const { token } = req.body || {};
  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'token is required' });
    return;
  }
  removeToken(token);
  res.json({ ok: true });
});

// --- Push notification action responses (Reply/View/Later from iOS) ---

app.post('/api/push/notification-action', async (req, res) => {
  const { sessionId, actionId, userText } = req.body || {};

  if (!sessionId || typeof sessionId !== 'string') {
    res.status(400).json({ error: 'sessionId is required' });
    return;
  }
  if (!actionId || typeof actionId !== 'string') {
    res.status(400).json({ error: 'actionId is required' });
    return;
  }

  // View and Later are client-side only — acknowledge without server action
  if (actionId === 'VIEW_ACTION') {
    res.json({ ok: true, action: 'view' });
    return;
  }
  if (actionId === 'LATER_ACTION') {
    res.json({ ok: true, action: 'later' });
    return;
  }

  // Reply requires text
  if (actionId === 'REPLY_ACTION') {
    if (!userText || typeof userText !== 'string') {
      res.status(400).json({ error: 'userText is required for REPLY_ACTION' });
      return;
    }

    const found = registry.findBySessionId(sessionId);
    if (!found) {
      res.status(404).json({ error: 'Session not found or inactive' });
      return;
    }

    try {
      const ok = await sendToChat(found.clientId, userText);
      if (!ok) {
        res.status(500).json({ error: 'Failed to send message to session' });
        return;
      }

      res.json({ ok: true, action: 'reply' });
    } catch (err) {
      log.error('push reply send failed', { sessionId, error: String(err) });
      res.status(500).json({ error: 'Failed to send message to session' });
    }
    return;
  }

  res.status(400).json({ error: `Unknown actionId: ${actionId}` });
});

// --- Calendar API ---

const legacyExecFileAsync = promisify(execFile);
async function execFileAsync(
  command: string,
  args: string[],
  options: { timeout: number; maxBuffer?: number; env?: NodeJS.ProcessEnv; encoding?: 'utf8' },
) {
  // Mutable workspace entrypoints run with the same authority fence as hooks.
  // An unavailable enrolled fence must never fall back to controller execution.
  const protectedRunner = createWorkspaceRuntimeCommandRunner();
  if (protectedRunner)
    return protectedRunner(command, args, {
      ...options,
      cwd: process.cwd(),
      env: options.env ?? process.env,
    });
  return legacyExecFileAsync(command, args, options);
}
const CALENDAR_SCRIPT = join(BASE_REPO, 'command_center', 'calendar_api.py');
const CALENDAR_TIMEOUT_MS = 20_000;

app.get('/api/calendar', async (req, res) => {
  const dateParam = (req.query.date as string) || new Date().toISOString().slice(0, 10);
  const daysParam = Math.max(1, Math.min(31, parseInt(req.query.days as string) || 7));

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam) || isNaN(Date.parse(dateParam))) {
    res.status(400).json({ error: 'Invalid date format — use YYYY-MM-DD' });
    return;
  }

  const emptyResponse = (error: string) => {
    const endDate = new Date(dateParam);
    endDate.setDate(endDate.getDate() + daysParam - 1);
    return {
      startDate: dateParam,
      endDate: endDate.toISOString().slice(0, 10),
      events: [],
      sprints: [],
      error,
    };
  };

  if (workspaceRuntimeConfigured()) {
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', cancel);
    try {
      const client = createWorkspaceRuntimeClient(process.env.MITZO_WORKSPACE_RUNTIME_CONFIG ?? '');
      res.json(await client.calendar({ date: dateParam, days: daysParam }, controller.signal));
    } catch {
      if (!res.destroyed) res.json(emptyResponse('Workspace runtime calendar unavailable'));
    } finally {
      res.removeListener('close', cancel);
    }
    return;
  }

  // calendar_api.py lives in the mgmt repo (REPO_PATH), not in Mitzo
  if (!existsSync(CALENDAR_SCRIPT)) {
    log.warn('calendar script not found', { path: CALENDAR_SCRIPT });
    res.json(emptyResponse(`Calendar script not found at ${CALENDAR_SCRIPT}`));
    return;
  }

  try {
    const { stdout } = await execFileAsync(
      'python3',
      [CALENDAR_SCRIPT, '--date', dateParam, '--days', String(daysParam)],
      { timeout: CALENDAR_TIMEOUT_MS },
    );
    const parsed = CalendarResponse.safeParse(JSON.parse(stdout));
    if (!parsed.success) {
      log.warn('calendar API returned unexpected shape', { error: parsed.error.message });
      res.json(emptyResponse('Calendar data failed validation'));
      return;
    }
    res.json(parsed.data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.warn('calendar API failed', { error: message });
    res.json(emptyResponse(message));
  }
});

// --- Todo API ---

const TODO_SCRIPT = join(BASE_REPO, 'command_center', 'todo_api.py');
const TODO_TIMEOUT_MS = 30_000;
// The todo list includes source context and can exceed Node's 1 MiB execFile default.
// Keep the subprocess bounded while leaving headroom above the current production payload.
const TODO_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

app.get(
  '/api/todos',
  (req, res, next) => {
    const view = TelosWorkLifecycleListSchema.safeParse(req.query.view ?? 'active');
    if (!view.success)
      return res.status(400).json({ code: 'invalid', error: 'Invalid lifecycle view' });
    return view.data === 'active' ? next() : operatorAuthMiddleware(req, res, next);
  },
  async (req, res) => {
    const profile = req.query.profile as string | undefined;
    const refresh = req.query.refresh === 'true';
    const databasePath = telosDatabasePath();
    const view = TelosWorkLifecycleListSchema.parse(req.query.view ?? 'active');

    if (!existsSync(TODO_SCRIPT)) {
      log.warn('todo script not found', { path: TODO_SCRIPT });
      res.status(503).json({ error: 'Todo service unavailable' });
      return;
    }

    try {
      const args = [TODO_SCRIPT];
      if (refresh && profile) {
        args.push('--refresh', '--profile', profile);
      } else {
        args.push('--list');
        if (profile) args.push('--profile', profile);
      }

      const { stdout } = await execFileAsync('python3', args, {
        timeout: TODO_TIMEOUT_MS,
        maxBuffer: TODO_MAX_BUFFER_BYTES,
        env: { ...process.env, TELOS_DB_PATH: databasePath },
      });
      const parsed = TodoListResponse.safeParse(JSON.parse(stdout));
      if (!parsed.success) {
        log.warn('todo API returned unexpected shape', { error: parsed.error.message });
        res.status(502).json({ error: 'Todo service unavailable' });
        return;
      }
      res.json(
        projectCanonicalTelosLifecycleList({
          canonical: parsed.data,
          databasePath,
          view,
          operator: res.locals.authSession as AuthSession | undefined,
          policy: {
            ordinaryConversation: (id) =>
              isAvailableTelosWorkConversation(eventStore.getSession(id)),
            sourceConversation: (id) =>
              isAvailableTelosSourceConversation(eventStore.getSession(id)),
          },
        }),
      );
    } catch (err: unknown) {
      if (err instanceof TelosWorkError) {
        const status = { invalid: 400, unauthorized: 403, conflict: 409, not_found: 404 }[err.code];
        res.status(status).json({ code: err.code, error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      log.warn('todo API failed', { error: message });
      res.status(502).json({ error: 'Todo service unavailable' });
    }
  },
);

app.post('/api/todos', async (req, res) => {
  const body = TodoCreateBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ ok: false, error: body.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }
  const { summary, profile, parentId } = body.data;

  if (!existsSync(TODO_SCRIPT)) {
    res.status(500).json({ ok: false, error: 'Todo script not found' });
    return;
  }

  try {
    const args = [TODO_SCRIPT, '--create', summary, '--profile', profile];
    if (parentId) {
      args.push('--parent', parentId);
    }

    const { stdout } = await execFileAsync('python3', args, {
      timeout: TODO_TIMEOUT_MS,
      maxBuffer: TODO_MAX_BUFFER_BYTES,
    });
    const parsed = JSON.parse(stdout);
    if (!parsed.ok) {
      res.status(400).json(parsed);
      return;
    }
    res.status(201).json(parsed);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.warn('todo create failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

app.post('/api/todos/outcomes', async (req, res) => {
  const body = TodoOutcomeCreateBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ ok: false, error: body.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }

  if (!existsSync(TODO_SCRIPT)) {
    res.status(500).json({ ok: false, error: 'Todo script not found' });
    return;
  }

  try {
    const { stdout } = await execFileAsync(
      'python3',
      [TODO_SCRIPT, '--create-outcome-json', JSON.stringify(body.data)],
      { timeout: TODO_TIMEOUT_MS, maxBuffer: TODO_MAX_BUFFER_BYTES },
    );
    const parsed = JSON.parse(stdout);
    if (!parsed.ok) {
      res.status(400).json(parsed);
      return;
    }
    res.status(parsed.created ? 201 : 200).json(parsed);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.warn('todo outcome create failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

app.post('/api/todos/:id/action', async (req, res) => {
  const { id } = req.params;

  const body = TodoActionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ ok: false, error: 'Invalid action body' });
    return;
  }

  if (!existsSync(TODO_SCRIPT)) {
    res.status(500).json({ ok: false, error: 'Todo script not found' });
    return;
  }

  try {
    const args = [TODO_SCRIPT, '--action', body.data.action, id];
    if (body.data.action === 'snooze' && body.data.days) {
      args.push(String(body.data.days));
    }
    if (body.data.action === 'priority' && body.data.priority !== undefined) {
      args.push(String(body.data.priority));
    }

    const { stdout } = await execFileAsync('python3', args, {
      timeout: TODO_TIMEOUT_MS,
      maxBuffer: TODO_MAX_BUFFER_BYTES,
    });
    const parsed = TodoActionResponse.safeParse(JSON.parse(stdout));
    if (!parsed.success) {
      res.status(500).json({ ok: false, error: 'Unexpected response' });
      return;
    }
    if (!parsed.data.ok) {
      res.status(404).json(parsed.data);
      return;
    }
    res.json(parsed.data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.warn('todo action failed', { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

// --- Workload API ---

app.post('/api/workload/signals', (req, res) => {
  const body = WorkSignalBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid signal' });
    return;
  }
  const result = workloadStore.ingest(body.data as WorkSignal);
  res.status(result.created ? 201 : 200).json({ item: result.item, created: result.created });

  // Broadcast workload item change
  const eventType = result.created ? 'workload_item_created' : 'workload_item_updated';
  onWorkloadBroadcast?.({ type: eventType, item: result.item });
});

app.post('/api/workload/signals/batch', (req, res) => {
  const body = WorkSignalBatchBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid batch' });
    return;
  }
  const result = workloadStore.ingestBatch(body.data.signals as WorkSignal[]);
  res
    .status(201)
    .json({ items: result.items, created: result.created, total: result.items.length });

  // Broadcast batch workload changes
  if (result.items.length > 0) {
    onWorkloadBroadcast?.({
      type: 'workload_batch_updated',
      items: result.items,
      created: result.created,
    });
  }
});

app.get('/api/workload/items', (req, res) => {
  const profile = req.query.profile as string | undefined;
  const status = req.query.status as string | undefined;
  const starred = req.query.starred === 'true' ? true : undefined;
  const items = workloadStore.list({
    profile,
    status: status as 'active' | 'acknowledged' | 'snoozed' | 'completed' | undefined,
    starred,
  });
  const profiles = workloadStore.profiles();
  res.json({ items, profiles });
});

app.get('/api/workload/items/:id', (req, res) => {
  const item = workloadStore.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  res.json({ item });
});

app.patch('/api/workload/items/:id', (req, res) => {
  const body = WorkloadItemUpdateBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid update' });
    return;
  }
  const item = workloadStore.update(req.params.id, body.data as TodoItemUpdateInput);
  if (!item) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  res.json({ item });
  onWorkloadBroadcast?.({ type: 'workload_item_updated', item });
});

app.delete('/api/workload/items/:id', (req, res) => {
  const ok = workloadStore.delete(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  res.json({ ok: true });
});

app.post('/api/workload/items/:id/promote', (req, res) => {
  const body = WorkloadPromoteBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid promote body' });
    return;
  }

  const item = workloadStore.get(req.params.id);

  // Resolve title and context from workloadStore item or fallback body data (Telos items)
  const title = item?.title ?? body.data.title;
  if (!title) {
    res.status(404).json({ error: 'Item not found and no title provided' });
    return;
  }

  const hints = item?.contextHints ?? body.data.contextHints;
  const taskHint = hints?.taskHint ?? undefined;

  // Build description from item context
  const descParts: string[] = [];
  if (body.data.description) descParts.push(body.data.description);
  if (taskHint) descParts.push(taskHint);
  if (hints) {
    const hintsWithValues = Object.entries(hints)
      .filter(([k, v]) => k !== 'taskHint' && Array.isArray(v) && v.length > 0)
      .map(([k, v]) => `${k}: ${(v as string[]).join(', ')}`);
    if (hintsWithValues.length > 0) descParts.push(hintsWithValues.join('\n'));
  }

  // Build annotations from sources
  const annotations: string[] = item
    ? item.sources.map((s) => `Source: [${s.sourceType}] ${s.title} — ${s.url}`)
    : (body.data.sources ?? []).map((s) => `Source: [${s.type}] ${s.title} — ${s.url}`);

  // Create root task (goal) from item
  const task = taskStore.create({
    title,
    description: descParts.join('\n\n') || undefined,
    annotations,
  });

  // Link item to goal only if it exists in workloadStore
  if (item) {
    workloadStore.setGoalId(item.id, task.id);
  }

  const updatedItem = item ? workloadStore.get(item.id) : undefined;
  res.status(201).json(updatedItem ? { task, item: updatedItem } : { task });
  onTaskBroadcast?.({ type: 'task_state', tasks: taskStore.getTree() });
  if (updatedItem) {
    onWorkloadBroadcast?.({ type: 'workload_item_updated', item: updatedItem });
  }
});

// --- Static files ---

const frontendDist = join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(frontendDist));
app.get('*', (_req, res, next) => {
  if (_req.path.startsWith('/api') || _req.path.startsWith('/ws')) return next();
  res.sendFile(join(frontendDist, 'index.html'), (err) => {
    if (err) next();
  });
});

/** Release an idle, unbootstrapped application without starting or draining work.
 * A configured host or active owner requires its existing shutdown protocol.
 * Once release begins, HTTP admission stays fenced even if an owner refuses;
 * this is not a general server shutdown or a runtime cleanup fallback.
 */
export function closeIdleApplicationResources(): Promise<void> {
  if (idleApplicationClose) return idleApplicationClose;
  if (
    activeApplicationRequests ||
    !registry.entries(true).next().done ||
    codexReattachments.size ||
    symposiumSessionRuntimes.size ||
    symposiumProductionHost ||
    custodianControllerClient ||
    connectionsRouter ||
    capabilityOperationsRouter ||
    credentialConnectionsRouter ||
    getCredentialConnectionsRuntime() ||
    getConnectionRegistry() ||
    orchestrator ||
    templateStore ||
    signalProcessor ||
    overviewEmitter ||
    healthMonitor ||
    openShellLifecycleService ||
    skillWatcher
  )
    return Promise.reject(new Error('Application resource owners are active'));
  idleApplicationClosing = true;
  idleApplicationClose = (async () => {
    await terminalService.closeIdle();
    notificationCenter.closeIdle();
    symposiumAccessRequests.closeIdle();
    closeIdleRepositoryWorkspaces();
    sseRegistry.destroy();
    chatSseRegistry.destroy();
    registry.dispose();
    closeAgentTasks();
    closeAgentLibrary();
    symposiumProfileStore.close();
    symposiumAgentContextStore.close();
    symposiumProfileProposalStore.close();
    symposiumHostGrants.close();
    symposiumReviewStore.close();
    notificationCenter.store.close();
    taskStore.close();
    eventStore.close();
  })();
  return idleApplicationClose;
}

export { app };
