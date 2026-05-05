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
  SessionSearchResult,
  EventStoreLogger,
  ProgressItemStatus,
  ProgressItem,
  ProgressBlock,
  SessionActivityState,
  WaitReason,
  SessionActivity,
  ServiceHealthStatus,
  ServiceHealthPayload,
  SubagentUsage,
  StreamingSubagentState,
  FinishedSubagentState,
  SubagentState,
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

// WS schemas (v1 — legacy, used during migration)
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

// WS schemas (v2 — single-WS protocol with server-side session routing)
export {
  HelloMessage,
  ReconnectMessage,
  WatchMessage,
  UnwatchMessage,
  SwitchSessionMessage,
  SessionSuspendMessage,
  V2SendMessage,
  V2InterruptMessage,
  V2StopMessage,
  V2PermissionResponseMessage,
  V2SetModeMessage,
  IncomingWsMessageV2,
} from './ws-schemas-v2.js';

// Event store — the EventStore class requires better-sqlite3 and must be
// imported via '@mitzo/protocol/event-store' to avoid breaking frontend/browser
// consumers that don't have the native dependency.
// StoredEvent, SessionMeta, and EventStoreLogger types are in './types.js' above.
