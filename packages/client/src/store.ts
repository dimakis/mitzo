import {
  parseLocalCommandDelivery,
  localCommandSessionId,
  OrdinaryCommandDeliverySchema,
  ComposerDraftReceiptSchema,
  type ComposerDraftReceipt,
  type OrdinaryCommandPhase,
  type OrdinaryCommandDelivery,
  type LocalCommandRequest,
} from './local-command-delivery.js';
/**
 * MitzoStore factory — zustand vanilla store wiring all slices.
 *
 * Framework-agnostic: creates a vanilla zustand store, not a React hook.
 * React wrappers live in hooks/ and are a separate tree-shakeable import.
 */

import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';
import type { FinishedMessage, MitzoMode, ImageAttachment, SourceSnapshot } from '@mitzo/protocol';
import {
  splitContextPrompt,
  type OrdinaryRuntimeContinuationCommand,
  type OrdinaryRuntimeFirstCommand,
  type OrdinaryWorkspaceFirstCommand,
} from '@mitzo/protocol';

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
import { SendOutbox, hasReviewedSource } from './send-outbox.js';
import type { SseConnectionConfig } from './sse-connection.js';
import type { ChatConnection } from './chat-connection.js';
import { messageIdentity } from './message-identity.js';

// ─── Store state ─────────────────────────────────────────────────────────────

export interface SendMessageOptions {
  /** Exact local edited revision; retained by the outbox and never sent to the server. */
  composerDraft?: ComposerDraftReceipt;
  /** Local ownership metadata; never sent as provider input. */
  launchDraftId?: string;
  agentProfile?: import('@mitzo/protocol').AgentProfileSelection;
  /** Local assignment observer; never included in the wire payload. */
  onSessionAssigned?: (sessionId: string) => void;
  /** Local delivery observer; never included in the wire payload. */
  onDelivery?: (status: 'accepted' | 'failed' | 'uncertain') => void;
  accountId?: string;
  contextBlocks?: string[];
  sourceSnapshots?: SourceSnapshot[];
  images?: ImageAttachment[];
  model?: string;
  reasoningEffort?: string | null;
  mode?: MitzoMode;
  cwd?: string;
  repositoryWorkspaceId?: string;
  extraTools?: string;
  isolation?: boolean;
  telosTaskId?: string;
  agentName?: string;
}

export interface PendingSession {
  /** Saved composer that owns this launch; never global chat context. */
  draftId?: string;
  prompt: string;
  context: string;
  /** Configured reference block names. */
  contextBlocks?: string[];
  /** Exact reviewed source data, independently delivered to provider prompt assembly. */
  sourceSnapshots?: SourceSnapshot[];
  accountSelection?: { accountId: string; model: string; reasoningEffort?: string | null };
  briefing?: { date: string; revision: string };
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
  pendingSessionSending: boolean;
  chatDraftRevision: number;
  /** Active-session queue metadata invalidation; contains no message content. */
  queueRevision: number;

  // Current server-issued transport identity; never persisted across reconnect.
  getTransportConnectionId(): string | null;

