// Frontend-wide constants. Every hardcoded value lives here.

// --- WebSocket ---
export const WS_RECONNECT_DELAY_MS = 500;
export const WS_RECONNECT_POLL_MS = 5_000;
// --- Chat UI ---
export const SCROLL_NEAR_BOTTOM_PX = 150;
export const SCROLL_RESTORE_DELAY_MS = 100;
export const LAST_SESSION_KEY = 'mitzo-last-session';
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

// --- Tool grouping ---
export const TOOL_GROUP_THRESHOLD = 3;

// --- Attachments ---
export const MAX_IMAGE_ATTACHMENTS = 4;

// --- Voice / Yapper ---
export const YAPPER_URL =
  import.meta.env.VITE_YAPPER_URL ||
  `${typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.host}` : 'http://localhost'}/api/yapper`;
export const YAPPER_HEALTH_POLL_MS = 30_000;
export const MAX_RECORDING_DURATION_MS = 120_000;
export const MIN_RECORDING_DURATION_MS = 500;
export const TTS_CHUNK_MAX_CHARS = 500;
export const TTS_CHUNK_MIN_CHARS = 10;
export const TTS_MAX_SPEAK_CHARS = 2000;
export const TTS_ENABLED_KEY = 'mitzo-tts-enabled';
export const TTS_VOICE_KEY = 'mitzo-tts-voice';
export const DEFAULT_TTS_VOICE = 'af_heart';
export const DOCUMENT_READ_MAX_CHARS = 50_000;
