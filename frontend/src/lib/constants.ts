// Frontend-wide constants. Every hardcoded value lives here.

// --- WebSocket ---
export const WS_RECONNECT_DELAY_MS = 500;
export const WS_RECONNECT_POLL_MS = 5_000;
export const WS_MAX_BUFFER_SIZE = 500;

// --- Chat UI ---
export const SCROLL_NEAR_BOTTOM_PX = 150;
export const SCROLL_RESTORE_DELAY_MS = 100;
export const CHAT_CACHE_KEY_PREFIX = 'mitzo-chat-';
export const LAST_SESSION_KEY = 'mitzo-last-session';
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

// --- Tool grouping ---
export const TOOL_GROUP_THRESHOLD = 3;

// --- Attachments ---
export const MAX_IMAGE_ATTACHMENTS = 4;
