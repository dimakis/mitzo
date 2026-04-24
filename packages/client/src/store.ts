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
import { INITIAL_PROGRESS_STATE, applyProgressUpdate } from './slices/progress.js';
import type { ProgressState } from './slices/progress.js';
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
  isolation?: boolean;
}

export interface PendingSession {
  prompt: string;
  context: string;
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
  progress: ProgressState;

  // Error state
  sendError: string | null;

  // Pending session (for "Start Session" from inbox/todo)
  pendingSession: PendingSession | null;

  // Actions — chat
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

  // Actions — tasks
  loadTasks(): Promise<void>;
  loadLoopStatus(): Promise<void>;
  createTask(input: Record<string, unknown>): Promise<void>;
  updateTask(id: string, input: Record<string, unknown>): Promise<void>;
  deleteTask(id: string): Promise<void>;
  startLoop(goalId: string, specMode?: boolean): Promise<void>;
  pauseLoop(): Promise<void>;
  resumeLoop(): Promise<void>;
  stopLoop(): Promise<void>;
  approveTask(id: string): Promise<void>;
  rejectTask(id: string, feedback: string): Promise<void>;
  approveSpec(): Promise<void>;
  rejectSpec(): Promise<void>;
  refreshTasks(): void;

  // Actions — inbox
  loadInbox(): Promise<void>;

  // Actions — todos
  loadTodos(): Promise<void>;

  // Actions — pending session
  setPendingSession(ps: PendingSession): void;
  clearPendingSession(): void;

