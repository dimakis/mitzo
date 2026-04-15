// @mitzo/protocol — shared types, schemas, and utilities for the Mitzo v2 protocol.

// Types
export type {
  MitzoMode,
  BlockType,
  ToolTier,
  RawToolInput,
  SnapshotBlock,
  MessageSnapshot,
  StreamingBlock,
  StreamingMessage,
  FinishedBlock,
  FinishedMessage,
  PermissionRequest,
  ImageAttachment,
  Session,
  StoredEvent,
  SessionMeta,
} from './types.js';

// Constants
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
} from './constants.js';

// Tool summary
export { getRawInput, summarizeToolInput } from './tool-summary.js';

// Content blocks
export { extractToolResultText, parseContentBlocks } from './content-blocks.js';

// Async queue
export { AsyncQueue } from './async-queue.js';

// WS schemas
export {
  ReattachMessage,
  SendMessage,
  InterruptMessage,
  StopMessage,
  PermissionResponseMessage,
  SetModeMessage,
  SubscribeMessage,
  IncomingWsMessage,
} from './ws-schemas.js';

// Event store (requires better-sqlite3 — optional peer dep)
export { EventStore } from './event-store.js';
