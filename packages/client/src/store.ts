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
import {
  INITIAL_WORKLOAD_STATE,
  updateWorkloadItem,
  batchUpdateWorkloadItems,
} from './slices/workload.js';
import type { WorkloadState } from './slices/workload.js';
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
import { SseConnection } from './sse-connection.js';
import type { SseConnectionConfig } from './sse-connection.js';
import type { ChatConnection } from './chat-connection.js';

// ─── Store state ─────────────────────────────────────────────────────────────

export interface SendMessageOptions {
  accountId?: string;
  contextBlocks?: string[];
  images?: ImageAttachment[];
  model?: string;
  reasoningEffort?: string | null;
  mode?: MitzoMode;
  cwd?: string;
  extraTools?: string;
  isolation?: boolean;
  telosTaskId?: string;
  agentName?: string;
}

export interface PendingSession {
  prompt: string;
  context: string;
  telosTaskId?: string;
  agentName?: string;
}

export interface MitzoStoreState {
  // Slices
  sessions: SessionsState;
  messages: MessagesState;
  connection: ConnectionState;
  permissions: PermissionsState;
  tasks: TasksState;
  workload: WorkloadState;
  inbox: InboxState;
  calendar: CalendarState;
  todos: TodosState;
  config: ConfigState;
  tokens: TokensState;
  progress: ProgressState;

  // Error state
  sendError: string | null;
  sendStatus: string | null;
  historyLoading: boolean;
  historyError: string | null;

  // Pending session (for "Start Session" from inbox/todo)
  pendingSession: PendingSession | null;

  // Actions — chat
  dispatchMessages(action: MessagesAction): void;
  switchSession(id: string): Promise<void>;
  newSession(): void;
  sendMessage(text: string, opts?: SendMessageOptions): void;
  interruptMessage(text: string, opts?: SendMessageOptions): void;
  stopGeneration(): void;
  closeSession(): void;
  respondToPermission(
    permId: string,
    decision: 'once' | 'always' | 'deny',
    answers?: import('@mitzo/protocol').QuestionAnswers,
  ): void;
  modeChangeReady: boolean;
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
  setSpawnEnabled(enabled: boolean): Promise<void>;
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
  invalidateAuthentication(): void;
  restoreAuthentication(): void;
  forceReconnect(): void;
  sendSuspend(): void;
}

// ─── Store options ───────────────────────────────────────────────────────────

