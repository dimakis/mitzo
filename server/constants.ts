// Server-wide constants. Every hardcoded value lives here.

// Protocol-level constants are canonical in @mitzo/protocol.
// Re-export them here so existing server imports continue to work.
export {
  TOOL_RESULT_MAX_CHARS,
  TOOL_SUMMARY_MAX_CHARS,
  RAW_INPUT_MAX_CHARS,
  NOTIFY_SNIPPET_MAX_CHARS,
  NOTIFY_INPUT_MAX_CHARS,
  SESSION_PAGE_SIZE,
  SESSION_MESSAGES_LIMIT,
  MAX_OBSERVERS_PER_SESSION,
  CONTEXT_CEILING_TOKENS,
} from '@mitzo/protocol';

// --- Session & Permission ---
export const DETACHED_TTL_MS = 3_600_000; // 1 hour — events survive in durable store regardless
export const PERMISSION_TIMEOUT_MS = 120_000; // 2 minutes
export const NTFY_NOTIFICATION_DELAY_MS = 10_000; // 10 seconds

// --- Worktree ---
export const WORKTREE_BRANCH_PREFIX = 'session/';
export const WORKTREE_STALE_HOURS = 96; // 4 days
export const WORKTREE_GIT_TIMEOUT_MS = 30_000;
export const WORKTREE_REMOVE_TIMEOUT_MS = 15_000;
export const WORKTREE_PRUNE_TIMEOUT_MS = 5_000;

// --- Git ---
export const GIT_BRANCH_TIMEOUT_MS = 5_000;

// --- Server ---
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const PORT_DEFAULT = 3100;
export const SHUTDOWN_GRACE_MS = 5_000;
