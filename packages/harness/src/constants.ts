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
export const DETACHED_TTL_MS = 3_600_000; // 1 hour — events survive in durable store regardless
export const PERMISSION_TIMEOUT_MS = 120_000; // 2 minutes
export const NTFY_NOTIFICATION_DELAY_MS = 10_000; // 10 seconds
