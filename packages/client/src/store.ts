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
import type { TasksState, Task, LoopStatus } from './slices/tasks.js';
import { INITIAL_INBOX_STATE } from './slices/inbox.js';
import type { InboxState } from './slices/inbox.js';
import { INITIAL_CALENDAR_STATE } from './slices/calendar.js';
import type { CalendarState } from './slices/calendar.js';
import { INITIAL_TODOS_STATE } from './slices/todos.js';
import type { TodosState } from './slices/todos.js';
import { INITIAL_CONFIG_STATE } from './slices/config.js';
import type { ConfigState } from './slices/config.js';
import { INITIAL_TOKENS_STATE } from './slices/tokens.js';
import type { TokensState } from './slices/tokens.js';
import { parseServerMessage } from './protocol-parser.js';
import type { ProtocolParserState, ProtocolCallbacks } from './protocol-parser.js';
import type { WsMsg } from './server-messages.js';
import { MitzoApiClient } from './api-client.js';
import { MitzoConnection } from './connection.js';
import type { MitzoConnectionConfig } from './connection.js';

// ─── Store state ─────────────────────────────────────────────────────────────

export interface SendMessageOptions {
  contextBlocks?: string[];
  images?: ImageAttachment[];
  model?: string;
  mode?: MitzoMode;
  cwd?: string;
  extraTools?: string;
}

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
  tokens: TokensState;

  // Error state
  sendError: string | null;

  // Actions
  dispatchMessages(action: MessagesAction): void;
  switchSession(id: string): Promise<void>;
  newSession(): void;
  sendMessage(text: string, opts?: SendMessageOptions): void;
  interruptMessage(text: string, opts?: SendMessageOptions): void;
  stopGeneration(): void;
  respondToPermission(permId: string, decision: 'once' | 'always' | 'deny'): void;
  setMode(mode: MitzoMode): void;
  setModel(modelId: string): void;
  loadSessions(): Promise<void>;
  refreshSessions(): Promise<void>;
  fetchSessionMeta(sessionId: string): Promise<void>;
}

// ─── Store options ───────────────────────────────────────────────────────────

export interface MitzoStoreOptions {
  transport: TransportAdapter;
  wsConfig: MitzoConnectionConfig;
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
  const connection = new MitzoConnection(options.wsConfig);

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
    tokens: INITIAL_TOKENS_STATE,
    sendError: null,

    // ── Actions ──────────────────────────────────────────────────────────

    dispatchMessages(action: MessagesAction) {
      set((s) => ({ messages: messagesReducer(s.messages, action) }));
    },

    async switchSession(id: string) {
      parserState.currentSessionId = id;

      set((s) => ({
        sessions: { ...s.sessions, active: id },
        messages: INITIAL_MESSAGES_STATE,
        permissions: INITIAL_PERMISSIONS_STATE,
        tokens: INITIAL_TOKENS_STATE,
      }));

      // v2: send switch_session for token hydration + server-side active tracking
      connection.send({ type: 'switch_session', sessionId: id });

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
      parserState.pendingSend = null;
      connection.send({ type: 'switch_session', sessionId: null });
      set({
        sessions: { ...get().sessions, active: null },
        messages: INITIAL_MESSAGES_STATE,
        permissions: INITIAL_PERMISSIONS_STATE,
      });
    },

    sendMessage(text: string, opts?: SendMessageOptions) {
      const clientMsgId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const wasRunning = get().messages.running;

      const buildPayload = (): Record<string, unknown> => {
        const msg: Record<string, unknown> = {
          type: 'send',
          sessionId: parserState.currentSessionId ?? null,
          prompt: text,
          clientMsgId,
        };
        const model = opts?.model ?? get().config.modelId;
        const mode = opts?.mode ?? get().config.mode;
        if (model) msg.model = model;
        if (mode) msg.mode = mode;
        if (opts?.contextBlocks?.length) msg.contextBlocks = opts.contextBlocks;
        if (opts?.images?.length) {
          msg.images = opts.images.map((img) => ({ data: img.data, mediaType: img.mediaType }));
        }
        if (opts?.cwd) msg.cwd = opts.cwd;
        if (opts?.extraTools) msg.extraTools = opts.extraTools;
        return msg;
      };

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

      const msg = buildPayload();

      if (wasRunning) {
        parserState.pendingSend = msg;
      } else {
        const sent = connection.send(msg);
        if (!sent) {
          set({ sendError: 'Not connected. Message will be sent when reconnected.' });
        }
      }
    },

    interruptMessage(text: string, opts?: SendMessageOptions) {
      if (!parserState.currentSessionId || !get().messages.running) return;

      const clientMsgId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const msg: Record<string, unknown> = {
        type: 'interrupt',
        sessionId: parserState.currentSessionId,
        prompt: text,
        clientMsgId,
      };
      if (opts?.images?.length) {
        msg.images = opts.images.map((img) => ({ data: img.data, mediaType: img.mediaType }));
      }
      if (opts?.contextBlocks?.length) msg.contextBlocks = opts.contextBlocks;

      const sent = connection.send(msg);
      if (!sent) {
        set({ sendError: 'Not connected. Interrupt was not delivered.' });
        return;
      }

      set((s) => ({
        messages: messagesReducer(s.messages, {
          type: 'USER_SEND',
          text,
          clientMsgId,
          images: opts?.images?.map((img) => img.preview),
          contextBlocks: opts?.contextBlocks,
        }),
      }));
    },

