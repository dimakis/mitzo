// Transport abstraction
export type { SessionTransport } from './session-transport.js';

// Session registry
export { SessionRegistry } from './session-registry.js';
export type { ManagedSession, ActiveSessionInfo } from './session-registry.js';
export type {
  MitzoMode,
  SnapshotBlock,
  MessageSnapshot,
  RawToolInput,
} from './session-registry.js';

// Connection registry (v2 single-WS protocol)
export { ConnectionRegistry } from './connection-registry.js';
export type { Connection } from './connection-registry.js';

// Permissions
export { registerPending, resolvePending, removePending, hasPending } from './permissions.js';

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

// Notifications
export * as ntfy from './notify.js';
export * as pushover from './pushover.js';

// Notification helpers
export { extractSnippet } from './notification-helpers.js';

// Constants
export { DETACHED_TTL_MS, PERMISSION_TIMEOUT_MS, NTFY_NOTIFICATION_DELAY_MS } from './constants.js';

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
