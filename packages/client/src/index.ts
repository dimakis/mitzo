// @mitzo/client — shared frontend package
//
// Framework-agnostic store, protocol parser, API client, and WS connection.
// React hooks are a separate tree-shakeable export at '@mitzo/client/hooks'.

// Transport
export type { TransportAdapter, WsConnection, WsHandlers } from './types.js';
export { WS_READY_STATE } from './types.js';

// Store
export { createMitzoStore } from './store.js';
export type {
  MitzoStoreState,
  MitzoStoreOptions,
  SendMessageOptions,
  PendingSession,
} from './store.js';

// Slices — state shapes and types
export type { MessagesState, MessagesAction, ActiveWorktree } from './slices/messages.js';
export { messagesReducer, INITIAL_MESSAGES_STATE } from './slices/messages.js';
export type { SessionsState } from './slices/sessions.js';
export type { ConnectionState, ConnectionStatus } from './slices/connection.js';
export type { PermissionsState } from './slices/permissions.js';
export type { TasksState, Task, TaskStatus, SessionPolicy, LoopStatus } from './slices/tasks.js';
export type { InboxState, InboxItem } from './slices/inbox.js';
export type { CalendarState, CalendarEvent, SprintInfo } from './slices/calendar.js';
export type { TodosState, TodoItem, TodoSource, TodoContextHints } from './slices/todos.js';
export type { ConfigState, ContextBlockEntry, SkillMetadata } from './slices/config.js';
export type { TokensState } from './slices/tokens.js';
export { INITIAL_TOKENS_STATE, DEFAULT_CONTEXT_CEILING } from './slices/tokens.js';
export type { ProgressState, ProgressUpdate } from './slices/progress.js';
export { INITIAL_PROGRESS_STATE, applyProgressUpdate } from './slices/progress.js';

// Protocol parser
export { parseServerMessage } from './protocol-parser.js';
export type { ProtocolCallbacks, ProtocolParserState, ParseResult } from './protocol-parser.js';

// Server messages
export type { ServerMessage, WsMsg } from './server-messages.js';

// API client
export { MitzoApiClient } from './api-client.js';
export type {
  ApiFetch,
  AppConfig,
  AuthCheckResult,
  VersionInfo,
  GitInfo,
  FileEntry,
  CalendarData,
  SessionMetaResponse,
} from './api-client.js';

// WS connection (v2)
export { MitzoConnection } from './connection.js';
export type { MitzoConnectionConfig, ConnectionListener } from './connection.js';

// WS connection (v1 — legacy, used by frontend ws-pool consumers)
export { WsPool } from './ws-connection.js';
export type { WsPoolConfig, WebSocketLike, MsgListener } from './ws-connection.js';

// SSE event bus (broadcast events)
export { EventBus } from './event-bus.js';
export type {
  EventBusListener,
  EventSourceFactory,
  ConnectionChangeCallback,
} from './event-bus.js';
