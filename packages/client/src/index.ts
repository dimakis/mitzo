// @mitzo/client — shared frontend package
//
// Framework-agnostic store, protocol parser, API client, and WS connection.
// React hooks are a separate tree-shakeable export at '@mitzo/client/hooks'.

// Transport
export type { TransportAdapter, WsConnection, WsHandlers } from './types.js';
export { WS_READY_STATE } from './types.js';

// Store
export { createMitzoStore } from './store.js';
export type { MitzoStoreState, MitzoStoreOptions } from './store.js';

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
} from './api-client.js';

// WS connection
export { WsPool } from './ws-connection.js';
export type { WsPoolConfig, WebSocketLike, MsgListener } from './ws-connection.js';