  /** Dedicated first-command delivery intent; never a runtime readiness receipt. */
  localFirstCommandTransportAvailable: boolean;
  localCommand: {
    request?: LocalCommandRequest;
    ordinaryPhase?: OrdinaryCommandPhase;
    preparedSessionId?: string;
    state: string;
    sessionId?: string;
    originDraftId?: string;
    composerDraft?: ComposerDraftReceipt;
  } | null;
  sendLocalFirstCommand(
    request: OrdinaryRuntimeFirstCommand | OrdinaryRuntimeContinuationCommand,
    observers?: Pick<SendMessageOptions, 'onDelivery' | 'onSessionAssigned' | 'composerDraft'> & {
      draftId?: string;
    },
  ): boolean;
  sendPreparedRepositoryCommand(
    request: OrdinaryRuntimeFirstCommand,
    sessionId: string,
    observers?: Pick<SendMessageOptions, 'onDelivery' | 'onSessionAssigned' | 'composerDraft'> & {
      draftId?: string;
    },
  ): boolean;
  sendOrdinaryWorkspaceCommand(
    request: OrdinaryWorkspaceFirstCommand,
    phase: OrdinaryCommandPhase,
    observers?: Pick<SendMessageOptions, 'onDelivery' | 'onSessionAssigned' | 'composerDraft'> & {
      draftId?: string;
    },
  ): boolean;
  recoverLocalCommand(): boolean;
  selectLocalCommandDraft(draftId: string): void;
  selectLocalCommandSession(sessionId: string): void;
  // Actions — chat
  dispatchMessages(action: MessagesAction): void;
  getConnectionId(): string | null;
  switchSession(id: string): Promise<void>;
  newSession(): void;
  sendMessage(text: string, opts?: SendMessageOptions): void;
  interruptMessage(text: string, opts?: SendMessageOptions): void;
  stopGeneration(): void;
  closeSession(): void;
  expirePermission(permId: string): void;
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
  startLoop(goalId: string, specMode?: boolean, sessionId?: string): Promise<void>;
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
  sendPendingSession(opts?: SendMessageOptions): boolean;

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
  /** Durable HTTP admission of initial reviewed briefing commands while WS receives events. */
  reviewedSendConfig?: { url: string; storage: Pick<Storage, 'getItem' | 'setItem'> };
  localFirstCommandConfig?: { url: string; storage: Pick<Storage, 'getItem' | 'setItem'> };
  /** Start with transports latched off until restoreAuthentication() after an explicit login. */
  initiallyAuthenticated?: boolean;
  launchDrafts?: {
    pending(draftId: string): boolean;
    matches?(draftId: string, command: Record<string, unknown>): boolean;
    prepare(draftId: string, command: Record<string, unknown>): boolean;
    assign(clientMsgId: string, sessionId: string): void | { context: string };
    settle(clientMsgId: string, status: 'accepted' | 'failed' | 'uncertain'): string | undefined;
    finalize?(clientMsgId: string): void;
  };
  /** Global durable command handoff, recreated at bootstrap and independent of UI observers. */
  sendHandoff?: {
    prepare(command: Record<string, unknown>): boolean;
    assign(clientMsgId: string, sessionId: string, hint?: Record<string, unknown>): void;
    reject(clientMsgId: string): void;
    finalize?(clientMsgId: string): void;
  };
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
function mergeLiveWithDurable(
  live: FinishedMessage | undefined,
  durable: FinishedMessage,
): FinishedMessage {
  if (!live) return durable;
  const liveContent = { ...live };
  delete liveContent.symposiumProvenance;
  const durableText =
    durable.role === 'user' && durable.blocks.find((block) => block.blockType === 'text');
  const durableContext = durableText && splitContextPrompt(durableText.content);
  return {
    ...liveContent,
    ...(durable.startedSeq !== undefined ? { startedSeq: durable.startedSeq } : {}),
    ...(durable.symposiumProvenance ? { symposiumProvenance: durable.symposiumProvenance } : {}),
    images: live.images ?? durable.images,
    contextBlocks: live.contextBlocks ?? durable.contextBlocks,
    contextInjections:
      live.contextInjections ??
      durable.contextInjections ??
      (durableContext ? durableContext.injections : undefined),
    sourceSnapshots: live.sourceSnapshots ?? durable.sourceSnapshots,
  };
}

function mergeHistory(
  state: MessagesState,
  history: FinishedMessage[],
  initialCurrent: MessagesState['current'],
): MessagesState {
  const live = new Map(
    state.messages.map((message) => [
      messageIdentity(message.messageId, message.symposiumProvenance),
      message,
    ]),
  );
  const updatedCurrent = state.current && state.current !== initialCurrent;
  const merged: FinishedMessage[] = [];
  const seen = new Set<string>();
  for (const message of [...history, ...state.messages]) {
    if (!message || typeof message.messageId !== 'string' || !Array.isArray(message.blocks))
      continue;
    if (
      seen.has(messageIdentity(message.messageId, message.symposiumProvenance)) ||
      (updatedCurrent &&
        messageIdentity(message.messageId, message.symposiumProvenance) ===
          messageIdentity(state.current!.messageId, state.current!.symposiumProvenance))
    )
      continue;
    const key = messageIdentity(message.messageId, message.symposiumProvenance);
    seen.add(key);
    merged.push(mergeLiveWithDurable(live.get(key), message));
  }
  return messagesReducer(state, { type: 'RESTORE', messages: merged });
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createMitzoStore(options: MitzoStoreOptions): StoreApi<MitzoStoreState> {
  const api = new MitzoApiClient(options.transport.fetch.bind(options.transport));
  // Lifetimes belong to selected views and unresolved commands, independently
  // of received sequence cursors. Retirement invalidates every restore callback.
  let sessionInterestGeneration = 0;
  const sessionInterests = new Map<string, { subscriptionId: string }>();
  const sessionInterest = {
    has: (id: string) => sessionInterests.has(id),
    sessions: () => [...sessionInterests.keys()],
    generation: (id: string) => sessionInterests.get(id)?.subscriptionId,
    accepts: (event: Record<string, unknown>) => {
      const id = event.sessionId;
      if (
        typeof id === 'string' &&
        event.type === 'session_reconnect_snapshot' &&
        typeof event.subscriptionId === 'string' &&
        event.subscriptionId !== sessionInterests.get(id)?.subscriptionId
      )
        return false;
      if (typeof id !== 'string' || sessionInterests.has(id)) return true;
      if (event.type === 'session_id') return true;
      if (event.type === 'permission_request' && !parserState.currentSessionId) return true;
      const command = event.type === 'user_message' ? event.messageId : event.clientMsgId;
      if (typeof command !== 'string' || !deliveryObservers.has(command)) return false;
      const origin = deliveryOrigins.get(command);
      return (
        !origin?.sessionId ||
        origin.sessionId === id ||
        (event.type === '_send_accepted' &&
          origin.control === 'send' &&
          event.originalSessionId === origin.sessionId)
      );
    },
  };
  const connection: ChatConnection = options.sseConfig
    ? new SseConnection({ ...options.sseConfig, sessionInterest })
    : new MitzoConnection({ ...options.wsConfig, sessionInterest });

  function retainSessionInterest(id: string) {
    if (!sessionInterests.has(id))
      sessionInterests.set(id, { subscriptionId: String(++sessionInterestGeneration) });
    connection.trackSeq(id, connection.getLastSeq(id));
  }
  function cancelBackgroundRead(id: string) {
    backgroundSnapshotReads.get(id)?.controller.abort();
    backgroundSnapshotReads.delete(id);
  }
  function retireSessionInterest(id: string) {
    sessionInterests.delete(id);
    cancelBackgroundRead(id);
    connection.clearSession(id);
  }

  // An explicit clear is a display decision too; never infer freshness from null.
  let contextDisplayWritten = false;
  let localCommandScope: { draftId: string } | { sessionId: string } | null | undefined;
  let visibleLocalCommandId: string | undefined;
  let reviewedAuthenticated = options.initiallyAuthenticated !== false;
  let reviewedSendScope = Date.now();
  let taskReadSequence = 0;
  const reviewedOutbox = options.reviewedSendConfig
    ? new SendOutbox({
        url: options.reviewedSendConfig.url,
        storage: options.reviewedSendConfig.storage,
        fetch: options.transport.fetch.bind(options.transport),
        durableLaunches: true,
        notify(event) {
          wsListener(event);
          if (
            event.type === '_send_accepted' &&
            typeof event.sessionId === 'string' &&
            store.getState().sessions.active === event.sessionId
          ) {
            const sessionId = event.sessionId;
            connection.send({ type: 'switch_session', sessionId });
            fetchAndRestoreMessages(sessionId, undefined, false, () =>
              connection.send({
                type: 'switch_session',
                sessionId,
                historyCursor: connection.getLastSeq(sessionId),
              }),
            );
          }
        },
      })
    : null;
  const localOutbox =
    options.sseConfig && options.localFirstCommandConfig
      ? new SendOutbox({
          ...options.localFirstCommandConfig,
          localFirstCommand: true,
          fetch: async (url, init) => {
            if (!reviewedAuthenticated || !connection.getConnectionId())
              throw Error('Live SSE required');
            return options.transport.fetch(url, init);
          },
          headers: () => ({ 'X-Connection-ID': connection.getConnectionId() ?? '' }),
          notify(event) {
            if (event.type === '_local_command_retired') {
              if (typeof event.clientMsgId === 'string') {
                options.sendHandoff?.finalize?.(event.clientMsgId);
                options.launchDrafts?.finalize?.(event.clientMsgId);
              }
              return;
            }
            if (event.type !== '_local_command_state') return;
            if (event.state === 'idle') {
              visibleLocalCommandId = undefined;
              store.setState({ localCommand: null, sendStatus: null });
              return;
            }
            let request: LocalCommandRequest | undefined;
            let ordinaryDelivery: OrdinaryCommandDelivery | undefined;
            let composerDraft: ComposerDraftReceipt | undefined;
            try {
              ordinaryDelivery =
                event.ordinaryDelivery === undefined
                  ? undefined
                  : OrdinaryCommandDeliverySchema.parse(event.ordinaryDelivery);
              request = parseLocalCommandDelivery(event.request, ordinaryDelivery);
              composerDraft =
                event.composerDraft === undefined
                  ? undefined
                  : ComposerDraftReceiptSchema.parse(event.composerDraft);
            } catch {
              /* Invalid retained intent is visible and blocks replacement. */
            }
            const state = String(event.state);
            const sessionId = typeof event.sessionId === 'string' ? event.sessionId : undefined;
            // Restored outbox intent has no in-memory composer observer, but
            // still owns its original scope until deliberate receipt recovery.
            if (request && !deliveryOrigins.has(request.clientMsgId))
              deliveryOrigins.set(request.clientMsgId, {
                control: 'send',
                delivery: 'local',
                historyRequest,
                launchGeneration,
                running: store.getState().messages.running,
              });
            const locationLabel = request?.runOn === 'openshell' ? 'OpenShell' : 'Local';
            const visible =
              localCommandScope == null
                ? visibleLocalCommandId === undefined ||
                  visibleLocalCommandId === request?.clientMsgId
                : 'draftId' in localCommandScope
                  ? localCommandScope.draftId === event.originDraftId
                  : localCommandScope.sessionId ===
                    localCommandSessionId(
                      request,
                      ordinaryDelivery?.version === 1 ? ordinaryDelivery.sessionId : sessionId,
                    );
            if (visible) {
              visibleLocalCommandId = request?.clientMsgId;
              store.setState({
                localCommand: {
                  request,
                  ...(composerDraft ? { composerDraft } : {}),
                  ...(ordinaryDelivery ? { ordinaryPhase: ordinaryDelivery.phase } : {}),
                  ...(ordinaryDelivery?.version === 1
                    ? { preparedSessionId: ordinaryDelivery.sessionId }
                    : {}),
                  state,
                  sessionId,
                  ...(typeof event.originDraftId === 'string'
                    ? { originDraftId: event.originDraftId }
                    : {}),
                },
                sendStatus:
                  state === 'consumed'
                    ? `${locationLabel} command dispatched.`
                    : state === 'pending'
                      ? `Sending ${locationLabel} command…`
                      : `${locationLabel} command retained. Review before retrying.`,
              });
            }
            if (!request) return;
            // Only a validated202 acknowledges this submitted request; a retained409
            // session is an observation and must not consume its launch identity.
            if (
              sessionId &&
              event.acknowledged === true &&
              state === 'consumed' &&
              ordinaryDelivery?.phase === 'first' &&
              (ordinaryDelivery.version === 1
                ? sessionId === ordinaryDelivery.sessionId
                : 'sessionId' in request && sessionId === request.sessionId)
            ) {
              const source = request.payload.sourceSnapshots?.find(
                (source) => source.kind === 'agent-library',
              );
              // This conversation already exists. Finalize only its durable source
              // handoff; launch drafts and foreground navigation keep their owners.
              if (source)
                options.sendHandoff?.assign(request.clientMsgId, sessionId, {
                  kind: 'agent-library',
                  revision: source.revision,
                });
            }
            if (
              sessionId &&
              event.acknowledged === true &&
              (state === 'consumed' ||
                !request.payload.sourceSnapshots?.some((source) => source.kind === 'briefing')) &&
              !('sessionId' in request) &&
              ordinaryDelivery?.version !== 1
            ) {
              const source = request.payload.sourceSnapshots?.find(
                (source) => source.kind === 'agent-library' || source.kind === 'briefing',
              );
              const preassignmentSession = store.getState().sessions.active;
              const assignment = source
                ? assignCommand(
                    request.clientMsgId,
                    sessionId,
                    source.kind === 'briefing'
                      ? { kind: 'briefing-owned', draftId: event.originDraftId, command: request }
                      : { kind: 'agent-library', revision: source.revision },
                  )
                : undefined;
              const foreground = bindLaunchAssignment(
                request.clientMsgId,
                sessionId,
                true,
                'local',
              );
              if (foreground) {
                if (
                  source?.kind === 'briefing' &&
                  assignment &&
                  !contextDisplayWritten &&
                  preassignmentSession === null &&
                  store.getState().sessions.active === null &&
                  store.getState().pendingSession?.draftId === event.originDraftId
                ) {
                  store
                    .getState()
                    .dispatchMessages({ type: 'SET_SESSION_CONTEXT', context: assignment.context });
                }
                parserState.currentSessionId = sessionId;
                store.setState((s) => ({
                  sessions: { ...s.sessions, active: sessionId },
                  modeChangeReady: false,
                }));
                connection.send({ type: 'switch_session', sessionId });
                store.getState().fetchSessionMeta(sessionId);
                // Startup may finish before its HTTP receipt. Deferred SSE is
                // never draft authority; restore only this acknowledged session.
                fetchAndRestoreMessages(sessionId, undefined, false, () =>
                  connection.send({
                    type: 'switch_session',
                    sessionId,
                    historyCursor: connection.getLastSeq(sessionId),
                  }),
                );
              }
            }
            if (state === 'consumed' && event.acknowledged === true)
              settleDelivery(request.clientMsgId, 'accepted', 'local');
            else if (state === 'uncertain' || state === 'reserved' || state === 'retained')
              settleDelivery(request.clientMsgId, 'uncertain', 'local');
          },
        })
      : null;
  function pauseReviewedDelivery() {
    if (!reviewedAuthenticated) return;
    reviewedAuthenticated = false;
    reviewedOutbox?.rejectAll('Authentication expired. Sign in again to retry.');
    localOutbox?.rejectAll('Authentication changed. Review the retained Local command.');
  }
  const parserState: ProtocolParserState = { currentSessionId: undefined };
  // Transport acceptance does not confirm a permission decision. A later
  // authoritative pending snapshot must let the operator retry, never resend.
  const unconfirmedPermissionResponses = new Map<string, string | undefined>();
  function normalizePermissionAction(action: MessagesAction): MessagesAction {
    if (action.type === 'PERMISSION_REJECTED' || action.type === 'PERMISSION_TIMEOUT') {
      unconfirmedPermissionResponses.delete(action.permId);
    }
    if (action.type !== 'PERMISSION_SNAPSHOT') return action;
    const current = store.getState().messages;
    const previous = [current.permission, ...(current.permissionQueue ?? [])];
    return {
      ...action,
      permissions: action.permissions
        .filter((permission) => permission && typeof permission.permId === 'string')
        .map((permission) => {
          const expectedSession = unconfirmedPermissionResponses.get(permission.permId);
          if (
            unconfirmedPermissionResponses.has(permission.permId) &&
            (!expectedSession || !permission.sessionId || permission.sessionId === expectedSession)
          ) {
            unconfirmedPermissionResponses.delete(permission.permId);
            return {
              ...permission,
              responseError: 'This decision was not confirmed. Review the request and try again.',
            };
          }
          const error = previous.find((item) => item?.permId === permission.permId)?.responseError;
          return error && permission.responseError === undefined
            ? { ...permission, responseError: error }
            : permission;
        }),
    };
  }

  let historyRequest = 0;
  let historyAbort: AbortController | undefined;
  let recoveryInFlight = false;
  const backgroundSnapshotReads = new Map<string, { controller: AbortController }>();
  const pendingOptimisticMessageIds = new Set<string>();
  // Completion belongs to a command, not a session that can accept later sends.
  // Keep observations across HTTP uncertainty, retries and view navigation.
  const preparationObservations = new Map<string, { sessionId?: string; ended: boolean }>();
  function observePreparation(id: string, sessionId?: string) {
    let observation = preparationObservations.get(id);
    if (!observation) {
      observation = { sessionId, ended: false };
      preparationObservations.set(id, observation);
      if (preparationObservations.size > 256)
        preparationObservations.delete(preparationObservations.keys().next().value!);
    } else if (!observation.sessionId && sessionId) observation.sessionId = sessionId;
    return observation;
  }
  const deliveryObservers = new Map<string, NonNullable<SendMessageOptions['onDelivery']>>();
  const assignmentObservers = new Map<
    string,
    NonNullable<SendMessageOptions['onSessionAssigned']>
  >();
  let launchGeneration = 0;
  // Navigation releases the visible composer, not an outstanding send's identity.
  const launchSends = new Map<string, PendingSession>();
  const deliverySessions = new Map<string, string>();
  // Keep recent command origins after receipts settle so duplicate errors stay scoped.
  const deliveryOrigins = new Map<
    string,
    {
      historyRequest: number;
      launchGeneration: number;
      sessionId?: string;
      control: 'send' | 'interrupt';
      delivery: 'ordinary' | 'local';
      /** Early SSE observation only; never used to assign or accept a command. */
      observedSessionId?: string;
      running: boolean;
    }
  >();

  function observeDelivery(
    clientMsgId: string,
    opts: SendMessageOptions,
    control: 'send' | 'interrupt',
    delivery: 'ordinary' | 'local' = 'ordinary',
  ) {
    deliveryObservers.set(clientMsgId, opts.onDelivery ?? (() => {}));
    if (opts.onSessionAssigned) assignmentObservers.set(clientMsgId, opts.onSessionAssigned);
    deliveryOrigins.set(clientMsgId, {
      control,
      delivery,
      historyRequest,
      launchGeneration,
      sessionId: parserState.currentSessionId,
      running: store.getState().messages.running,
    });
    for (const id of deliveryOrigins.keys()) {
      if (deliveryOrigins.size <= 256) break;
      if (!deliveryObservers.has(id)) {
        deliveryOrigins.delete(id);
        assignmentObservers.delete(id);
      }
    }

    if (parserState.currentSessionId)
      deliverySessions.set(clientMsgId, parserState.currentSessionId);
    else unassignedDeliveries.set(clientMsgId, { historyRequest, launchGeneration });
  }

  const unassignedDeliveries = new Map<
    string,
    { historyRequest: number; launchGeneration: number }
  >();
  const hasPendingDelivery = (sessionId: string) =>
    [...deliverySessions.values()].includes(sessionId) ||
    [...deliveryOrigins].some(
      ([id, origin]) => deliveryObservers.has(id) && origin.observedSessionId === sessionId,
    );
  function isLocalDelivery(id: string): boolean {
    return (
      deliveryOrigins.get(id)?.delivery === 'local' ||
      store.getState().localCommand?.request?.clientMsgId === id
    );
  }
  function settleDelivery(
    id: string,
    status: 'accepted' | 'failed' | 'uncertain',
    source: 'ordinary' | 'local' = 'ordinary',
  ) {
    if (isLocalDelivery(id) && source !== 'local') return;
    if (source === 'local' && status === 'accepted') pendingOptimisticMessageIds.delete(id);
    const draftId = options.launchDrafts?.settle(id, status);
    if (draftId && store.getState().pendingSession?.draftId === draftId) {
      if (status === 'accepted')
        store.setState({ pendingSession: null, pendingSessionSending: false });
      else if (status === 'failed') store.setState({ pendingSessionSending: false });
    }
    const observer = deliveryObservers.get(id);
    const origin = deliveryOrigins.get(id);
    const sessionId = deliverySessions.get(id) ?? origin?.observedSessionId;
    if (source === 'local' && status === 'uncertain' && !origin?.sessionId)
      store.setState((s) => ({
        messages: {
          ...s.messages,
          // No acknowledged conversation owns this draft's optimistic spinner.
          // Retain its message and frozen recovery request; a selected session,
          // real stream or newer draft keeps its independently owned busy state.
          ...(origin?.control === 'send' &&
          !origin.running &&
          s.sessions.active === null &&
          origin.historyRequest === historyRequest &&
          origin.launchGeneration === launchGeneration &&
          !s.messages.current &&
          Object.keys(s.messages.currentByMessage).length === 0 &&
          s.messages.messages.filter((m) => m.role === 'user').at(-1)?.messageId === id
            ? { running: false }
            : {}),
        },
      }));
    if (observer && status === 'failed') {
      pendingOptimisticMessageIds.delete(id);
      store.setState((s) => ({
        messages: {
          ...s.messages,
          messages: s.messages.messages.filter((m) => m.messageId !== id),
          // Undo only this send's optimistic busy state. A real stream, newer
          // input, running origin or another conversation retains its owner.
          ...(origin?.control === 'send' &&
          !origin.running &&
          (origin.sessionId ?? null) === s.sessions.active &&
          origin.historyRequest === historyRequest &&
          !s.messages.current &&
          Object.keys(s.messages.currentByMessage).length === 0 &&
          s.messages.messages.filter((m) => m.role === 'user').at(-1)?.messageId === id
            ? { running: false }
            : {}),
        },
      }));
    }

    if (status !== 'uncertain') {
      if (status === 'failed') {
        // Definitive rejection releases only this command's durable launch receipt.
        // Network/auth ambiguity stays pending until an authoritative receipt arrives.
        options.sendHandoff?.reject(id);
        unassignedDeliveries.delete(id);
        assignmentObservers.delete(id);
      }
      deliveryObservers.delete(id);
      deliverySessions.delete(id);
    }
    observer?.(status);
    if (sessionId && status !== 'uncertain')
      queueMicrotask(() => {
        if (store.getState().sessions.active !== sessionId && !hasPendingDelivery(sessionId))
          retireSessionInterest(sessionId);
      });
  }
  function matchesDeliverySession(id: string, sessionId: string | undefined): boolean {
    const origin = deliveryOrigins.get(id);
    // Observed commands require their bound session, even after navigation.
    // Assignment or an exact correlated initial echo can bind an unassigned launch.
    return !origin || (typeof origin.sessionId === 'string' && origin.sessionId === sessionId);
  }
  function confirmPersistedDelivery(sessionId: string, messages: FinishedMessage[]) {
    for (const message of messages)
      if (message.role === 'user' && isLocalDelivery(message.messageId))
        void localOutbox?.reconcileLocalCommand(message.messageId);
      else if (message.role === 'user' && matchesDeliverySession(message.messageId, sessionId))
        settleDelivery(message.messageId, 'accepted');
  }

  let boundedRestore:
    | {
        sessionId: string;
        throughSeq: number;
        confirmedMessageIds: Set<string>;
        liveActions: Array<{ seq: number; action: MessagesAction }>;
      }
    | undefined;
  let openingHistory:
    | {
        sessionId: string;
        request: number;
        actions: Array<{ seq: number; action: MessagesAction }>;
      }
    | undefined;
  let awaitingSessionId = false;
  let awaitingModeHydration: string | undefined;

  function fetchAndRestoreMessages(
    sessionId: string,
    throughSeq?: number,
    replace = false,
    onApplied?: () => void,
    loadedTranscript?: ReturnType<MitzoApiClient['getReconnectTranscript']>,
  ) {
    if (recoveryInFlight && throughSeq === undefined) return;
    recoveryInFlight = true;
    const request = ++historyRequest;
    const currentBoundedRestore = {
      sessionId,
      throughSeq: throughSeq ?? 0,
      confirmedMessageIds: new Set<string>(),
      liveActions: [] as Array<{ seq: number; action: MessagesAction }>,
    };
    boundedRestore = currentBoundedRestore;
    if (throughSeq !== undefined) {
      historyAbort?.abort();
      historyAbort = undefined;
      store.setState({ historyLoading: true, historyError: null });
    }
    const initialCurrent = store.getState().messages.current;
    const initialMessages = new Map(
      store
        .getState()
        .messages.messages.map((m) => [messageIdentity(m.messageId, m.symposiumProvenance), m]),
    );
    const transcript =
      loadedTranscript ??
      (throughSeq === undefined
        ? api.getSessionTranscript(sessionId)
        : api.getReconnectTranscript(sessionId, throughSeq));
    transcript
      .then(({ messages: msgs, current, currents = [], cursor }) => {
        if (Array.isArray(msgs)) confirmPersistedDelivery(sessionId, msgs);
        if (request !== historyRequest || store.getState().sessions.active !== sessionId) return;
        if (Array.isArray(msgs)) {
          const appliedCursor = cursor ?? throughSeq;
          store.setState((s) => {
            const restored = replace
              ? {
                  ...s.messages,
                  messages: (() => {
                    const live = s.messages.messages.filter(
                      (m) =>
                        (initialMessages.get(
                          messageIdentity(m.messageId, m.symposiumProvenance),
                        ) !== m &&
                          (throughSeq === undefined ||
                            m.startedSeq === undefined ||
                            m.startedSeq > throughSeq)) ||
                        pendingOptimisticMessageIds.has(m.messageId) ||
                        currentBoundedRestore?.confirmedMessageIds.has(m.messageId),
                    );
                    const liveById = new Map(
                      live.map((m) => [messageIdentity(m.messageId, m.symposiumProvenance), m]),
                    );
                    const savedIds = new Set(
                      msgs.map((m) => messageIdentity(m.messageId, m.symposiumProvenance)),
                    );
                    return [
                      ...msgs
                        .filter(
                          (m) =>
                            s.messages.current === initialCurrent ||
                            !s.messages.current ||
                            messageIdentity(m.messageId, m.symposiumProvenance) !==
                              messageIdentity(
                                s.messages.current.messageId,
                                s.messages.current.symposiumProvenance,
                              ),
                        )
                        .map((m) =>
                          mergeLiveWithDurable(
                            liveById.get(messageIdentity(m.messageId, m.symposiumProvenance)),
                            m,
                          ),
                        ),
                      ...live.filter(
                        (m) => !savedIds.has(messageIdentity(m.messageId, m.symposiumProvenance)),
                      ),
                    ];
                  })(),
                  current: s.messages.current !== initialCurrent ? s.messages.current : null,
                }
              : msgs.length > 0
                ? mergeHistory(s.messages, msgs, initialCurrent)
                : s.messages;
            const liveActions = currentBoundedRestore.liveActions
              .filter((item) => appliedCursor === undefined || item.seq > appliedCursor)
              .map((item) => item.action);
            if (appliedCursor === undefined) return { messages: restored };
            const preserveLiveCurrent =
              s.messages.current !== initialCurrent && liveActions.length === 0;
            // Rebuild live completed turns from the captured suffix so their
            // order and blocks are applied once after the durable prefix.
            const replayedIds = new Set(
              liveActions.flatMap((action) => {
                if ('messageId' in action && typeof action.messageId === 'string')
                  return [messageIdentity(action.messageId, action.symposiumProvenance)];
                if (
                  (action.type === 'ERROR' || action.type === 'CONTROL_REJECTED') &&
                  action.retainedFailureSeq !== undefined
                )
                  return [messageIdentity(`runtime-error-${action.retainedFailureSeq}`)];
                return [];
              }),
            );
            const withoutStaleCurrent = {
              ...restored,
              messages: restored.messages.filter(
                (message) =>
                  messageIdentity(message.messageId, message.symposiumProvenance) !==
                    (current ? messageIdentity(current.messageId) : undefined) &&
                  !currents.some(
                    (seat) =>
                      messageIdentity(seat.messageId, seat.symposiumProvenance) ===
                      messageIdentity(message.messageId, message.symposiumProvenance),
                  ) &&
                  !replayedIds.has(messageIdentity(message.messageId, message.symposiumProvenance)),
              ),
              current: preserveLiveCurrent ? s.messages.current : null,
              currentByMessage: {},
              resyncRequired: false,
            };
            const withSnapshot =
              current && !preserveLiveCurrent
                ? messagesReducer(withoutStaleCurrent, {
                    type: 'MESSAGE_SNAPSHOT',
                    messageId: current.messageId,
                    startedSeq: current.startedSeq,
                    blocks: current.blocks,
                  })
                : withoutStaleCurrent;
            const withSeatSnapshots = currents.reduce(
              (state, seat) =>
                messagesReducer(state, {
                  type: 'MESSAGE_SNAPSHOT',
                  messageId: seat.messageId,
                  startedSeq: seat.startedSeq,
                  blocks: seat.blocks,
                  symposiumProvenance: seat.symposiumProvenance,
                }),
              withSnapshot,
            );
            const replayed = liveActions.reduce(messagesReducer, withSeatSnapshots);
            if (replayed.resyncRequired) throw new Error('Unsafe reconnect seat transcript');
            return { messages: replayed };
          });
          if (appliedCursor !== undefined)
            connection.commitTranscriptCursor(sessionId, appliedCursor);
          onApplied?.();
        }
      })
      .catch((err) => {
        if (typeof console !== 'undefined') {
          console.warn('[mitzo] message recovery fetch failed', err);
        }
        if (
          (replace || throughSeq !== undefined || onApplied) &&
          request === historyRequest &&
          store.getState().sessions.active === sessionId
        ) {
          store.setState({ historyError: 'Could not restore this conversation. Please retry.' });
          // A receipt may select the chat after its background snapshot ACK was
          // sent. Recover an authoritative prefix if that receipt's history fails.
          if (onApplied && throughSeq === undefined) connection.checkAndReconnect(true);
        }
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

  function sendOwnedLocalCommand(
    request: unknown,
    opts: Pick<SendMessageOptions, 'onDelivery' | 'onSessionAssigned' | 'composerDraft'> & {
      draftId?: string;
    } = {},
    ordinaryDelivery?: OrdinaryCommandDelivery,
  ): boolean {
    const reject = (message: string): false => {
      store.setState({ sendError: message });
      return false;
    };
    let frozen: LocalCommandRequest;
    try {
      frozen = parseLocalCommandDelivery(request, ordinaryDelivery);
    } catch {
      return reject('The message could not be prepared. Review its settings. Your draft was kept.');
    }
    if (!localOutbox) return reject('Message delivery is unavailable. Your draft was kept.');
    if (!reviewedAuthenticated) return reject('Sign in again before sending. Your draft was kept.');
    if (!connection.getConnectionId())
      return reject(
        'The execution connection is unavailable. Reconnect before sending. Your draft was kept.',
      );
    if (
      ordinaryDelivery?.version === 1
        ? parserState.currentSessionId !== ordinaryDelivery.sessionId
        : 'sessionId' in frozen
          ? parserState.currentSessionId !== frozen.sessionId
          : !!parserState.currentSessionId
    )
      return reject(
        'The conversation changed before sending. Reopen this chat. Your draft was kept.',
      );
    const briefingLaunch =
      !('sessionId' in frozen) &&
      !ordinaryDelivery &&
      frozen.payload.sourceSnapshots?.some((source) => source.kind === 'briefing');
    if (
      briefingLaunch &&
      (!opts.draftId || options.launchDrafts?.prepare(opts.draftId, frozen) !== true)
    )
      return reject('The briefing delivery identity could not be saved. Your draft was kept.');
    const handoff = frozen.payload.sourceSnapshots?.length
      ? options.sendHandoff?.prepare(frozen)
      : undefined;
    if ((briefingLaunch && handoff !== true) || handoff === false) {
      if (briefingLaunch) options.launchDrafts?.settle(frozen.clientMsgId, 'failed');
      return reject('The reviewed message context could not be saved. Your draft was kept.');
    }
    const sessionId = localCommandSessionId(
      frozen,
      ordinaryDelivery?.version === 1 ? ordinaryDelivery.sessionId : undefined,
    );
    localCommandScope = opts.draftId
      ? { draftId: opts.draftId }
      : sessionId
        ? { sessionId }
        : undefined;
    visibleLocalCommandId = frozen.clientMsgId;
    observeDelivery(frozen.clientMsgId, opts, 'send', 'local');
    const sent = localOutbox.enqueue(
      frozen,
      Date.now(),
      opts.draftId,
      ordinaryDelivery,
      opts.composerDraft,
    );
    if (!sent) {
      settleDelivery(frozen.clientMsgId, 'failed', 'local');
      const messages = {
        storage: 'Device storage could not retain the outgoing message. Your draft was kept.',
        blocked:
          'Saved message recovery is unavailable. Keep your draft and pending messages for recovery.',
        inactive: 'Message delivery is paused. Sign in again before sending. Your draft was kept.',
        pending:
          'This chat already has a pending message. Review its delivery before sending again.',
        invalid: 'The message could not be prepared. Review its settings. Your draft was kept.',
        full: 'The outgoing message queue is full. Review pending messages before sending again.',
      };
      return reject(messages[localOutbox.getEnqueueFailure() ?? 'invalid']);
    }
    pendingOptimisticMessageIds.add(frozen.clientMsgId);
    store.setState((s) => ({
      sendError: null,
      modeChangeReady: false,
      messages: messagesReducer(s.messages, {
        type: 'USER_SEND',
        text: frozen.payload.text,
        clientMsgId: frozen.clientMsgId,
        images: frozen.payload.images?.map(
          (image) => `data:${image.mediaType};base64,${image.data}`,
        ),
        sourceSnapshots: frozen.payload.sourceSnapshots,
      }),
    }));
    return true;
  }

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
    pendingSessionSending: false,
    chatDraftRevision: 0,
    queueRevision: 0,

    // ── Actions ──────────────────────────────────────────────────────────

    getTransportConnectionId: () => connection.getConnectionId(),

    dispatchMessages(action: MessagesAction) {
      if (action.type === 'SET_SESSION_CONTEXT') contextDisplayWritten = true;
      set((s) => ({ messages: messagesReducer(s.messages, normalizePermissionAction(action)) }));
    },

    getConnectionId() {
      return connection.getConnectionId();
    },

    async switchSession(id: string) {
      ++launchGeneration;
      set({ pendingSession: null, pendingSessionSending: false });
      if (id !== parserState.currentSessionId) unconfirmedPermissionResponses.clear();
      const request = ++historyRequest;
      openingHistory = { sessionId: id, request, actions: [] };
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
        if (!hasPendingDelivery(oldId)) retireSessionInterest(oldId);
      }
      parserState.currentSessionId = id;
      // Even a session whose history is loaded through REST needs an explicit
      // reconnect baseline. Otherwise a predecessor gap can force a reconnect
      // with no tracked sessions and never request its durable snapshot.
      retainSessionInterest(id);
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
        const {
          messages: msgs,
          current,
          currents = [],
          cursor,
        } = await api.getSessionTranscript(id, abort.signal);
        if (request !== historyRequest || get().sessions.active !== id) return;
        if (cursor === undefined) {
          if (msgs.length > 0) set((s) => ({ messages: mergeHistory(s.messages, msgs, null) }));
        } else {
          const liveActions = (openingHistory?.request === request ? openingHistory.actions : [])
            .filter((item) => item.seq > cursor)
            .map((item) => item.action);
          const replayedIds = new Set(
            liveActions.flatMap((action) =>
              'messageId' in action && typeof action.messageId === 'string'
                ? [messageIdentity(action.messageId, action.symposiumProvenance)]
                : [],
            ),
          );
          const optimistic = get().messages.messages.filter(
            (message) =>
              pendingOptimisticMessageIds.has(message.messageId) &&
              !msgs.some(
                (saved) =>
                  messageIdentity(saved.messageId, saved.symposiumProvenance) ===
                  messageIdentity(message.messageId, message.symposiumProvenance),
              ) &&
              !replayedIds.has(messageIdentity(message.messageId, message.symposiumProvenance)),
          );
          let restored = messagesReducer(
            { ...INITIAL_MESSAGES_STATE, running: get().messages.running },
            {
              type: 'RESTORE',
              messages: [...msgs, ...optimistic],
            },
          );
          if (current)
            restored = messagesReducer(restored, {
              type: 'MESSAGE_SNAPSHOT',
              messageId: current.messageId,
              startedSeq: current.startedSeq,
              blocks: current.blocks,
            });
          for (const seat of currents)
            restored = messagesReducer(restored, {
              type: 'MESSAGE_SNAPSHOT',
              messageId: seat.messageId,
              startedSeq: seat.startedSeq,
              blocks: seat.blocks,
              symposiumProvenance: seat.symposiumProvenance,
            });
          restored = liveActions.reduce(messagesReducer, restored);
          if (restored.resyncRequired) throw new Error('Unsafe session-open transcript');
          set((s) => ({ messages: { ...restored, running: s.messages.running } }));
          connection.commitTranscriptCursor(id, cursor);
          // REST and switch are independent requests. Rebase server retries
          // on the transcript we installed, including any events stored
          // between that REST boundary and the first switch/watch.
          connection.send({ type: 'switch_session', sessionId: id, historyCursor: cursor });
        }
      } catch {
        if (request === historyRequest && get().sessions.active === id)
          set({ historyError: 'Could not load this conversation. Please retry.' });
      } finally {
        if (openingHistory?.request === request) openingHistory = undefined;
        if (request === historyRequest) set({ historyLoading: false });
      }
    },

    newSession() {
      localCommandScope = null;
      visibleLocalCommandId = undefined;
      ++launchGeneration;
      set({ pendingSession: null, pendingSessionSending: false });
      unconfirmedPermissionResponses.clear();
      ++historyRequest;
      recoveryInFlight = false;
      historyAbort?.abort();
      historyAbort = undefined;
      set({ historyLoading: false, historyError: null });
      awaitingSessionId = false;
      awaitingModeHydration = undefined;
      set({ modeChangeReady: true });
      for (const sid of connection.getTrackedSessions()) {
        if (!hasPendingDelivery(sid)) retireSessionInterest(sid);
      }
      parserState.currentSessionId = undefined;
      connection.clearPendingSends();
      pendingOptimisticMessageIds.clear();
      connection.send({ type: 'switch_session', sessionId: null });
      set({
        sessions: { ...get().sessions, active: null },
        chatDraftRevision: get().chatDraftRevision + 1,
        messages: INITIAL_MESSAGES_STATE,
        tokens: INITIAL_TOKENS_STATE,
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

    localCommand: null,
    localFirstCommandTransportAvailable: !!localOutbox,
    sendLocalFirstCommand(request, opts = {}) {
      return sendOwnedLocalCommand(request, opts);
    },
    sendPreparedRepositoryCommand(request, sessionId, opts = {}) {
      return sendOwnedLocalCommand(request, opts, { version: 1, phase: 'first', sessionId });
    },
    sendOrdinaryWorkspaceCommand(request, phase, opts = {}) {
      return sendOwnedLocalCommand(request, opts, { version: 2, phase });
    },
    selectLocalCommandDraft(draftId) {
      localCommandScope = { draftId };
      visibleLocalCommandId = undefined;
      localOutbox?.selectLocalDraft(draftId);
      const command = get().localCommand;
      const request = command?.request;
      const origin = request ? deliveryOrigins.get(request.clientMsgId) : undefined;
      if (
        request &&
        !('sessionId' in request) &&
        command?.originDraftId === draftId &&
        request.payload.sourceSnapshots?.[0]?.kind === 'briefing' &&
        get().sessions.active === null &&
        get().pendingSession?.draftId === draftId &&
        !assignmentObservers.has(request.clientMsgId) &&
        !deliveryObservers.has(request.clientMsgId) &&
        !unassignedDeliveries.has(request.clientMsgId) &&
        origin &&
        options.launchDrafts?.matches?.(draftId, request) === true
      ) {
        // Explicit restoration adopts only its original proven draft's UI scope.
        // Native dispatch and receipt/source assignment keep their existing gates.
        origin.historyRequest = historyRequest;
        origin.launchGeneration = launchGeneration;
      }
    },
    selectLocalCommandSession(sessionId) {
      localCommandScope = { sessionId };
      visibleLocalCommandId = undefined;
      localOutbox?.selectLocalSession(sessionId);
    },
    recoverLocalCommand() {
      return (
        !!reviewedAuthenticated &&
        !!connection.getConnectionId() &&
        !!localOutbox?.retryLocalCommand(get().localCommand?.request?.clientMsgId)
      );
    },
    sendMessage(text: string, opts?: SendMessageOptions) {
      const clientMsgId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      pendingOptimisticMessageIds.add(clientMsgId);
      observePreparation(clientMsgId, parserState.currentSessionId);
      observeDelivery(clientMsgId, opts ?? {}, 'send');

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
        if (opts?.sourceSnapshots?.length) msg.sourceSnapshots = opts.sourceSnapshots;
        if (opts?.images?.length) {
          msg.images = opts.images.map((img) => ({ data: img.data, mediaType: img.mediaType }));
        }
        if (opts?.cwd) msg.cwd = opts.cwd;
        if (opts?.repositoryWorkspaceId && !parserState.currentSessionId)
          msg.repositoryWorkspaceId = opts.repositoryWorkspaceId;
        if (opts?.extraTools) msg.extraTools = opts.extraTools;
        if (opts?.isolation !== undefined) msg.isolation = opts.isolation;
        if (opts?.telosTaskId !== undefined) msg.telosTaskId = opts.telosTaskId;
        if (opts?.agentName !== undefined) msg.agentName = opts.agentName;
        if (opts?.agentProfile && !parserState.currentSessionId)
          msg.agentProfile = opts.agentProfile;
        return msg;
      };

      const msg = buildPayload();
      if (
        opts?.launchDraftId &&
        options.launchDrafts &&
        !options.launchDrafts.prepare(opts.launchDraftId, msg)
      ) {
        pendingOptimisticMessageIds.delete(clientMsgId);
        set({ sendError: 'The launch delivery identity could not be saved. Your draft was kept.' });
        settleDelivery(clientMsgId, 'failed');
        return;
      }
      if (options.sendHandoff && !options.sendHandoff.prepare(msg)) {
        pendingOptimisticMessageIds.delete(clientMsgId);
        set({
          sendError:
            'The reviewed conversation identity could not be retained. Retry before sending.',
        });
        settleDelivery(clientMsgId, 'failed');
        return;
      }

      set((s) => ({
        messages: messagesReducer(s.messages, {
          type: 'USER_SEND',
          text,
          clientMsgId,
          images: opts?.images?.map((img) => img.preview),
          contextBlocks: opts?.contextBlocks,
          sourceSnapshots: opts?.sourceSnapshots,
        }),
        sendError: null,
        sendStatus: null,
      }));

      if (!parserState.currentSessionId) {
        awaitingSessionId = true;
        set({ modeChangeReady: false });
      }
      const reviewed =
        !!reviewedOutbox &&
        msg.sessionId === null &&
        (!!opts?.launchDraftId || hasReviewedSource(msg));
      const sent = reviewed
        ? reviewedAuthenticated && reviewedOutbox!.enqueue(msg, reviewedSendScope++)
        : connection.send(msg);
      if (!sent) {
        pendingOptimisticMessageIds.delete(clientMsgId);
        awaitingSessionId = false;
        set({ modeChangeReady: true });
      }
      if (!sent) {
        set((s) => ({
          sendError: reviewed
            ? 'The reviewed message could not be retained for recovery. Retry before sending.'
            : 'Message could not be queued. Please retry.',
          messages: !parserState.currentSessionId
            ? messagesReducer(s.messages, { type: 'SESSION_STATE_CHANGED', state: 'idle' })
            : s.messages,
        }));
        settleDelivery(clientMsgId, 'failed');
      }
    },

    interruptMessage(text: string, opts?: SendMessageOptions) {
      if (!parserState.currentSessionId || !get().messages.running) {
        opts?.onDelivery?.('failed');
        return;
      }

      const clientMsgId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const msg: Record<string, unknown> = {
        type: 'interrupt',
        sessionId: parserState.currentSessionId,
        prompt: text,
        clientMsgId,
      };
      observeDelivery(clientMsgId, opts ?? {}, 'interrupt');
      pendingOptimisticMessageIds.add(clientMsgId);
      set((s) => ({
        messages: messagesReducer(s.messages, {
          type: 'USER_SEND',
          text,
          clientMsgId,
          images: opts?.images?.map((img) => img.preview),
          contextBlocks: opts?.contextBlocks,
          sourceSnapshots: opts?.sourceSnapshots,
        }),
      }));
      const model = opts?.model ?? get().config.modelId;
      if (model) msg.model = model;
      if (opts?.accountId) msg.accountId = opts.accountId;
      if (opts?.reasoningEffort !== undefined) msg.reasoningEffort = opts.reasoningEffort;
      if (opts?.images?.length) {
        msg.images = opts.images.map((img) => ({ data: img.data, mediaType: img.mediaType }));
      }
      if (opts?.contextBlocks?.length) msg.contextBlocks = opts.contextBlocks;
      if (opts?.sourceSnapshots?.length) msg.sourceSnapshots = opts.sourceSnapshots;

      const reviewed = !!reviewedOutbox && msg.sessionId === null && hasReviewedSource(msg);
      const sent = reviewed
        ? reviewedAuthenticated && reviewedOutbox!.enqueue(msg, reviewedSendScope++)
        : connection.send(msg);
      if (!sent) {
        set({ sendError: 'Not connected. Interrupt was not delivered.' });
        settleDelivery(clientMsgId, 'failed');
        return;
      }
    },

    stopGeneration() {
      if (!parserState.currentSessionId) return;
      const sent = connection.send({
        type: 'stop',
        sessionId: parserState.currentSessionId,
      });
      if (!sent) set({ sendError: 'Not connected. Stop was not delivered. Please retry.' });
    },

    expirePermission(permId: string) {
      set((s) => ({
        messages: messagesReducer(s.messages, { type: 'PERMISSION_TIMEOUT', permId }),
      }));
    },

    respondToPermission(
      permId: string,
      decision: 'once' | 'always' | 'deny',
      answers?: import('@mitzo/protocol').QuestionAnswers,
    ) {
      get().dispatchMessages({ type: 'PERMISSION_RESPONDING', permId });
      unconfirmedPermissionResponses.set(permId, parserState.currentSessionId);
      let sent = false;
      try {
        sent = connection.send({
          type: 'permission_response',
          ...(parserState.currentSessionId ? { sessionId: parserState.currentSessionId } : {}),
          permId,
          decision,
          ...(answers ? { answers } : {}),
        });
      } catch {
        // A synchronous transport failure is also unconfirmed, not a decision.
      }
      if (!sent)
        get().dispatchMessages({
          type: 'PERMISSION_REJECTED',
          permId,
          error: 'Could not send this decision. Reconnect and try again.',
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
              sessionTotal: s.tokens.sessionTotalStatus
                ? s.tokens.sessionTotal
                : (meta.totalTokens ?? s.tokens.sessionTotal),
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
      const readSequence = ++taskReadSequence;
      try {
        const tasks = await api.getTasks();
        if (readSequence !== taskReadSequence) return;
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

    async startLoop(goalId: string, specMode?: boolean, sessionId?: string) {
      await api.startLoop(goalId, specMode, sessionId);
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
      // Replacing a launch owns a new draft and retires any earlier assignment.
      // A bound conversation remains selected until the draft route commits.
      if (get().pendingSession && !get().sessions.active) get().newSession();
      ++launchGeneration;
      const sending = ps.draftId ? launchSends.get(ps.draftId) : undefined;
      set({
        pendingSession: sending ?? ps,
        pendingSessionSending:
          !!sending || !!(ps.draftId && options.launchDrafts?.pending(ps.draftId)),
      });
    },

    clearPendingSession() {
      const ownsUnassignedDraft =
        !get().sessions.active &&
        [...unassignedDeliveries.values()].some(
          (origin) =>
            origin.historyRequest === historyRequest &&
            origin.launchGeneration === launchGeneration,
        );
      ++launchGeneration;
      if (ownsUnassignedDraft) get().newSession();
      set({ pendingSession: null, pendingSessionSending: false });
    },

    sendPendingSession(opts) {
      const pending = get().pendingSession;
      if (
        !pending ||
        get().pendingSessionSending ||
        (pending.draftId && options.launchDrafts?.pending(pending.draftId))
      )
        return false;
      // A carried preview must be reviewed in its own draft before account confirmation.
      if (get().sessions.active) {
        get().newSession();
        set({ pendingSession: pending });
        return false;
      }
      const account =
        pending.briefing ||
        pending.sourceSnapshots?.some((source) => source.kind === 'briefing') ||
        !opts?.accountId
          ? pending.accountSelection
          : { accountId: opts.accountId, model: opts.model, reasoningEffort: opts.reasoningEffort };
      const selection = {
        ...opts,
        ...account,
        model: account?.model ?? opts?.model ?? get().config.modelId ?? undefined,
        mode: opts?.mode ?? get().config.mode,
        contextBlocks: [...(pending.contextBlocks ?? []), ...(opts?.contextBlocks ?? [])],
        sourceSnapshots: pending.sourceSnapshots ?? opts?.sourceSnapshots,
      };
      // Each attempt has a distinct identity, so stale receipts cannot dismiss a replacement.
      const launch = { ...pending };
      if (launch.draftId) launchSends.set(launch.draftId, launch);
      set({ pendingSession: launch, pendingSessionSending: true });
      get().dispatchMessages({ type: 'SET_SESSION_CONTEXT', context: launch.context });
      let queued = true;
      get().sendMessage(launch.prompt, {
        ...selection,
        launchDraftId: launch.draftId,
        ...(launch.telosTaskId ? { telosTaskId: launch.telosTaskId } : {}),
        ...(launch.agentName ? { agentName: launch.agentName } : {}),
        onDelivery(status) {
          if (
            status !== 'uncertain' &&
            launch.draftId &&
            launchSends.get(launch.draftId) === launch
          )
            launchSends.delete(launch.draftId);
          opts?.onDelivery?.(status);
          if (get().pendingSession !== launch) return;
          if (status === 'accepted') set({ pendingSession: null, pendingSessionSending: false });
          else if (status === 'failed') {
            queued = false;
            set({ pendingSessionSending: false });
          }
          // Uncertain delivery remains locked until its matching receipt arrives.
        },
      });
      return queued;
    },

    invalidateAuthentication() {
      for (const id of backgroundSnapshotReads.keys()) cancelBackgroundRead(id);
      pauseReviewedDelivery();
      connection.invalidateAuthentication();
    },

    restoreAuthentication() {
      reviewedAuthenticated = true;
      reviewedOutbox?.start();
      localOutbox?.start();
      connection.restoreAuthentication();
    },

    forceReconnect() {
      connection.checkAndReconnect(true);
    },

    sendSuspend() {
      connection.sendSuspend();
    },
  }));

  function assignCommand(id: string, sessionId: string, hint?: Record<string, unknown>) {
    options.sendHandoff?.assign(id, sessionId, hint);
    return options.launchDrafts?.assign(id, sessionId);
  }

  function bindLaunchAssignment(
    id: string,
    sessionId: string,
    consume = true,
    source: 'ordinary' | 'local' = 'ordinary',
  ): boolean {
    if (isLocalDelivery(id) && source !== 'local') return false;
    options.launchDrafts?.assign(id, sessionId);
    const origin = unassignedDeliveries.get(id);
    const deliveryOrigin = deliveryOrigins.get(id);
    const previousSession = deliveryOrigin?.sessionId ?? deliveryOrigin?.observedSessionId;
    const foreground = origin
      ? origin.historyRequest === historyRequest && origin.launchGeneration === launchGeneration
      : !!deliveryOrigin &&
        deliveryOrigin.sessionId === parserState.currentSessionId &&
        deliveryOrigin.historyRequest === historyRequest &&
        deliveryOrigin.launchGeneration === launchGeneration;
    // HTTP delivery can precede session_id. Retain the draft identity until that event.
    if (consume) unassignedDeliveries.delete(id);
    if (deliveryObservers.has(id)) deliverySessions.set(id, sessionId);
    const errorOrigin = deliveryOrigins.get(id);
    if (errorOrigin) errorOrigin.sessionId = sessionId;

    retainSessionInterest(sessionId);
    const assigned = assignmentObservers.get(id);
    assignmentObservers.delete(id);
    assigned?.(sessionId);
    if (previousSession && previousSession !== sessionId)
      queueMicrotask(() => {
        if (
          store.getState().sessions.active !== previousSession &&
          !hasPendingDelivery(previousSession)
        )
          retireSessionInterest(previousSession);
      });
    return foreground;
  }

  // ── WS → store wiring ──────────────────────────────────────────────────

  const callbacks: ProtocolCallbacks = {
    onSessionAssigned(sessionId: string) {
      parserState.currentSessionId = sessionId;
      awaitingSessionId = false;
      connection.setRecoverySession?.(sessionId);
      for (const id of pendingOptimisticMessageIds) {
        if (isLocalDelivery(id)) continue;
        observePreparation(id, sessionId);
        if (deliveryObservers.has(id)) deliverySessions.set(id, sessionId);
        const origin = deliveryOrigins.get(id);
        if (origin && !origin.sessionId) origin.sessionId = sessionId;
      }
      retainSessionInterest(sessionId);
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

    onReconnectSnapshot(sessionId: string, cursor: number, cursorValid: boolean, offerId?: string) {
      if (parserState.currentSessionId === sessionId) {
        fetchAndRestoreMessages(sessionId, cursor, !cursorValid, () =>
          connection.acknowledgeReconnectSnapshot(sessionId, cursor, offerId),
        );
      }
    },

    onTokensHydrated(tokens: Record<string, unknown>) {
      store.setState((s) => ({
        tokens: {
          ...s.tokens,
          sessionTotal: s.tokens.sessionTotalStatus
            ? s.tokens.sessionTotal
            : ((tokens.input as number) ?? 0) +
              ((tokens.output as number) ?? 0) +
              ((tokens.cacheRead as number) ?? 0) +
              ((tokens.cacheCreation as number) ?? 0),
        },
      }));
    },
  };

  function wsListener(msg: Record<string, unknown>): boolean {
    if (msg.type === '_close' || msg.type === '_auth_lost')
      for (const id of backgroundSnapshotReads.keys()) cancelBackgroundRead(id);
    let retainedFailureSeq: number | undefined;
    if (msg.type === '_control_error') {
      // HTTP controls are not provider failures. Keep streamed content and
      // running state intact, and expose actionable failures through the banner.
      if ((msg.sessionId ?? null) !== store.getState().sessions.active) return true;
      if (msg.operation === 'switch') {
        awaitingModeHydration = undefined;
        store.setState({ modeChangeReady: true });
      }
      if (msg.operation !== 'suspend') store.setState({ sendError: String(msg.error) });
      return true;
    }
    if (msg.type === '_auth_lost') {
      pauseReviewedDelivery();
      store.setState((s) => ({
        connection: { ...s.connection, status: 'disconnected', clientId: null },
      }));
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('mitzo:auth-lost'));
      return true;
    }
    if (
      msg.type === '_send_pending' ||
      msg.type === '_send_failed' ||
      msg.type === '_send_uncertain' ||
      msg.type === '_send_accepted'
    ) {
      if (typeof msg.clientMsgId === 'string' && isLocalDelivery(msg.clientMsgId)) return true;
      const origin =
        typeof msg.clientMsgId === 'string' ? deliveryOrigins.get(msg.clientMsgId) : undefined;
      if (
        origin &&
        !unassignedDeliveries.has(msg.clientMsgId as string) &&
        (msg.originalSessionId ?? msg.sessionId ?? null) !== (origin.sessionId ?? null) &&
        (msg.sessionId ?? null) !== (origin.sessionId ?? null)
      )
        return true;
      const preparation =
        typeof msg.clientMsgId === 'string'
          ? observePreparation(
              msg.clientMsgId,
              typeof msg.sessionId === 'string' ? msg.sessionId : origin?.sessionId,
            )
          : undefined;
      if (
        msg.type === '_send_accepted' &&
        typeof msg.clientMsgId === 'string' &&
        typeof msg.sessionId === 'string'
      )
        assignCommand(
          msg.clientMsgId,
          msg.sessionId,
          msg.sourceHandoff as Record<string, unknown> | undefined,
        );
      const visible = store
        .getState()
        .messages.messages.some((m) => m.messageId === msg.clientMsgId);
      const currentCommand =
        store
          .getState()
          .messages.messages.filter((message) => message.role === 'user')
          .at(-1)?.messageId === msg.clientMsgId;
      if (
        msg.type === '_send_accepted' &&
        typeof msg.sessionId === 'string' &&
        typeof msg.clientMsgId === 'string' &&
        (unassignedDeliveries.has(msg.clientMsgId) ||
          (origin?.control === 'send' &&
            origin.sessionId !== msg.sessionId &&
            msg.originalSessionId === origin.sessionId))
      ) {
        const foreground = bindLaunchAssignment(msg.clientMsgId, msg.sessionId, false);
        if (foreground) callbacks.onSessionAssigned(msg.sessionId);
      }
      if (typeof msg.clientMsgId === 'string' && msg.type !== '_send_pending') {
        const status =
          msg.type === '_send_accepted'
            ? 'accepted'
            : msg.type === '_send_failed'
              ? 'failed'
              : 'uncertain';
        settleDelivery(msg.clientMsgId, status);
      }
      if (msg.type === '_send_failed' && typeof msg.clientMsgId === 'string')
        pendingOptimisticMessageIds.delete(msg.clientMsgId);
      if (visible) {
        const messages = store.getState().messages;
        const userIndex = messages.messages.findIndex(
          (message) => message.messageId === msg.clientMsgId,
        );
        const user = messages.messages[userIndex];
        const preparationEnded =
          preparation?.ended === true && preparation.sessionId === msg.sessionId;
        const responseStarted =
          messages.messages.slice(userIndex + 1).some((message) => message.role === 'assistant') ||
          (user?.startedSeq !== undefined &&
            messages.current?.startedSeq !== undefined &&
            messages.current.startedSeq > user.startedSeq);
        if (
          awaitingSessionId &&
          (msg.type === '_send_failed' || (msg.type === '_send_accepted' && msg.sessionId === null))
        ) {
          awaitingSessionId = false;
          store.setState({ modeChangeReady: true });
        }
        if (msg.type === '_send_failed' && !parserState.currentSessionId)
          store.setState((s) => ({
            messages: messagesReducer(s.messages, { type: 'SESSION_STATE_CHANGED', state: 'idle' }),
          }));
        store.setState({
          sendError: !currentCommand
            ? store.getState().sendError
            : msg.type === '_send_failed' || msg.type === '_send_uncertain'
              ? String(msg.error)
              : null,
          sendStatus: !currentCommand
            ? store.getState().sendStatus
            : msg.type === '_send_pending'
              ? msg.retrying
                ? 'Reconnecting — your message will retry automatically.'
                : 'Sending…'
              : msg.type === '_send_accepted' &&
                  msg.retained === true &&
                  !responseStarted &&
                  !preparationEnded
                ? 'Preparing response…'
                : null,
        });
        if (
          msg.type === '_send_accepted' &&
          typeof msg.sessionId === 'string' &&
          !parserState.currentSessionId
        )
          callbacks.onSessionAssigned(msg.sessionId as string);
      }
      return true;
    }
    // Foreground recovery: when the page becomes visible again (iOS may have
    // evicted it from memory, losing in-memory state), re-fetch messages from
    // the REST API if we have an active session but no messages in the store.
    if (msg.type === '_foreground') {
      localOutbox?.wake();
      const { sessions, historyLoading } = store.getState();
      // An opening transcript or bounded reconnect already owns history. A
      // second foreground restore would invalidate that request and can leave
      // its loading flag stuck while duplicating the full transcript work.
      if (sessions.active && !historyLoading) {
        fetchAndRestoreMessages(sessions.active);
        // syncRunningState removed — state events handle this
      }
      return true;
    }

    if (msg.type === '_open') localOutbox?.wake();

    if (msg.type === 'session_resumed') {
      if (typeof console !== 'undefined') {
        console.debug('[mitzo] session resumed', {
          sessionId: msg.sessionId,
          replayed: msg.replayed,
        });
      }
      return true;
    }

    const eventSessionId = msg.sessionId as string | undefined;
    if (msg.type === 'session_reconnect_snapshot' && eventSessionId)
      cancelBackgroundRead(eventSessionId);
    if (
      eventSessionId &&
      ['message_start', 'session_end', 'ordinary_provider_dispatch_started'].includes(
        String(msg.type),
      )
    ) {
      for (const [id, origin] of deliveryOrigins)
        if (
          origin.delivery === 'local' &&
          (origin.sessionId ?? origin.observedSessionId) === eventSessionId
        )
          void localOutbox?.reconcileLocalCommand(id);
    }

    // Explicit view selection owns rendering and controls, independently of
    // the originating Local draft's pending HTTP acknowledgement.
    const selectedEventSession =
      typeof eventSessionId === 'string' &&
      eventSessionId === parserState.currentSessionId &&
      eventSessionId === store.getState().sessions.active;
    // SSE can expose a retained session before native startup is admitted.
    // Observe/defer its stream without adopting the session, settling the draft,
    // or refusing transport application (which would force reconnect/replay).
    if (msg.type === 'session_id' || msg.type === 'user_message') {
      const id =
        msg.type === 'user_message'
          ? typeof msg.messageId === 'string'
            ? msg.messageId
            : undefined
          : typeof msg.clientMsgId === 'string'
            ? msg.clientMsgId
            : [...deliveryOrigins.entries()].find(
                ([, origin]) =>
                  origin.delivery === 'local' &&
                  !origin.sessionId &&
                  origin.historyRequest === historyRequest &&
                  origin.launchGeneration === launchGeneration,
              )?.[0];
      if (id && isLocalDelivery(id)) {
        const origin = deliveryOrigins.get(id);
        if (origin && !origin.sessionId && typeof eventSessionId === 'string') {
          const previousObservation = origin.observedSessionId;
          // Exact command correlation supersedes an older uncorrelated
          // observation. Later uncorrelated events cannot displace it.
          if (msg.type === 'user_message' || typeof msg.clientMsgId === 'string')
            origin.observedSessionId = eventSessionId;
          else origin.observedSessionId ??= eventSessionId;
          if (deliveryObservers.has(id) && origin.observedSessionId)
            retainSessionInterest(origin.observedSessionId);
          if (
            previousObservation &&
            previousObservation !== origin.observedSessionId &&
            previousObservation !== parserState.currentSessionId &&
            !hasPendingDelivery(previousObservation)
          )
            retireSessionInterest(previousObservation);
        }
        if (msg.type === 'session_id' || (!origin?.sessionId && !selectedEventSession)) return true;
      }
    }
    const deferredLocalSession =
      typeof eventSessionId === 'string' &&
      !selectedEventSession &&
      [...deliveryOrigins.values()].some(
        (origin) =>
          origin.delivery === 'local' &&
          !origin.sessionId &&
          origin.observedSessionId === eventSessionId,
      );
    // A snapshot is a transport fence, even before the command receipt may
    // select this chat. Restore its bounded prefix below without adopting the
    // draft, so its unacknowledged offer cannot hold output until timeout.
    if (deferredLocalSession && msg.type !== 'session_reconnect_snapshot') return true;
    // A control refusal for another view is handled, not a replay failure.
    if (msg.type === 'session_control_rejected') {
      if (
        typeof msg.error !== 'string' ||
        !['stop', 'send', 'interrupt', 'close'].includes(String(msg.control))
      )
        return true;
      if (typeof msg.clientMsgId === 'string') {
        const origin = deliveryOrigins.get(msg.clientMsgId);
        if (isLocalDelivery(msg.clientMsgId)) return true;
        // A receipt releases only the exact submitted command, even after navigation.
        if (origin) {
          if (origin.sessionId !== eventSessionId || origin.control !== msg.control) return true;
          settleDelivery(msg.clientMsgId, 'failed');
        } else if (
          msg.control !== 'send' ||
          eventSessionId !== parserState.currentSessionId ||
          !pendingOptimisticMessageIds.has(msg.clientMsgId)
        )
          return true;
        // Legacy ordinary send callers have no draft observer; retain their
        // existing scoped error feedback rather than swallowing the refusal.
      }
      if (eventSessionId !== parserState.currentSessionId) return true;
    }
    if (msg.type === 'session_id' && typeof eventSessionId === 'string') {
      if (typeof msg.clientMsgId === 'string') assignCommand(msg.clientMsgId, eventSessionId);
      // Correlated assignments survive navigation; only their original draft may be selected.
      const id =
        typeof msg.clientMsgId === 'string'
          ? msg.clientMsgId
          : [...unassignedDeliveries.keys()].find((id) => pendingOptimisticMessageIds.has(id));
      if (id && unassignedDeliveries.has(id)) {
        const foreground = bindLaunchAssignment(id, eventSessionId);
        if (!foreground) return true;
      } else if (id) {
        const origin = deliveryOrigins.get(id);
        if (origin?.control === 'send' && deliveryObservers.has(id)) {
          const foreground = bindLaunchAssignment(id, eventSessionId);
          if (!foreground) return true;
        }
      }
    }

    // Startup rejection may arrive after session_id. Only the matching command
    // can release its launch; unrelated runtime errors are not delivery receipts.
    if (msg.type === 'error' && typeof msg.clientMsgId === 'string') {
      const origin = deliveryOrigins.get(msg.clientMsgId);
      if (origin?.sessionId && eventSessionId && origin.sessionId !== eventSessionId) return true;
      const offscreen =
        origin &&
        (origin.sessionId
          ? origin.sessionId !== parserState.currentSessionId
          : origin.historyRequest !== historyRequest ||
            origin.launchGeneration !== launchGeneration);
      if (!options.sseConfig) settleDelivery(msg.clientMsgId, 'failed');
      // Release its preview without applying the error to an unrelated running chat.
      if (offscreen) return true;
      const messages = store.getState().messages.messages;
      const commandIndex = messages.findIndex(
        (message) => message.role === 'user' && message.messageId === msg.clientMsgId,
      );
      if (
        selectedEventSession &&
        commandIndex >= 0 &&
        msg.v === 2 &&
        msg.retainedCommandFailure === true &&
        typeof msg.error === 'string' &&
        msg.error.startsWith('Message saved. ') &&
        typeof msg.seq === 'number' &&
        Number.isSafeInteger(msg.seq) &&
        msg.seq > 0
      )
        retainedFailureSeq = msg.seq;
      if (
        selectedEventSession &&
        commandIndex >= 0 &&
        messages.slice(commandIndex + 1).some((message) => message.role === 'user')
      ) {
        // A retained command may fail recovery after a later command starts.
        // Render its failure through the existing non-terminal refusal action;
        // keep the sequenced event on the normal applied-delivery path.
        const preparation = preparationObservations.get(msg.clientMsgId);
        if (preparation?.sessionId === eventSessionId) preparation.ended = true;
        msg = { ...msg, type: 'session_control_rejected', control: 'send' };
      }
    }
    // The native WebSocket path confirms delivery through the persisted echo.
    // A pre-assignment startup error is a definitive rejection on that path.
    if (
      !options.sseConfig &&
      msg.type === 'error' &&
      typeof msg.clientMsgId !== 'string' &&
      !parserState.currentSessionId
    ) {
      for (const id of pendingOptimisticMessageIds) {
        settleDelivery(id, 'failed');
      }
    }
    if (msg.type === 'native_command_result' && typeof msg.clientMsgId === 'string') {
      const origin = deliveryOrigins.get(msg.clientMsgId);
      if (origin?.control === 'send' && (origin.sessionId ?? null) === (eventSessionId ?? null))
        settleDelivery(msg.clientMsgId, 'accepted');
    }

    // Delivery receipts settle their original launch even when its chat is no longer visible.
    // Transcript updates below remain scoped to the current chat.
    if (
      msg.type === 'user_message' &&
      typeof msg.messageId === 'string' &&
      !isLocalDelivery(msg.messageId)
    ) {
      const origin = deliveryOrigins.get(msg.messageId);
      // A saved first input may arrive before session_id on legacy/startup
      // routes. Its exact command establishes the previously unassigned owner.
      if (
        origin?.control === 'send' &&
        !origin.sessionId &&
        typeof eventSessionId === 'string' &&
        unassignedDeliveries.has(msg.messageId)
      ) {
        const foreground = bindLaunchAssignment(msg.messageId, eventSessionId);
        if (foreground) callbacks.onSessionAssigned(eventSessionId);
      }
      if (!matchesDeliverySession(msg.messageId, eventSessionId)) return true;
      observePreparation(msg.messageId, eventSessionId);
      settleDelivery(msg.messageId, 'accepted');
    }

    // Observe a known command's completion even when its view is offscreen.
    // This is UI progress only: it never accepts or retries an uncertain send.
    if (msg.type === 'session_end' && typeof eventSessionId === 'string') {
      for (const observation of preparationObservations.values())
        if (observation.sessionId === eventSessionId) observation.ended = true;
    }

    if (
      msg.type === 'session_reconnect_snapshot' &&
      typeof eventSessionId === 'string' &&
      eventSessionId !== parserState.currentSessionId &&
      typeof msg.cursor === 'number' &&
      Number.isSafeInteger(msg.cursor) &&
      msg.cursor >= 0
    ) {
      const cursor = msg.cursor;
      if (!sessionInterests.has(eventSessionId)) return true;
      const interest = sessionInterests.get(eventSessionId);
      const read = { controller: new AbortController() };
      const connectionId = connection.getConnectionId();
      backgroundSnapshotReads.set(eventSessionId, read);
      const isCurrent = () =>
        backgroundSnapshotReads.get(eventSessionId) === read &&
        sessionInterests.get(eventSessionId) === interest &&
        !read.controller.signal.aborted &&
        connection.getConnectionId() === connectionId;
      const acknowledge = () =>
        connection.acknowledgeReconnectSnapshot(
          eventSessionId,
          cursor,
          typeof msg.offerId === 'string' ? msg.offerId : undefined,
        );
      void api
        .getReconnectTranscript(eventSessionId, cursor, read.controller.signal)
        .then((transcript) => {
          if (!isCurrent()) return;
          confirmPersistedDelivery(eventSessionId, transcript.messages);
          if (!isCurrent()) return;
          if (parserState.currentSessionId === eventSessionId) {
            // The receipt/navigation may have installed a newer transcript while
            // this read was pending. Restore this exact prefix before releasing
            // its buffered suffix, replacing the competing restore generation.
            fetchAndRestoreMessages(
              eventSessionId,
              cursor,
              true,
              acknowledge,
              Promise.resolve(transcript),
            );
          } else {
            connection.commitTranscriptCursor(eventSessionId, cursor);
            acknowledge();
          }
        })
        .catch(() => {
          if (isCurrent()) connection.checkAndReconnect(true);
        })
        .finally(() => {
          if (backgroundSnapshotReads.get(eventSessionId) === read)
            backgroundSnapshotReads.delete(eventSessionId);
        });
      return true;
    }

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
            if (!msg.offerId) connection.acknowledgeReconnectSnapshot(eventSessionId, msg.cursor);
          // Filtering another chat is successful transport consumption. A
          // refused event would reconnect and replay the same foreign event.
          return true;
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
            if (!msg.offerId) connection.acknowledgeReconnectSnapshot(eventSessionId, msg.cursor);
          return true;
        }
      }
    }

    if (
      (['message_start', 'session_end', 'error'].includes(String(msg.type)) ||
        (msg.type === 'message_snapshot' &&
          Array.isArray(msg.blocks) &&
          typeof msg.startedSeq === 'number' &&
          Number.isSafeInteger(msg.startedSeq) &&
          msg.startedSeq >
            (store
              .getState()
              .messages.messages.filter((message) => message.role === 'user')
              .at(-1)?.startedSeq ?? Infinity))) &&
      store.getState().sendStatus === 'Preparing response…'
    )
      store.setState({ sendStatus: null });

    if (
      selectedEventSession &&
      (msg.type === 'codex_queue' || msg.type === 'user_message' || msg.type === 'session_end')
    )
      store.setState((state) => ({ queueRevision: state.queueRevision + 1 }));

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
    if (result.resyncRequired) {
      store.setState((s) => ({
        messages: { ...s.messages, resyncRequired: true },
      }));
      return false;
    }

    if (result.modeUpdate) {
      awaitingModeHydration = undefined;
      store.setState((s) => ({
        config: { ...s.config, mode: result.modeUpdate! },
        modeChangeReady: !awaitingSessionId,
      }));
    }

    for (const incomingAction of result.messagesActions) {
      if (incomingAction.type === 'SET_SESSION_CONTEXT') contextDisplayWritten = true;
      const action = normalizePermissionAction(
        retainedFailureSeq !== undefined &&
          (incomingAction.type === 'ERROR' || incomingAction.type === 'CONTROL_REJECTED')
          ? { ...incomingAction, retainedFailureSeq }
          : incomingAction,
      );
      const opening = openingHistory;
      if (
        opening !== undefined &&
        opening.sessionId === eventSessionId &&
        typeof msg.seq === 'number' &&
        Number.isSafeInteger(msg.seq)
      )
        opening.actions.push({ seq: msg.seq, action });
      if (action.type === 'USER_MESSAGE_RECEIVED') {
        if (!isLocalDelivery(action.messageId))
          pendingOptimisticMessageIds.delete(action.messageId);
        settleDelivery(action.messageId, 'accepted');
      }
      const isPostCursorAction =
        boundedRestore &&
        eventSessionId === boundedRestore.sessionId &&
        typeof msg.seq === 'number' &&
        Number.isSafeInteger(msg.seq) &&
        msg.seq > boundedRestore.throughSeq;
      if (isPostCursorAction) {
        boundedRestore!.liveActions.push({ seq: msg.seq as number, action });
        if (action.type === 'USER_MESSAGE_RECEIVED')
          boundedRestore!.confirmedMessageIds.add(action.messageId);
      }
      const nextMessages = messagesReducer(store.getState().messages, action);
      if (nextMessages.resyncRequired) {
        store.setState({ messages: nextMessages });
        return false;
      }
      store.setState({ messages: nextMessages });
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
        connection: {
          ...s.connection,
          ...result.connectionUpdate,
          clientId:
            msg.type === '_open'
              ? connection.getConnectionId()
              : msg.type === '_close'
                ? null
                : s.connection.clientId,
        },
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
    return true;
  }

  connection.onMessage(wsListener);
  if (options.initiallyAuthenticated === false) connection.blockAuthentication();
  connection.connect();
  if (reviewedAuthenticated) {
    reviewedOutbox?.start();
    localOutbox?.start();
  }

  return store;
}
