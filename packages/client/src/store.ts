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
  const pendingOptimisticMessageIds = new Set<string>();
  let boundedRestore:
    | {
        sessionId: string;
        throughSeq: number;
        confirmedMessageIds: Set<string>;
        liveActions: MessagesAction[];
      }
    | undefined;
  let awaitingSessionId = false;
  let awaitingModeHydration: string | undefined;

  function fetchAndRestoreMessages(
    sessionId: string,
    throughSeq?: number,
    replace = false,
    onApplied?: () => void,
  ) {
    if (recoveryInFlight && throughSeq === undefined) return;
    recoveryInFlight = true;
    const request = ++historyRequest;
    const currentBoundedRestore =
      throughSeq !== undefined
        ? {
            sessionId,
            throughSeq,
            confirmedMessageIds: new Set<string>(),
            liveActions: [] as MessagesAction[],
          }
        : undefined;
    boundedRestore = currentBoundedRestore;
    if (throughSeq !== undefined) {
      historyAbort?.abort();
      historyAbort = undefined;
      store.setState({ historyLoading: true, historyError: null });
    }
    const initialCurrent = store.getState().messages.current;
    const initialMessages = new Map(
      store.getState().messages.messages.map((m) => [m.messageId, m]),
    );
    const transcript =
      throughSeq === undefined
        ? api.getSessionMessages(sessionId).then((messages) => ({ messages, current: null }))
        : api.getReconnectTranscript(sessionId, throughSeq);
    transcript
      .then(({ messages: msgs, current }) => {
        if (request !== historyRequest || store.getState().sessions.active !== sessionId) return;
        if (Array.isArray(msgs)) {
          store.setState((s) => {
            const restored = replace
              ? {
                  ...s.messages,
                  messages: (() => {
                    const live = s.messages.messages.filter(
                      (m) =>
                        initialMessages.get(m.messageId) !== m ||
                        pendingOptimisticMessageIds.has(m.messageId) ||
                        currentBoundedRestore?.confirmedMessageIds.has(m.messageId),
                    );
                    const liveById = new Map(live.map((m) => [m.messageId, m]));
                    const savedIds = new Set(msgs.map((m) => m.messageId));
                    return [
                      ...msgs
                        .filter(
                          (m) =>
                            s.messages.current === initialCurrent ||
                            m.messageId !== s.messages.current?.messageId,
                        )
                        .map((m) => liveById.get(m.messageId) ?? m),
                      ...live.filter((m) => !savedIds.has(m.messageId)),
                    ];
                  })(),
                  current: s.messages.current !== initialCurrent ? s.messages.current : null,
                }
              : msgs.length > 0
                ? mergeHistory(s.messages, msgs, initialCurrent)
                : s.messages;
            const liveActions = currentBoundedRestore?.liveActions ?? [];
            if (
              throughSeq === undefined ||
              (s.messages.current !== initialCurrent && liveActions.length === 0)
            )
              return { messages: restored };
            // Rebuild live completed turns from the captured suffix so their
            // order and blocks are applied once after the durable prefix.
            const replayedIds = new Set(
              liveActions.flatMap((action) =>
                'messageId' in action && typeof action.messageId === 'string'
                  ? [action.messageId]
                  : [],
              ),
            );
            const withoutStaleCurrent = {
              ...restored,
              messages: restored.messages.filter(
                (message) =>
                  message.messageId !== current?.messageId && !replayedIds.has(message.messageId),
              ),
              current: null,
            };
            const withSnapshot = current
              ? messagesReducer(withoutStaleCurrent, {
                  type: 'MESSAGE_SNAPSHOT',
                  messageId: current.messageId,
                  blocks: current.blocks,
                })
              : withoutStaleCurrent;
            return { messages: liveActions.reduce(messagesReducer, withSnapshot) };
          });
          onApplied?.();
        }
      })
      .catch((err) => {
        if (typeof console !== 'undefined') {
          console.warn('[mitzo] message recovery fetch failed', err);
        }
        if (replace && request === historyRequest)
          store.setState({ historyError: 'Could not restore this conversation. Please retry.' });
      })
      .finally(() => {
        if (boundedRestore === currentBoundedRestore) boundedRestore = undefined;
        if (request === historyRequest) {
          recoveryInFlight = false;
          if (throughSeq !== undefined) store.setState({ historyLoading: false });
        }
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
      recoveryInFlight = false;
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
      pendingOptimisticMessageIds.clear();

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
      recoveryInFlight = false;
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
      pendingOptimisticMessageIds.clear();
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
      pendingOptimisticMessageIds.add(clientMsgId);

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
        pendingOptimisticMessageIds.delete(clientMsgId);
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

      pendingOptimisticMessageIds.add(clientMsgId);
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

    onReconnectSnapshot(sessionId: string, cursor: number, cursorValid: boolean) {
      if (parserState.currentSessionId === sessionId) {
        fetchAndRestoreMessages(sessionId, cursor, !cursorValid, () =>
          connection.acknowledgeReconnectSnapshot(sessionId, cursor),
        );
      }
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
    if (
      msg.type === '_send_pending' ||
      msg.type === '_send_failed' ||
      msg.type === '_send_uncertain' ||
      msg.type === '_send_accepted'
    ) {
      if (msg.type === '_send_failed' && typeof msg.clientMsgId === 'string')
        pendingOptimisticMessageIds.delete(msg.clientMsgId);
      const visible = store
        .getState()
        .messages.messages.some((m) => m.messageId === msg.clientMsgId);
      if (visible) {
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

    // Session-scoped event filtering for multiplexed v2 connections:
    // - No sessionId on the event → global (task_state, inbox_updated, etc.) → always accept
    // - sessionId matches currentSessionId → accept
    // - No active session AND event is session_id/session_end → accept (new session assignment)
    // - Otherwise → drop (foreign session event)
    if (eventSessionId) {
      if (parserState.currentSessionId) {
        if (eventSessionId !== parserState.currentSessionId) {
          if (
            msg.type === 'session_reconnect_snapshot' &&
            typeof msg.cursor === 'number' &&
            Number.isSafeInteger(msg.cursor) &&
            msg.cursor >= 0
          )
            connection.acknowledgeReconnectSnapshot(eventSessionId, msg.cursor);
          return;
        }
      } else {
        // Allow session_id (new session assignment) and permission_request
        // (can arrive before session_id on the first turn) through when no
        // active session. Drop everything else (session_end, etc.) to prevent
        // foreign session bleed.
        const isFirstTurnEvent = msg.type === 'session_id' || msg.type === 'permission_request';
        if (!isFirstTurnEvent) {
          if (
            msg.type === 'session_reconnect_snapshot' &&
            typeof msg.cursor === 'number' &&
            Number.isSafeInteger(msg.cursor) &&
            msg.cursor >= 0
          )
            connection.acknowledgeReconnectSnapshot(eventSessionId, msg.cursor);
          return;
        }
      }
    }

    if (msg.type === 'error' && msg.sessionId === awaitingModeHydration)
      awaitingModeHydration = undefined;
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
      if (action.type === 'USER_MESSAGE_RECEIVED')
        pendingOptimisticMessageIds.delete(action.messageId);
      const isPostCursorAction =
        boundedRestore &&
        eventSessionId === boundedRestore.sessionId &&
        typeof msg.seq === 'number' &&
        Number.isSafeInteger(msg.seq) &&
        msg.seq > boundedRestore.throughSeq;
      if (isPostCursorAction) {
        boundedRestore!.liveActions.push(action);
        if (action.type === 'USER_MESSAGE_RECEIVED')
          boundedRestore!.confirmedMessageIds.add(action.messageId);
      }
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