    stopGeneration() {
      connection.send({
        type: 'stop',
        sessionId: parserState.currentSessionId ?? null,
      });
    },

    respondToPermission(permId: string, decision: 'once' | 'always' | 'deny') {
      connection.send({
        type: 'permission_response',
        sessionId: parserState.currentSessionId ?? null,
        permId,
        decision,
      });
      set({ permissions: { pending: null } });
    },

    setMode(mode: MitzoMode) {
      if (parserState.currentSessionId) {
        connection.send({
          type: 'set_mode',
          sessionId: parserState.currentSessionId,
          mode,
        });
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

    async loadSessions() {
      set((s) => ({ sessions: { ...s.sessions, loading: true } }));
      try {
        const raw = await api.listSessions();
        const list = Array.isArray(raw)
          ? raw
          : ((raw as unknown as { sessions: typeof raw }).sessions ?? []);
        set((s) => ({ sessions: { ...s.sessions, list, loading: false } }));
      } catch {
        set((s) => ({ sessions: { ...s.sessions, loading: false } }));
      }
    },

    async refreshSessions() {
      try {
        const raw = await api.listSessions();
        const list = Array.isArray(raw)
          ? raw
          : ((raw as unknown as { sessions: typeof raw }).sessions ?? []);
        set((s) => ({ sessions: { ...s.sessions, list } }));
      } catch {
        // Silent — keep existing list on failure
      }
    },

    async fetchSessionMeta(sessionId: string) {
      try {
        const meta = await api.getSessionMeta(sessionId);
        if (!meta) return;
        if (meta.branch) {
          set((s) => ({
            messages: messagesReducer(s.messages, {
              type: 'SESSION_INFO',
              branch: meta.branch!,
              isWorktree: !!meta.wtId,
              wtId: meta.wtId ?? undefined,
            }),
          }));
        }
        if (meta.numTurns > 0) {
          set((s) => ({
            tokens: {
              ...s.tokens,
              sessionTotal: meta.totalTokens ?? s.tokens.sessionTotal,
              numTurns: meta.numTurns ?? s.tokens.numTurns,
              turnIndex: meta.numTurns ?? s.tokens.turnIndex,
            },
          }));
        }
      } catch {
        // Session meta may not be available — graceful no-op
      }
    },
  }));

  // ── WS → store wiring ──────────────────────────────────────────────────

  const callbacks: ProtocolCallbacks = {
    onSessionAssigned(sessionId: string) {
      parserState.currentSessionId = sessionId;
      store.setState((s) => ({
        sessions: { ...s.sessions, active: sessionId },
      }));
      store.getState().refreshSessions();
    },

    onSessionExpired() {
      parserState.currentSessionId = undefined;
      parserState.pendingSend = null;
      store.setState((s) => ({
        sessions: { ...s.sessions, active: null },
        messages: INITIAL_MESSAGES_STATE,
      }));
    },

    onSessionRenamed(name: string) {
      const sessionId = parserState.currentSessionId;
      if (!sessionId) return;
      store.setState((s) => ({
        sessions: {
          ...s.sessions,
          list: s.sessions.list.map((sess) =>
            sess.id === sessionId ? { ...sess, summary: name } : sess,
          ),
        },
      }));
    },

    onMessagesRestored(messages: FinishedMessage[]) {
      store.setState((s) => ({
        messages: messagesReducer(s.messages, { type: 'RESTORE', messages }),
      }));
    },

    fetchMessages(sessionId: string) {
      return api.getSessionMessages(sessionId);
    },

    onSendQueued(msg: Record<string, unknown>) {
      connection.send(msg);
    },

    onTokensHydrated(tokens: Record<string, unknown>) {
      store.setState((s) => ({
        tokens: {
          ...s.tokens,
          sessionTotal:
            ((tokens.input as number) ?? 0) +
            ((tokens.output as number) ?? 0) +
            ((tokens.cacheRead as number) ?? 0) +
            ((tokens.cacheCreation as number) ?? 0),
        },
      }));
    },
  };

  function wsListener(msg: Record<string, unknown>) {
    const eventSessionId = msg.sessionId as string | undefined;

    // Session-scoped event filtering for multiplexed v2 connections:
    // - No sessionId on the event → global (task_state, inbox_updated, etc.) → always accept
    // - sessionId matches currentSessionId → accept
    // - No active session AND event is session_id/session_end → accept (new session assignment)
    // - Otherwise → drop (foreign session event)
    if (eventSessionId) {
      if (parserState.currentSessionId) {
        if (eventSessionId !== parserState.currentSessionId) return;
      } else {
        const isAssignment = msg.type === 'session_id' || msg.type === 'session_end';
        if (!isAssignment) return;
      }
    }

    const result = parseServerMessage(msg as WsMsg, parserState, callbacks, 'v2');

    for (const action of result.messagesActions) {
      store.setState((s) => ({
        messages: messagesReducer(s.messages, action),
      }));
    }

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

    if (result.tokensUpdate) {
      store.setState((s) => ({
        tokens: { ...s.tokens, ...result.tokensUpdate },
      }));
    }

    if (result.connectionUpdate) {
      store.setState((s) => ({
        connection: { ...s.connection, ...result.connectionUpdate },
      }));
    }

    if (result.inboxRefresh) {
      api
        .getInbox()
        .then((items) => {
          store.setState({ inbox: { items, count: items.length } });
        })
        .catch(() => {});
      store.getState().refreshSessions();
    }
  }

  connection.onMessage(wsListener);
  connection.connect();

  return store;
}
