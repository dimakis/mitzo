// Protocol-level constants. Only values relevant to the v2 protocol, event store,
// message accumulation, and shared parsing live here. Server-specific constants
// (worktree, git, heartbeat, ports) stay in the app layer.

// --- Tool display ---
export const TOOL_RESULT_MAX_CHARS = 50_000;
export const TOOL_SUMMARY_MAX_CHARS = 200;
export const RAW_INPUT_MAX_CHARS = 50_000;

// --- Notifications ---
export const NOTIFY_SNIPPET_MAX_CHARS = 150;
export const NOTIFY_INPUT_MAX_CHARS = 100;

// --- Session listing ---
export const SESSION_PAGE_SIZE = 20;
export const SESSION_MESSAGES_LIMIT = 100;

// --- Observers ---
export const MAX_OBSERVERS_PER_SESSION = 10;

// --- Token tracking ---
export const CONTEXT_CEILING_TOKENS = 200_000;
