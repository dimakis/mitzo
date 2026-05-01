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
// Re-export session lifecycle constants from harness (canonical source).
export {
  DETACHED_TTL_MS,
  CLOSEOUT_LEAD_MS,
  CLOSEOUT_TIMEOUT_MS,
  PERMISSION_TIMEOUT_MS,
  NTFY_NOTIFICATION_DELAY_MS,
} from '@mitzo/harness';

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
export const GUARD_STATS_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const WORKTREE_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// --- Query loop ---
// If the Agent SDK yields no events within this window, we treat the turn
// as unreachable (e.g. model unavailable on the configured provider) and
// surface an error to the client instead of hanging forever.
export const QUERY_FIRST_EVENT_TIMEOUT_MS = 90_000;

// --- Observability ---
// Max characters for agent content recorded in OTel span events and log lines.
// Keeps Jaeger/Loki payloads bounded while preserving enough for debugging.
// Configurable via env var for runtime tuning without code changes.
export const TRACE_CONTENT_MAX_CHARS =
  parseInt(process.env.TRACE_CONTENT_MAX_CHARS ?? '', 10) || 16_384;
