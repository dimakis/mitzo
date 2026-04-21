// Harness-level constants. Protocol constants are re-exported from @mitzo/protocol.
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
export const DETACHED_TTL_MS = 172_800_000; // 48 hours — personal instance, negligible resource cost
export const CLOSEOUT_LEAD_MS = 600_000; // 10 minutes before TTL expiry, start closeout
export const CLOSEOUT_TIMEOUT_MS = 600_000; // 10 minutes max for the agent to finish closeout
export const PERMISSION_TIMEOUT_MS = 120_000; // 2 minutes
export const NTFY_NOTIFICATION_DELAY_MS = 10_000; // 10 seconds
