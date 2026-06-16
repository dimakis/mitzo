// Transport abstraction
export type { SessionTransport } from './session-transport.js';

// Session registry
export { SessionRegistry } from './session-registry.js';
export type { ManagedSession, ActiveSessionInfo, CloseoutHandler } from './session-registry.js';
export type {
  MitzoMode,
  SnapshotBlock,
  MessageSnapshot,
  RawToolInput,
} from './session-registry.js';

// Connection registry (v2 single-WS protocol)
export { ConnectionRegistry } from './connection-registry.js';
export type { Connection, EventStoreAdapter } from './connection-registry.js';

// SSE registry (broadcast events)
export { SseRegistry } from './sse-registry.js';
export type { SseClient } from './sse-registry.js';

// Permissions
export {
  registerPending,
  resolvePending,
  removePending,
  hasPending,
  denyPendingBySession,
  getPendingCountBySession,
} from './permissions.js';

// Tool tiers
export type { ToolTier } from './tool-tiers.js';
export {
  applyTierOverrides,
  getToolTier,
  shouldAutoAllow,
  getAllowedToolsForMode,
} from './tool-tiers.js';

// Skill policy
export { setSkillPolicy, clearSkillPolicy, checkSkillPolicy } from './skill-policy.js';

// Worktree guard
export {
  checkWorktreePolicy,
  getWorktreeGuardStats,
  resetWorktreeGuardStats,
} from './worktree-guard.js';
export type { OnDemandCreateFn, CheckWorktreePolicyOptions } from './worktree-guard.js';

// Notifications
export * as ntfy from './notify.js';
export * as pushover from './pushover.js';

// Notification helpers
export { extractSnippet } from './notification-helpers.js';

// Constants
export {
  DETACHED_TTL_MS,
  CLOSEOUT_LEAD_MS,
  CLOSEOUT_TIMEOUT_MS,
  USER_CLOSEOUT_TIMEOUT_MS,
  PERMISSION_TIMEOUT_MS,
  NTFY_NOTIFICATION_DELAY_MS,
} from './constants.js';

// Permission handler
export { buildPermissionHandler } from './permission-handler.js';

// Auto-rename
export {
  shouldAutoRename,
  extractRecentPrompts,
  generateSessionName,
  generateSessionNameFallback,
  createAnthropicClient,
  setClientFactory,
  resetClientFactory,
  AUTO_RENAME_INTERVAL,
  AUTO_RENAME_MODEL,
} from './auto-rename.js';

// Logger
export { createLogger } from './logger.js';

// Providers — multi-model adapter layer
export { createProvider, createProviders } from './providers/index.js';
export type {
  ModelProvider,
  ProviderMessage,
  ProviderResponse,
  CallOptions,
} from './providers/index.js';
export { MODEL_COSTS, calculateCost } from './providers/index.js';

// Reasoning — deliberation + fusion orchestrators
export { DeliberationOrchestrator, DEFAULT_DELIBERATION_CONFIG } from './reasoning/index.js';
export {
  FusionOrchestrator,
  DEFAULT_FUSION_CONFIG,
  SELF_FUSION_CONFIG,
} from './reasoning/index.js';
export type {
  DeliberationConfig,
  DeliberationResult,
  FusionConfig,
  FusionResult,
  JudgeAnalysis,
  ReasoningEvent,
  ReasoningEventHandler,
} from './reasoning/index.js';
