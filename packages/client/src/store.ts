/**
 * MitzoStore factory — zustand vanilla store wiring all slices.
 *
 * Framework-agnostic: creates a vanilla zustand store, not a React hook.
 * React wrappers live in hooks/ and are a separate tree-shakeable import.
 */

import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';
import type { FinishedMessage, MitzoMode, ImageAttachment } from '@mitzo/protocol';

import type { TransportAdapter } from './types.js';
import { messagesReducer, INITIAL_MESSAGES_STATE } from './slices/messages.js';
import type { MessagesState, MessagesAction } from './slices/messages.js';
import { INITIAL_SESSIONS_STATE } from './slices/sessions.js';
import type { SessionsState } from './slices/sessions.js';
import { INITIAL_CONNECTION_STATE } from './slices/connection.js';
import type { ConnectionState } from './slices/connection.js';
import { INITIAL_PERMISSIONS_STATE } from './slices/permissions.js';
import type { PermissionsState } from './slices/permissions.js';
import { INITIAL_TASKS_STATE } from './slices/tasks.js';
import type { TasksState, Task } from './slices/tasks.js';
import { INITIAL_INBOX_STATE } from './slices/inbox.js';
import type { InboxState } from './slices/inbox.js';
import { INITIAL_CALENDAR_STATE } from './slices/calendar.js';
import type { CalendarState } from './slices/calendar.js';
import { INITIAL_TODOS_STATE } from './slices/todos.js';
import type { TodosState } from './slices/todos.js';
import { INITIAL_CONFIG_STATE } from './slices/config.js';
import type { ConfigState } from './slices/config.js';
import { parseServerMessage } from './protocol-parser.js';
import type { ProtocolParserState } from './protocol-parser.js';
import { MitzoApiClient } from './api-client.js';
import { WsPool } from './ws-connection.js';
import type { WsPoolConfig } from './ws-connection.js';

// ─── Store state ─────────────────────────────────────────────────────────────

export interface MitzoStoreState {
  // Slices
  sessions: SessionsState;
  messages: MessagesState;
  connection: ConnectionState;
  permissions: PermissionsState;
  tasks: TasksState;
  inbox: InboxState;
  calendar: CalendarState;
  todos: TodosState;
  config: ConfigState;

  // Error state
  sendError: string | null;

  // Actions
  dispatchMessages(action: MessagesAction): void;
  switchSession(id: string): Promise<void>;
  newSession(): void;
  sendMessage(text: string, opts?: { contextBlocks?: string[]; images?: ImageAttachment[] }): void;
  stopGeneration(): void;
  respondToPermission(permId: string, decision: 'once' | 'always' | 'deny'): void;
  setMode(mode: MitzoMode): void;
  setModel(modelId: string): void;
}

// ─── Store options ───────────────────────────────────────────────────────────

export interface MitzoStoreOptions {
  transport: TransportAdapter;
  wsConfig: WsPoolConfig;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createMitzoStore(
  options: MitzoStoreOptions,
): StoreApi<MitzoStoreState> {
  const api = new MitzoApiClient(options.transport.fetch.bind(options.transport));
  const wsPool = new WsPool(options.wsConfig);

  // Protocol parser state — mutable, shared across all messages
  const parserState: ProtocolParserState = {
    currentSessionId: undefined,
    pendingSend: null,
  };

  const store = createStore<MitzoStoreState>((set, get) => ({
    // ── Initial state ────────────────────────────────────────────────────

    sessions: INITIAL_SESSIONS_STATE,
    messages: INITIAL_MESSAGES_STATE,
    connection: INITIAL_CONNECTION_STATE,
    permissions: INITIAL_PERMISSIONS_STATE,
    tasks: INITIAL_TASKS_STATE,
    inbox: INITIAL_INBOX_STATE,
    calendar: INITIAL_CALENDAR_STATE,
    todos: INITIAL_TODOS_STATE,
    config: INITIAL_CONFIG_STATE,
    sendError: null,

    // ── Actions ──────────────────────────────────────────────────────────

    dispatchMessages(action: MessagesAction) {
      set((s) => ({ messages: messagesReducer(s.messages, action) }));
    },

    async switchSession(id: string) {
      parserState.currentSessionId = id;

      // Reset messages state for new session
      set((s) => ({
        sessions: { ...s.sessions, active: id },
        messages: INITIAL_MESSAGES_STATE,
        permissions: INITIAL_PERMISSIONS_STATE,
      }));

      // Load session messages
      try {
        const msgs = await api.getSessionMessages(id);
        if (Array.isArray(msgs) && msgs.length > 0) {
          set((s) => ({
            messages: messagesReducer(s.messages, { type: 'RESTORE', messages: msgs }),
          }));
        }
      } catch {
        // Session may be expired — handle gracefully
      }
    },

    newSession() {
      parserState.currentSessionId = undefined;
      set({
        sessions: { ...get().sessions, active: null },
        messages: INITIAL_MESSAGES_STATE,
        permissions: INITIAL_PERMISSIONS_STATE,
      });
    },

    sendMessage(text: string, opts?: { contextBlocks?: string[]; images?: ImageAttachment[] }) {
      const poolKey = parserState.currentSessionId
        ? `session:${parserState.currentSessionId}`
        : `new:${Date.now()}`;
      const clientMsgId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Optimistic update
      set((s) => ({
        messages: messagesReducer(s.messages, {
          type: 'USER_SEND',
          text,
          clientMsgId,
          images: opts?.images?.map((img) => img.preview),
          contextBlocks: opts?.contextBlocks,
        }),
        sendError: null,
      }));

      const msg: Record<string, unknown> = {
        type: 'send',
        prompt: text,
        clientMsgId,
      };
      if (opts?.contextBlocks) msg.contextBlocks = opts.contextBlocks;
      if (opts?.images) msg.images = opts.images;

      // If running, queue for after session_end
      if (get().messages.running && parserState.currentSessionId) {
        parserState.pendingSend = msg;
      } else {
        const sent = wsPool.send(poolKey, msg);
        if (!sent) {
          set({ sendError: 'Not connected. Message will be sent when reconnected.' });
        }
      }
    },

    stopGeneration() {
      const poolKey = parserState.currentSessionId
        ? `session:${parserState.currentSessionId}`
        : null;
      if (poolKey) {
        wsPool.send(poolKey, { type: 'interrupt' });
      }
    },

    respondToPermission(permId: string, decision: 'once' | 'always' | 'deny') {
      const poolKey = parserState.currentSessionId
        ? `session:${parserState.currentSessionId}`
        : null;
      if (poolKey) {
        wsPool.send(poolKey, {
          type: 'permission_response',
          permId,
          decision,
        });
      }
      set((s) => ({
        permissions: { pending: null },
      }));
    },

    setMode(mode: MitzoMode) {
      const poolKey = parserState.currentSessionId
        ? `session:${parserState.currentSessionId}`
        : null;
      if (poolKey) {
        wsPool.send(poolKey, { type: 'set_mode', mode });
      }
      set((s) => ({
        config: { ...s.config, mode },
      }));
    },

    setModel(modelId: string) {
      set((s) => ({
        config: { ...s.config, modelId },
      }));
    },
  }));

  return store;
}
