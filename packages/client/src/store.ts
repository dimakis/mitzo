/**
 * MitzoStore factory — zustand vanilla store wiring all slices.
 *
 * Framework-agnostic: creates a vanilla zustand store, not a React hook.
 * React wrappers live in hooks/ and are a separate tree-shakeable import.
 */

import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';
import type { MitzoMode, ImageAttachment } from '@mitzo/protocol';

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
import type { TasksState, Task, LoopStatus } from './slices/tasks.js';
import { INITIAL_INBOX_STATE } from './slices/inbox.js';
import type { InboxState } from './slices/inbox.js';
import { INITIAL_CALENDAR_STATE } from './slices/calendar.js';
import type { CalendarState } from './slices/calendar.js';
import { INITIAL_TODOS_STATE } from './slices/todos.js';
import type { TodosState } from './slices/todos.js';
import { INITIAL_CONFIG_STATE } from './slices/config.js';
import type { ConfigState } from './slices/config.js';
import { parseServerMessage } from './protocol-parser.js';
import type { ProtocolParserState, ProtocolCallbacks } from './protocol-parser.js';
import type { WsMsg } from './server-messages.js';
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

// ─── Tree helpers ───────────────────────────────────────────────────────────

/** Recursively replace a task by ID anywhere in the tree. */
function updateTaskInTree(tasks: Task[], updated: Task): Task[] {
  return tasks.map((t) => {
    if (t.id === updated.id) return updated;
    if (t.children.length > 0) {
      const newChildren = updateTaskInTree(t.children, updated);
      return newChildren !== t.children ? { ...t, children: newChildren } : t;
    }
    return t;
  });
}

/** Recursively remove a task by ID anywhere in the tree. */
function removeTaskFromTree(tasks: Task[], id: string): Task[] {
  return tasks
    .filter((t) => t.id !== id)
    .map((t) => {
      if (t.children.length > 0) {
        const newChildren = removeTaskFromTree(t.children, id);
        return newChildren !== t.children ? { ...t, children: newChildren } : t;
      }
      return t;
    });
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createMitzoStore(options: MitzoStoreOptions): StoreApi<MitzoStoreState> {
  const api = new MitzoApiClient(options.transport.fetch.bind(options.transport));
  const wsPool = new WsPool(options.wsConfig);

  // Protocol parser state — mutable, shared across all messages
  const parserState: ProtocolParserState = {
    currentSessionId: undefined,
    pendingSend: null,
  };

  // Track the actual WS pool key so wsListener routes to the correct entry
  let activePoolKey: string | null = null;

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
      const poolKey = `session:${id}`;
      activePoolKey = poolKey;

      // Reset messages state for new session
      set((s) => ({
        sessions: { ...s.sessions, active: id },
        messages: INITIAL_MESSAGES_STATE,
        permissions: INITIAL_PERMISSIONS_STATE,
      }));

      // Subscribe to WS messages for this session
      wsPool.subscribe(poolKey, wsListener);

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
        : null;
      const clientMsgId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // For new sessions, subscribe first so the pool entry exists
      if (!poolKey) {
        const newKey = `new:${Date.now()}`;
        activePoolKey = newKey;
        wsPool.subscribe(newKey, wsListener);

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

        const sent = wsPool.send(newKey, msg);
        if (!sent) {
          set({ sendError: 'Not connected. Message will be sent when reconnected.' });
        }
        return;
      }

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
      if (get().messages.running) {
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
      set({ permissions: { pending: null } });
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

  // ── WS → store wiring ──────────────────────────────────────────────────
  // Central listener: routes every WS message through the protocol parser
  // and dispatches resulting actions into the store.

  const callbacks: ProtocolCallbacks = {
    onSessionAssigned(sessionId: string) {
      parserState.currentSessionId = sessionId;
      activePoolKey = `session:${sessionId}`;
      store.setState((s) => ({
        sessions: { ...s.sessions, active: sessionId },
      }));
    },

    onSessionExpired(_sessionId: string) {
      parserState.currentSessionId = undefined;
      store.setState((s) => ({
        sessions: { ...s.sessions, active: null },
        messages: INITIAL_MESSAGES_STATE,
      }));
    },

    onMessagesRestored() {
      // Triggered after reattach_failed recovery — reload messages from API
      if (parserState.currentSessionId) {
        api
          .getSessionMessages(parserState.currentSessionId)
          .then((msgs) => {
            if (Array.isArray(msgs) && msgs.length > 0) {
              store.setState((s) => ({
                messages: messagesReducer(s.messages, { type: 'RESTORE', messages: msgs }),
              }));
            }
          })
          .catch(() => {});
      }
    },

    fetchMessages(sessionId: string, signal: AbortSignal) {
      return api.getSessionMessages(sessionId, signal);
    },

    setWsRunning(poolKey: string, running: boolean) {
      wsPool.setRunning(poolKey, running);
    },

    sendQueued(poolKey: string, msg: unknown) {
      wsPool.send(poolKey, msg);
    },
  };

  function wsListener(wsMsg: WsMsg) {
    const poolKey = activePoolKey ?? 'default';

    const result = parseServerMessage(wsMsg, parserState, callbacks, poolKey);

    // Dispatch messages actions
    for (const action of result.messagesActions) {
      store.setState((s) => ({
        messages: messagesReducer(s.messages, action),
      }));
    }

    // Dispatch tasks update
    if (result.tasksUpdate) {
      switch (result.tasksUpdate.type) {
        case 'task_state':
          store.setState((s) => ({
            tasks: { ...s.tasks, tree: (result.tasksUpdate as { tasks: Task[] }).tasks },
          }));
          break;
        case 'task_updated': {
          const updated = result.tasksUpdate.task;
          store.setState((s) => ({
            tasks: { ...s.tasks, tree: updateTaskInTree(s.tasks.tree, updated) },
          }));
          break;
        }
        case 'task_deleted': {
          const deletedId = result.tasksUpdate.taskId;
          store.setState((s) => ({
            tasks: { ...s.tasks, tree: removeTaskFromTree(s.tasks.tree, deletedId) },
          }));
          break;
        }
        case 'loop_status':
          store.setState((s) => ({
            tasks: {
              ...s.tasks,
              loopStatus: (result.tasksUpdate as { status: LoopStatus }).status,
            },
          }));
          break;
      }
    }

    // Connection update
    if (result.connectionUpdate) {
      store.setState((s) => ({
        connection: { ...s.connection, ...result.connectionUpdate },
      }));
    }

    // Inbox refresh
    if (result.inboxRefresh) {
      api
        .getInbox()
        .then((items) => {
          store.setState({ inbox: { items, count: items.length } });
        })
        .catch(() => {});
    }
  }

  return store;
}