  // Actions — lifecycle
  forceReconnect(): void;
  sendSuspend(): void;
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

const PENDING_SEND_TIMEOUT_MS = 5_000;

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createMitzoStore(options: MitzoStoreOptions): StoreApi<MitzoStoreState> {
  const api = new MitzoApiClient(options.transport.fetch.bind(options.transport));
  const connection = new MitzoConnection(options.wsConfig);

  const parserState: ProtocolParserState & {
    pendingSendTimer?: ReturnType<typeof setTimeout>;
  } = {
    currentSessionId: undefined,
    pendingSend: null,
  };

  let recoveryInFlight = false;

  function fetchAndRestoreMessages(sessionId: string) {
    if (recoveryInFlight) return;
    recoveryInFlight = true;
    api
      .getSessionMessages(sessionId)
      .then((msgs) => {
        if (Array.isArray(msgs)) {
          store.setState((s) => ({
            messages:
              msgs.length > 0
                ? messagesReducer(s.messages, { type: 'RESTORE', messages: msgs })
                : { ...s.messages, messages: [], current: null },
          }));
        }
      })
      .catch((err) => {
        if (typeof console !== 'undefined') {
          console.warn('[mitzo] message recovery fetch failed', err);
        }
      })
      .finally(() => {
        recoveryInFlight = false;
      });
  }

  function clearPendingSendTimer() {
    if (parserState.pendingSendTimer) {
      clearTimeout(parserState.pendingSendTimer);
      parserState.pendingSendTimer = undefined;
    }
  }

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
    progress: INITIAL_PROGRESS_STATE,
    sendError: null,
    pendingSession: null,

    // ── Actions ──────────────────────────────────────────────────────────

    dispatchMessages(action: MessagesAction) {
      set((s) => ({ messages: messagesReducer(s.messages, action) }));
    },

    async switchSession(id: string) {
      const oldId = parserState.currentSessionId;
      if (oldId) {
        // clearSession stops seq tracking. No suspend needed — session_suspend
        // is for iOS backgrounding (imminent WS death), not session switching.
        // Sending suspend here would leave the old session in suspended state
        // with no resume path, causing it to buffer events until grace expiry.
        connection.clearSession(oldId);
      }
      parserState.currentSessionId = id;

      set((s) => ({
        sessions: { ...s.sessions, active: id },
        messages: INITIAL_MESSAGES_STATE,
        permissions: INITIAL_PERMISSIONS_STATE,
        tokens: INITIAL_TOKENS_STATE,
        progress: INITIAL_PROGRESS_STATE,
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
      for (const sid of connection.getTrackedSessions()) {
        connection.clearSession(sid);
      }
      parserState.currentSessionId = undefined;
      parserState.pendingSend = null;
      clearPendingSendTimer();
      connection.send({ type: 'switch_session', sessionId: null });
      set({
        sessions: { ...get().sessions, active: null },
        messages: INITIAL_MESSAGES_STATE,
        permissions: INITIAL_PERMISSIONS_STATE,
        progress: INITIAL_PROGRESS_STATE,
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
        if (opts?.isolation !== undefined) msg.isolation = opts.isolation;
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
        // Safety net: if no session_end arrives within 5s (e.g. stale running
        // state after reconnect), flush the pending message as a new session.
        if (parserState.pendingSendTimer) clearTimeout(parserState.pendingSendTimer);
        parserState.pendingSendTimer = setTimeout(() => {
          const pending = parserState.pendingSend;
          if (!pending) return;
          parserState.pendingSend = null;
          parserState.pendingSendTimer = undefined;
          set((s) => ({
            messages: messagesReducer(s.messages, { type: 'SET_RUNNING', running: true }),
          }));
          connection.send(pending);
        }, PENDING_SEND_TIMEOUT_MS);
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
      if (!parserState.currentSessionId) return;
      connection.send({
        type: 'stop',
        sessionId: parserState.currentSessionId,
      });
    },

    respondToPermission(permId: string, decision: 'once' | 'always' | 'deny') {
      const sent = connection.send({
        type: 'permission_response',
        ...(parserState.currentSessionId ? { sessionId: parserState.currentSessionId } : {}),
        permId,
        decision,
      });
      if (sent) {
        set((s) => ({
          permissions: { pending: null },
          messages: { ...s.messages, permission: null },
        }));
      }
      // If not sent, leave the banner visible so user can retry
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

    // ── Task actions ──────────────────────────────────────────────────────

    async loadTasks() {
      try {
        const tasks = await api.getTasks();
        set((s) => ({ tasks: { ...s.tasks, tree: tasks } }));
      } catch {
        // Graceful — keep existing tree
      }
    },

    async loadLoopStatus() {
      try {
        const status = await api.getLoopStatus();
        if (status) {
          set((s) => ({
            tasks: {
              ...s.tasks,
              loopStatus: {
                state: (status.state ?? 'idle') as LoopStatus['state'],
                goalId: status.goalId ?? null,
                activeTaskId: status.activeTaskId ?? null,
                progress: (status.progress as LoopStatus['progress']) ?? null,
                specMode: status.specMode ?? false,
                awaitingApproval: status.awaitingApproval ?? false,
              },
            },
          }));
        }
      } catch {
        // Graceful — keep existing status
      }
    },

    async createTask(input: Record<string, unknown>) {
      await api.createTask(input as Partial<Task>);
    },

    async updateTask(id: string, input: Record<string, unknown>) {
      await api.updateTask(id, input as Partial<Task>);
    },

    async deleteTask(id: string) {
      await api.deleteTask(id);
    },

    async startLoop(goalId: string, specMode?: boolean) {
      await api.startLoop(goalId, specMode);
    },

    async pauseLoop() {
      await api.pauseLoop();
    },

    async resumeLoop() {
      await api.resumeLoop();
    },

    async stopLoop() {
      await api.stopLoop();
    },

    async approveTask(id: string) {
      await api.approveTask(id);
    },

    async rejectTask(id: string, feedback: string) {
      await api.rejectTask(id, feedback);
    },

    async approveSpec() {
      await api.approveSpec();
    },

    async rejectSpec() {
      await api.rejectSpec();
    },

    refreshTasks() {
      get().loadTasks();
      get().loadLoopStatus();
    },

    // ── Inbox actions ─────────────────────────────────────────────────────

    async loadInbox() {
      try {
        const items = await api.getInbox();
        set({ inbox: { items, count: items.length } });
      } catch {
        // Graceful — keep existing inbox
      }
    },

    // ── Todo actions ──────────────────────────────────────────────────────

    async loadTodos() {
      try {
        const data = await api.getTodos();
        set({ todos: { items: data.items ?? [], profiles: data.profiles ?? [] } });
      } catch {
        // Graceful — keep existing todos
      }
    },

    // ── Pending session actions ────────────────────────────────────────

    setPendingSession(ps: PendingSession) {
      set({ pendingSession: ps });
    },

    clearPendingSession() {
      set({ pendingSession: null });
    },

    forceReconnect() {
      connection.checkAndReconnect();
    },

    sendSuspend() {
      connection.sendSuspend();
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
      // No-op: server-side resume validation handles expired sessions now.
      // Kept to satisfy ProtocolCallbacks interface.
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

    onReconnected() {
      const activeId = parserState.currentSessionId;
      if (activeId) fetchAndRestoreMessages(activeId);
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
    // Foreground recovery: when the page becomes visible again (iOS may have
    // evicted it from memory, losing in-memory state), re-fetch messages from
    // the REST API if we have an active session but no messages in the store.
    if (msg.type === '_foreground') {
      const { sessions } = store.getState();
      if (sessions.active) fetchAndRestoreMessages(sessions.active);
      return;
    }

    if (msg.type === 'session_resumed') {
      if (typeof console !== 'undefined') {
        console.debug('[mitzo] session resumed', {
          sessionId: msg.sessionId,
          replayed: msg.replayed,
        });
      }
      return;
    }

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
        // Allow session_id (new session assignment) and permission_request
        // (can arrive before session_id on the first turn) through when no
        // active session. Drop everything else (session_end, etc.) to prevent
        // foreign session bleed.
        const isFirstTurnEvent = msg.type === 'session_id' || msg.type === 'permission_request';
        if (!isFirstTurnEvent) return;
      }
    }

    const result = parseServerMessage(msg as WsMsg, parserState, callbacks, 'v2');

    // If the parser consumed the pending send (session_end handler), cancel the
    // safety-net timer — the normal flush path handled it.
    if (!parserState.pendingSend && parserState.pendingSendTimer) {
      clearPendingSendTimer();
    }

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

    if (result.progressUpdate) {
      store.setState((s) => ({
        progress: applyProgressUpdate(s.progress, result.progressUpdate!),
      }));
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
