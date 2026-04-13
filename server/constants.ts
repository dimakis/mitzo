// Server-wide constants. Every hardcoded value lives here.

// --- Session & Permission ---
export const DETACHED_TTL_MS = 3_600_000; // 1 hour — events survive in durable store regardless
export const PERMISSION_TIMEOUT_MS = 120_000; // 2 minutes
export const NTFY_NOTIFICATION_DELAY_MS = 10_000; // 10 seconds

// --- Tool display ---
export const TOOL_RESULT_MAX_CHARS = 50_000;
export const NOTIFY_INPUT_MAX_CHARS = 100;
export const TOOL_SUMMARY_MAX_CHARS = 200;
export const RAW_INPUT_MAX_CHARS = 50_000;

// --- Notifications ---
export const NOTIFY_SNIPPET_MAX_CHARS = 150;

// --- Worktree ---
export const WORKTREE_BRANCH_PREFIX = 'session/';
export const WORKTREE_STALE_HOURS = 168; // 7 days
export const WORKTREE_GIT_TIMEOUT_MS = 30_000;
export const WORKTREE_REMOVE_TIMEOUT_MS = 15_000;
export const WORKTREE_PRUNE_TIMEOUT_MS = 5_000;

// --- Git ---
export const GIT_BRANCH_TIMEOUT_MS = 5_000;

// --- Session listing ---
export const SESSION_LIST_LIMIT = 20;
export const SESSION_MESSAGES_LIMIT = 100;

// --- Observers ---
export const MAX_OBSERVERS_PER_SESSION = 10;

// --- Token tracking ---
// All current Claude models share a 200k context window.
// If a model with a different ceiling is added, update this constant.
export const CONTEXT_CEILING_TOKENS = 200_000;

// --- Server ---
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const PORT_DEFAULT = 3100;
export const SHUTDOWN_GRACE_MS = 5_000;