export interface MitzoStoreOptions {
  transport: TransportAdapter;
  wsConfig: MitzoConnectionConfig;
  /** When provided, the store uses SSE + HTTP POST instead of WebSocket. */
  sseConfig?: SseConnectionConfig;
  /** Start with transports latched off until restoreAuthentication() after an explicit login. */
  initiallyAuthenticated?: boolean;
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

/** Merge an older HTTP snapshot with events received while it was in flight. */
function mergeHistory(
  state: MessagesState,
  history: FinishedMessage[],
  initialCurrent: MessagesState['current'],
): MessagesState {
  const live = new Map(state.messages.map((message) => [message.messageId, message]));
  const updatedCurrent = state.current && state.current !== initialCurrent;
  const merged: FinishedMessage[] = [];
  const seen = new Set<string>();
  for (const message of [...history, ...state.messages]) {
    if (!message || typeof message.messageId !== 'string' || !Array.isArray(message.blocks))
      continue;
    if (
      seen.has(message.messageId) ||
      (updatedCurrent && message.messageId === state.current!.messageId)
    )
      continue;
    seen.add(message.messageId);
    merged.push(live.get(message.messageId) ?? message);
  }
  return messagesReducer(state, { type: 'RESTORE', messages: merged });
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createMitzoStore(options: MitzoStoreOptions): StoreApi<MitzoStoreState> {
  const api = new MitzoApiClient(options.transport.fetch.bind(options.transport));
  const connection: ChatConnection = options.sseConfig
    ? new SseConnection(options.sseConfig)
    : new MitzoConnection(options.wsConfig);

  const parserState: ProtocolParserState = { currentSessionId: undefined };

  let historyRequest = 0;
  let historyAbort: AbortController | undefined;
  let recoveryInFlight = false;
  let awaitingSessionId = false;
  let awaitingModeHydration: string | undefined;
  // The HTTP outbox is intentionally acknowledged in order. A queued prompt
  // can therefore still be client-local when the preceding server execution
  // emits its legacy, unversioned session_end. Keep the running indicator up
  // until the last locally queued prompt has either been accepted or failed.
  const pendingSendIds = new Set<string>();
  // Pending delivery is session-scoped: a queued command from another tab or
  // restored session must never suppress this session's terminal transition.
  const pendingSendSessions = new Map<string, string | null>();
  // Durable queue rejection can overtake the private HTTP receipt on a
  // reconnect. Keep a bounded, session-keyed fence so that late private
  // receipts cannot re-arm a command that the authoritative event settled.
  const MAX_TERMINAL_SEND_TOMBSTONES = 256;
  const terminalSendTombstones = new Map<string, true>();
  const terminalSendKey = (sessionId: string, clientMsgId: string): string =>
    JSON.stringify([sessionId, clientMsgId]);
  const rememberTerminalSend = (sessionId: string, clientMsgId: string): void => {
    const key = terminalSendKey(sessionId, clientMsgId);
    terminalSendTombstones.delete(key);
    terminalSendTombstones.set(key, true);
    if (terminalSendTombstones.size > MAX_TERMINAL_SEND_TOMBSTONES)
      terminalSendTombstones.delete(terminalSendTombstones.keys().next().value!);
  };
  const isTerminalSend = (clientMsgId: string, sessionId: unknown): boolean => {
    const receiptSessionId = typeof sessionId === 'string' ? sessionId : undefined;
    const scopedSessionId = receiptSessionId ?? parserState.currentSessionId;
    return (
      !!scopedSessionId && terminalSendTombstones.has(terminalSendKey(scopedSessionId, clientMsgId))
    );
  };

  const hasPendingSendForSession = (sessionId: string | undefined): boolean => {
    if (!sessionId) return false;
    for (const pendingSessionId of pendingSendSessions.values()) {
      if (pendingSessionId === sessionId) return true;
    }
    return false;
  };

  function fetchAndRestoreMessages(sessionId: string) {
    if (recoveryInFlight) return;
    recoveryInFlight = true;
    const request = historyRequest;
    const initialCurrent = store.getState().messages.current;
    api
      .getSessionMessages(sessionId)
      .then((msgs) => {
        if (request !== historyRequest || store.getState().sessions.active !== sessionId) return;
        if (Array.isArray(msgs)) {
          store.setState((s) => ({
            messages: msgs.length > 0 ? mergeHistory(s.messages, msgs, initialCurrent) : s.messages, // preserve state — empty REST response doesn't mean state is invalid
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

  // syncRunningState removed — running state is server-authoritative via
  // session_state_changed events. Periodic sync covers iOS foreground gaps.

  const store = createStore<MitzoStoreState>((set, get) => ({
    // ── Initial state ────────────────────────────────────────────────────

    sessions: INITIAL_SESSIONS_STATE,
    messages: INITIAL_MESSAGES_STATE,
    connection: INITIAL_CONNECTION_STATE,
    permissions: INITIAL_PERMISSIONS_STATE,
    tasks: INITIAL_TASKS_STATE,
    workload: INITIAL_WORKLOAD_STATE,
    inbox: INITIAL_INBOX_STATE,
    calendar: INITIAL_CALENDAR_STATE,
    todos: INITIAL_TODOS_STATE,
    config: INITIAL_CONFIG_STATE,
    tokens: INITIAL_TOKENS_STATE,
    progress: INITIAL_PROGRESS_STATE,
    sendError: null,
    sendStatus: null,
    historyLoading: false,
    historyError: null,
    modeChangeReady: true,
    pendingSession: null,

    // ── Actions ──────────────────────────────────────────────────────────

    dispatchMessages(action: MessagesAction) {
      set((s) => ({ messages: messagesReducer(s.messages, action) }));
    },

    async switchSession(id: string) {
      const request = ++historyRequest;
      historyAbort?.abort();
      const abort = new AbortController();
      historyAbort = abort;
      awaitingSessionId = false;
      awaitingModeHydration = id;
      set({ modeChangeReady: false, historyLoading: true, historyError: null });
      const oldId = parserState.currentSessionId;
      if (oldId) {
        // clearSession stops seq tracking. No suspend needed — session_suspend
        // is for iOS backgrounding (imminent WS death), not session switching.
        // Sending suspend here would leave the old session in suspended state
        // with no resume path, causing it to buffer events until grace expiry.
        connection.clearSession(oldId);
      }
      parserState.currentSessionId = id;
      connection.clearPendingSends();
      pendingSendIds.clear();
      pendingSendSessions.clear();
      terminalSendTombstones.clear();

      set((s) => ({
        sessions: { ...s.sessions, active: id },
        messages: INITIAL_MESSAGES_STATE,
        sendError: null,
        sendStatus: null,
        permissions: INITIAL_PERMISSIONS_STATE,
        tokens: INITIAL_TOKENS_STATE,
        progress: INITIAL_PROGRESS_STATE,
      }));

      // v2: send switch_session for token hydration + server-side active tracking
      if (!connection.send({ type: 'switch_session', sessionId: id })) {
        awaitingModeHydration = undefined;
        set({ modeChangeReady: true, sendError: 'Could not switch session. Please retry.' });
      }

      try {
        const msgs = await api.getSessionMessages(id, abort.signal);
        if (request !== historyRequest || get().sessions.active !== id) return;
        if (Array.isArray(msgs) && msgs.length > 0) {
          set((s) => ({
            messages: mergeHistory(s.messages, msgs, null),
          }));
        }
      } catch {
        if (request === historyRequest && get().sessions.active === id)
          set({ historyError: 'Could not load this conversation. Please retry.' });
      } finally {
        if (request === historyRequest) set({ historyLoading: false });
      }
    },

    newSession() {
      ++historyRequest;
      historyAbort?.abort();
      historyAbort = undefined;
      set({ historyLoading: false, historyError: null });
      awaitingSessionId = false;
      awaitingModeHydration = undefined;
      set({ modeChangeReady: true });
      for (const sid of connection.getTrackedSessions()) {
        connection.clearSession(sid);
      }
      parserState.currentSessionId = undefined;
      connection.clearPendingSends();
      pendingSendIds.clear();
      pendingSendSessions.clear();
      terminalSendTombstones.clear();
      connection.send({ type: 'switch_session', sessionId: null });
      set({
        sessions: { ...get().sessions, active: null },
        messages: INITIAL_MESSAGES_STATE,
        sendError: null,
        sendStatus: null,
        permissions: INITIAL_PERMISSIONS_STATE,
        progress: INITIAL_PROGRESS_STATE,
      });
    },

    closeSession() {
      const sessionId = parserState.currentSessionId;
      if (!sessionId) return;
      connection.send({ type: 'session_close', sessionId });
    },

    sendMessage(text: string, opts?: SendMessageOptions) {
      const clientMsgId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
        if (opts?.reasoningEffort !== undefined) msg.reasoningEffort = opts.reasoningEffort;
        if (opts?.accountId) msg.accountId = opts.accountId;
        if (mode && !parserState.currentSessionId) msg.mode = mode;
        if (opts?.contextBlocks?.length) msg.contextBlocks = opts.contextBlocks;
        if (opts?.images?.length) {
          msg.images = opts.images.map((img) => ({ data: img.data, mediaType: img.mediaType }));
        }
        if (opts?.cwd) msg.cwd = opts.cwd;
        if (opts?.extraTools) msg.extraTools = opts.extraTools;
        if (opts?.isolation !== undefined) msg.isolation = opts.isolation;
        if (opts?.telosTaskId !== undefined) msg.telosTaskId = opts.telosTaskId;
        if (opts?.agentName !== undefined) msg.agentName = opts.agentName;
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
        sendStatus: null,
      }));

      const msg = buildPayload();

      if (!parserState.currentSessionId) {
        awaitingSessionId = true;
        set({ modeChangeReady: false });
      }
      const sent = connection.send(msg);
      if (!sent) {
        awaitingSessionId = false;
        set({ modeChangeReady: true });
      }
      if (!sent) set({ sendError: 'Message could not be queued. Please retry.' });
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
      const model = opts?.model ?? get().config.modelId;
      if (model) msg.model = model;
      if (opts?.accountId) msg.accountId = opts.accountId;
      if (opts?.reasoningEffort !== undefined) msg.reasoningEffort = opts.reasoningEffort;
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

    respondToPermission(
      permId: string,
      decision: 'once' | 'always' | 'deny',
      answers?: import('@mitzo/protocol').QuestionAnswers,
    ) {
      connection.send({
        type: 'permission_response',
        ...(parserState.currentSessionId ? { sessionId: parserState.currentSessionId } : {}),
        permId,
        decision,
        ...(answers ? { answers } : {}),
      });
      // Only permission_resolved/timeout from the server dismisses the card.
    },

    setMode(mode: MitzoMode) {
      if (!get().modeChangeReady) return;
      if (parserState.currentSessionId) {
        connection.send({
          type: 'set_mode',
          sessionId: parserState.currentSessionId,
          mode,
        });
        return;
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
        if (!meta || get().sessions.active !== sessionId) return;
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
                spawnEnabled: status.spawnEnabled ?? false,
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

    async setSpawnEnabled(enabled: boolean) {
      // Optimistic update so the toggle reflects immediately
      set((s) => ({
        tasks: {
          ...s.tasks,
          loopStatus: { ...s.tasks.loopStatus, spawnEnabled: enabled },
        },
      }));
      await api.setSpawnEnabled(enabled);
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

    invalidateAuthentication() {
      connection.invalidateAuthentication();
    },

    restoreAuthentication() {
      connection.restoreAuthentication();
    },

    forceReconnect() {
      connection.checkAndReconnect(true);
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
    if (msg.type === '_auth_lost') {
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('mitzo:auth-lost'));
      return;
    }
    if (msg.type === 'queued_send_failed') {
      const clientMsgId =
        typeof msg.clientMsgId === 'string' ? (msg.clientMsgId as string) : undefined;
      const sessionId = typeof msg.sessionId === 'string' ? (msg.sessionId as string) : undefined;
      const pendingSessionId = clientMsgId ? pendingSendSessions.get(clientMsgId) : undefined;
      // This durable event is correlated to both the client command and its
      // session. Never let a foreign replay clear a local pending command.
      if (
        !clientMsgId ||
        !sessionId ||
        !pendingSendIds.has(clientMsgId) ||
        (pendingSessionId !== undefined &&
          pendingSessionId !== null &&
          pendingSessionId !== sessionId)
      )
        return;
      pendingSendIds.delete(clientMsgId);
      pendingSendSessions.delete(clientMsgId);
      rememberTerminalSend(sessionId, clientMsgId);
      store.setState({
        sendError:
          typeof msg.error === 'string'
            ? msg.error
            : 'Queued message could not be started. Please retry.',
        sendStatus: hasPendingSendForSession(sessionId) ? store.getState().sendStatus : null,
      });
      return;
    }
    if (
      msg.type === '_send_pending' ||
      msg.type === '_send_queued' ||
      msg.type === '_send_failed' ||
      msg.type === '_send_uncertain' ||
      msg.type === '_send_accepted'
    ) {
      const clientMsgId =
        typeof msg.clientMsgId === 'string' ? (msg.clientMsgId as string) : undefined;
      // Private receipts are delivery hints, not durable state. A matching
      // queued_send_failed already settled this command, so ignore any late
      // pending/queued/accepted/failed/uncertain receipt for that session.
      if (clientMsgId && isTerminalSend(clientMsgId, msg.sessionId)) return;
      if (clientMsgId) {
        // `_send_pending` is emitted synchronously on outbox enqueue, before
        // either the HTTP receipt or the durable user-message echo. A later
        // `_send_queued` must not re-add an ID whose echo already arrived.
        if (msg.type === '_send_pending') {
          pendingSendIds.add(clientMsgId);
          if (typeof msg.sessionId === 'string')
            pendingSendSessions.set(clientMsgId, msg.sessionId as string);
          else if (!pendingSendSessions.has(clientMsgId))
            pendingSendSessions.set(clientMsgId, null);
        } else if (msg.type === '_send_queued') {
          if (pendingSendIds.has(clientMsgId) && typeof msg.sessionId === 'string')
            pendingSendSessions.set(clientMsgId, msg.sessionId as string);
        } else {
          pendingSendIds.delete(clientMsgId);
          pendingSendSessions.delete(clientMsgId);
        }
      }
      const visible = store
        .getState()
        .messages.messages.some((m) => m.messageId === msg.clientMsgId);
      if (visible) {
        const queuedStatus = 'Queued behind the current response…';
        // An HTTP receipt can race the durable user-message echo. Once that
        // echo consumed this pending ID, a late queued receipt must not revive
        // a status which has no subsequent accepted receipt to clear it.
        const shouldShowQueuedStatus =
          msg.type === '_send_queued' && !!clientMsgId && pendingSendIds.has(clientMsgId);
        if (
          awaitingSessionId &&
          (msg.type === '_send_failed' || (msg.type === '_send_accepted' && msg.sessionId === null))
        ) {
          awaitingSessionId = false;
          store.setState({ modeChangeReady: true });
        }
        store.setState({
          sendError:
            msg.type === '_send_failed' || msg.type === '_send_uncertain'
              ? String(msg.error)
              : null,
          sendStatus:
            msg.type === '_send_pending'
              ? msg.retrying
                ? 'Reconnecting — your message will retry automatically.'
                : 'Sending…'
              : msg.type === '_send_queued'
                ? shouldShowQueuedStatus
                  ? queuedStatus
                  : store.getState().sendStatus
                : null,
        });
        if (
          msg.type === '_send_accepted' &&
          typeof msg.sessionId === 'string' &&
          !parserState.currentSessionId
        )
          callbacks.onSessionAssigned(msg.sessionId as string);
      }
      return;
    }
    // Foreground recovery: when the page becomes visible again (iOS may have
    // evicted it from memory, losing in-memory state), re-fetch messages from
    // the REST API if we have an active session but no messages in the store.
    if (msg.type === '_foreground') {
      const { sessions } = store.getState();
      if (sessions.active) {
        fetchAndRestoreMessages(sessions.active);
        // syncRunningState removed — state events handle this
      }
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

    // A pending FIFO receipt becomes active only when the server durably
    // echoes its user message. This keeps the local running guard intact
    // without retaining a second HTTP request or provider enqueue.
    if (msg.type === 'user_message' && typeof msg.messageId === 'string') {
      const pendingSessionId = pendingSendSessions.get(msg.messageId);
      const eventSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined;
      const matchesPendingSession =
        pendingSessionId === undefined ||
        pendingSessionId === null ||
        pendingSessionId === eventSessionId;
      const consumedPending = matchesPendingSession && pendingSendIds.delete(msg.messageId);
      if (consumedPending) pendingSendSessions.delete(msg.messageId);
      // The final durable echo owns the only remaining local send. Clear any
      // delivery label (including `Sending…`) now; otherwise a late queued
      // receipt could leave it stuck. Keep the label for another local send.
      if (consumedPending && !hasPendingSendForSession(eventSessionId))
        store.setState({ sendStatus: null });
    }

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

    if (msg.type === 'error' && msg.sessionId === awaitingModeHydration)
      awaitingModeHydration = undefined;
    if (msg.type === 'session_end' && hasPendingSendForSession(eventSessionId)) return;
    if (
      !awaitingModeHydration &&
      (msg.type === 'session_id' ||
        msg.type === 'error' ||
        msg.type === 'session_end' ||
        msg.type === 'native_command_result')
    ) {
      awaitingSessionId = false;
      store.setState({ modeChangeReady: true });
    }
    const result = parseServerMessage(msg as WsMsg, parserState, callbacks, 'v2');

    if (result.modeUpdate) {
      awaitingModeHydration = undefined;
      store.setState((s) => ({
        config: { ...s.config, mode: result.modeUpdate! },
        modeChangeReady: !awaitingSessionId,
      }));
    }

    for (const action of result.messagesActions) {
      if (
        action.type === 'SESSION_STATE_CHANGED' &&
        action.state === 'idle' &&
        hasPendingSendForSession(eventSessionId)
      )
        continue;
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

    if (result.workloadUpdate) {
      switch (result.workloadUpdate.type) {
        case 'workload_item_created':
        case 'workload_item_updated': {
          const item = result.workloadUpdate.item;
          store.setState((s) => ({
            workload: { ...s.workload, items: updateWorkloadItem(s.workload.items, item) },
          }));
          break;
        }
        case 'workload_batch_updated': {
          const items = result.workloadUpdate.items;
          store.setState((s) => ({
            workload: { ...s.workload, items: batchUpdateWorkloadItems(s.workload.items, items) },
          }));
          break;
        }
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
  if (options.initiallyAuthenticated === false) connection.blockAuthentication();
  connection.connect();

  return store;
}
