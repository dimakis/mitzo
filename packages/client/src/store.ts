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
import { WsPool } from './ws-connection.js';
import type { WsPoolConfig } from './ws-connection.js';

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

  // Unsubscribe handle for the current WS subscription — called when
  // switching sessions or starting a new one so old session messages
  // don't leak into the new session's state.
  let activeUnsub: (() => void) | null = null;

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
      // Unsubscribe the listener so old events stop hitting the store,
      // then defuse the pool entry so it won't reattach on reconnect
      // (wasRunning=false prevents the reattach handshake that causes bleed).
      activeUnsub?.();
      if (activePoolKey) {
        wsPool.setRunning(activePoolKey, false);
        wsPool.removeIfIdle(activePoolKey);
      }

      parserState.currentSessionId = id;
      const poolKey = `session:${id}`;
      activePoolKey = poolKey;

      // Reset messages state for new session
      set((s) => ({
        sessions: { ...s.sessions, active: id },
        messages: INITIAL_MESSAGES_STATE,
        permissions: INITIAL_PERMISSIONS_STATE,
        tokens: INITIAL_TOKENS_STATE,
      }));

      // Subscribe to WS messages for this session
      activeUnsub = wsPool.subscribe(poolKey, wsListener);

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
      activeUnsub?.();
      if (activePoolKey) {
        wsPool.setRunning(activePoolKey, false);
        wsPool.removeIfIdle(activePoolKey);
      }
      activeUnsub = null;
      activePoolKey = null;
      parserState.currentSessionId = undefined;
      set({
        sessions: { ...get().sessions, active: null },
        messages: INITIAL_MESSAGES_STATE,
        permissions: INITIAL_PERMISSIONS_STATE,
      });
    },

    sendMessage(text: string, opts?: SendMessageOptions) {
      const poolKey = parserState.currentSessionId
        ? `session:${parserState.currentSessionId}`
        : null;
      const clientMsgId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Capture whether a turn is in-flight BEFORE we dispatch USER_SEND.
      // USER_SEND flips messages.running to true so the composer can show
      // the stop button — if we read running after dispatching, every
      // follow-up would incorrectly look like it arrived mid-turn and get
      // silently queued in parserState.pendingSend forever.
      const wasRunning = get().messages.running;

      const buildPayload = (): Record<string, unknown> => {
        const msg: Record<string, unknown> = {
          type: 'send',
          prompt: text,
          clientMsgId,
        };
        const model = opts?.model ?? get().config.modelId;
        const mode = opts?.mode ?? get().config.mode;
        if (model) msg.model = model;
        if (mode) msg.mode = mode;
        if (parserState.currentSessionId) msg.resume = parserState.currentSessionId;
        if (opts?.contextBlocks?.length) msg.contextBlocks = opts.contextBlocks;
        if (opts?.images?.length) {
          msg.images = opts.images.map((img) => ({ data: img.data, mediaType: img.mediaType }));
        }
        if (opts?.cwd) msg.cwd = opts.cwd;
        if (opts?.extraTools) msg.extraTools = opts.extraTools;
        return msg;
      };

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

      // For new sessions, subscribe first so the pool entry exists
      if (!poolKey) {
        activeUnsub?.();
        const newKey = `new:${Date.now()}`;
        activePoolKey = newKey;
        activeUnsub = wsPool.subscribe(newKey, wsListener);
        wsPool.setRunning(newKey, true);

        const sent = wsPool.send(newKey, buildPayload());
        if (!sent) {
          set({ sendError: 'Not connected. Message will be sent when reconnected.' });
        }
        return;
      }

      const msg = buildPayload();

      // If a turn was already running when the user hit send, queue the
      // payload and flush it once the server signals session_end.
      if (wasRunning) {
        parserState.pendingSend = msg;
      } else {
        wsPool.setRunning(poolKey, true);
        const sent = wsPool.send(poolKey, msg);
        if (!sent) {
          set({ sendError: 'Not connected. Message will be sent when reconnected.' });
        }
      }
    },

    interruptMessage(text: string, opts?: SendMessageOptions) {
      const poolKey = parserState.currentSessionId
        ? `session:${parserState.currentSessionId}`
        : null;
      if (!poolKey || !get().messages.running) return;

      const clientMsgId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const msg: Record<string, unknown> = {
        type: 'interrupt',
        prompt: text,
        clientMsgId,
      };
      if (opts?.images?.length) {
        msg.images = opts.images.map((img) => ({ data: img.data, mediaType: img.mediaType }));
      }
      if (opts?.contextBlocks?.length) msg.contextBlocks = opts.contextBlocks;

      const sent = wsPool.send(poolKey, msg);
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
  // Central listener: routes every WS message through the protocol parser
  // and dispatches resulting actions into the store.

  const callbacks: ProtocolCallbacks = {
    onSessionAssigned(sessionId: string) {
      parserState.currentSessionId = sessionId;
      activePoolKey = `session:${sessionId}`;
      store.setState((s) => ({
        sessions: { ...s.sessions, active: sessionId },
      }));
      store.getState().refreshSessions();
    },

    onSessionExpired() {
      parserState.currentSessionId = undefined;
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

    // Token update
    if (result.tokensUpdate) {
      store.setState((s) => ({
        tokens: { ...s.tokens, ...result.tokensUpdate },
      }));
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
      store.getState().refreshSessions();
    }
  }

  return store;
}
