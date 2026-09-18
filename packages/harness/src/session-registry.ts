import type { SessionTransport } from './session-transport.js';
import { randomUUID } from 'node:crypto';
import {
  DETACHED_TTL_MS,
  CLOSEOUT_LEAD_MS,
  CLOSEOUT_TIMEOUT_MS,
  MAX_OBSERVERS_PER_SESSION,
  SUSPEND_GRACE_MS,
  SUSPEND_BUFFER_MAX,
  MAX_PENDING_EXECUTIONS_PER_SESSION,
  MAX_PENDING_EXECUTION_RETAINED_BYTES,
  MAX_PENDING_EXECUTIONS_RETAINED_BYTES,
  MAX_REPLACEMENT_INPUT_ENVELOPES_PER_SESSION,
  MAX_REPLACEMENT_INPUT_RETAINED_BYTES,
} from './constants.js';
import { createLogger } from './logger.js';

const log = createLogger('session-registry');

export type {
  MitzoMode,
  SnapshotBlock,
  MessageSnapshot,
  RawToolInput,
  AgentDefinitionSource,
} from '@mitzo/protocol';
import type {
  AccountBinding,
  MitzoMode,
  MessageSnapshot,
  AgentDefinitionSource,
  AgentDefinition,
  ExecutionToken,
} from '@mitzo/protocol';

/** Provider-agnostic work accepted before it receives a durable execution generation. */
export interface PendingExecutionInput {
  /** Server-allocated id. It is stable across admission retries. */
  executionId: string;
  clientMsgId: string;
  requestFingerprint: string;
  /**
   * Bytes retained by the dispatch closure, computed from the canonical,
   * already-validated prepared request. Production admission wiring supplies
   * this; do not estimate from provider-specific opaque payloads here.
   */
  retainedBytes: number;
  /** Initial startup failures have a more precise durable terminal reason. */
  isInitial: boolean;
  /** Called after the durable RUNNING row and current lease are visible. */
  onAdmitted?: (token: ExecutionToken) => void;
  /** Settles a locally pending transport receipt when activation is cancelled. */
  onRejected?: (error: unknown) => void;
  /** Shared only while the bounded input has no durable RUNNING row yet. */
  admissionReceipt?: Promise<boolean>;
  dispatch: (token: ExecutionToken) => Promise<void> | void;
}

/** Provider work prepared for an atomic replacement of the current execution. */
export interface PreparedReplacementInput {
  expectedToken: ExecutionToken;
  executionId?: string;
  clientMsgId: string;
  requestFingerprint: string;
  retainedBytes: number;
  userMessage: {
    messageId: string;
    text: string;
    images?: Array<{ id: string; mediaType: string }>;
    contextBlocks?: string[];
  };
  selectedModel?: string | null;
  reasoningEffort?: string | null;
  onAdmitted?: (token: ExecutionToken) => void;
  /** Fence owner changes before the EventStore transaction. Exact duplicate receipts skip this. */
  reserveOwner?: () => unknown | undefined;
  /** Commit the already-reserved owner before any broadcast/provider work. */
  commitOwner?: (reservation: unknown) => boolean;
  /** Release a pre-admission reservation when the transaction cannot commit. */
  releaseOwner?: (reservation: unknown) => void;
  /** Commit transport ownership after durable admission and before any live delivery. */
  beforeDispatch?: (token: ExecutionToken) => Promise<boolean> | boolean;
  dispatch: (token: ExecutionToken) => Promise<void> | void;
}

/** Immutable identity for one registered runtime, safe across client-id rekeys. */
export interface RuntimeSessionLease {
  runtimeLeaseId: string;
  sessionId: string;
}

/** A compare-and-swap snapshot of the transport allowed to drive a runtime. */
export interface RuntimeOwnerSnapshot extends RuntimeSessionLease {
  ownerConnectionId: string;
  ownerRevision: number;
}

/** A short-lived fence around durable replacement admission. It deliberately
 * does not route output until commitReservedRuntimeOwner succeeds. */
export interface RuntimeOwnerReservation extends RuntimeOwnerSnapshot {
  readonly reservationId: symbol;
  readonly nextOwnerConnectionId: string;
  readonly nextTransport: SessionTransport;
}

/** One Anthropic envelope waiting for the preceding provider turn to finish. */
export interface ReplacementInputBarrier {
  token: ExecutionToken;
  retainedBytes: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface ManagedSession {
  /** Never changes for this object; invalidated when the runtime is removed. */
  readonly runtimeLeaseId: string;
  /** Current event connection; the registry key remains stable for the query lifetime. */
  ownerConnectionId?: string;
  /** Monotonic owner epoch; guards takeovers across reconnect/rekey ABA. */
  ownerRevision: number;
  transport: SessionTransport;
  abortController: AbortController;
  sessionId?: string;
  sessionAllowList: Set<string>;
  mode: MitzoMode;
  cwd?: string;
  /** Git branch at session start. */
  branch?: string;
  /** Model used for this session's SDK query. */
  model?: string;
  /** Immutable provider/account routing identity for validating live model changes. */
  accountBinding?: AccountBinding;
  /** Session-scoped worktree identifier, shared across all repos. */
  wtId?: string;
  worktreePath?: string;
  /** All worktrees created for this session, keyed by repo name. */
  worktreePaths: Map<string, { path: string; wtId: string }>;
  /** Requested transitions constrain tools immediately until runtime acknowledgment. */
  pendingPermissionModes?: Map<symbol, MitzoMode>;
  queryInstance?: {
    /** Apply the shared Mitzo mode to provider runtime controls, when required. */
    setPermissionMode?: (mode: MitzoMode) => Promise<void>;
    interrupt: () => Promise<void>;
    close: () => void;
    stopTask: (taskId: string) => Promise<void>;
  };
  inputQueue?: { push: (msg: unknown) => void; close: () => void };
  currentSnapshot: MessageSnapshot | null;
  activeSkillPolicy: Set<string> | null;
  observers: Set<SessionTransport>;
  /** Accumulates token totals across multiple query() calls in a session */
  cumulativeSessionTokens: number;
  cumulativeCostUsd: number;
  taskContext: { currentTaskId: string; goalId: string } | null;
  telosTaskId?: string;
  /** Active subagent task IDs — task_id → tool_use_id (parent_tool_use_id). */
  activeTaskIds: Map<string, string>;
  /** Agent name used for this session (e.g. 'mitzo-conversational'). */
  agentName?: string;
  /** Cached boot_context payload for replay on reconnect/switch. */
  bootContext?: Record<string, unknown>;
  /** Parsed agent definition (recipe). Populated asynchronously after session start. */
  agentDefinition?: AgentDefinition | null;
  /** Source of the agent definition: 'contexgin' | 'local' | 'fallback'. */
  agentDefinitionSource?: AgentDefinitionSource;
  /** The only durable execution currently dispatched to a provider. */
  currentExecution?: ExecutionToken;
  /** Exact token deliberately stopped by the owner; never inferred from AbortSignal. */
  stoppedExecution?: ExecutionToken;
  /** FIFO work with preallocated ids but no durable generation yet. */
  pendingExecutions: PendingExecutionInput[];
  /** Exact sum of retainedBytes for pendingExecutions. */
  pendingExecutionBytes: number;
  /** Serializes admission/activation while a dispatcher yields. */
  activatingPending: boolean;
  /** Serializes replacement admission against another interrupt/stop. */
  replacingExecution: boolean;
  /** Prevents attachment/takeover/rekey from changing ownership mid-admission. */
  ownerReservation?: RuntimeOwnerReservation;
  /** Bounded provider-input barrier for a replacement behind a prior turn. */
  replacementInputBarrier?: ReplacementInputBarrier;
  /** Aggregate retained Anthropic replacement envelopes (currently capped at one). */
  replacementInputCount: number;
  replacementInputBytes: number;
}

/** Never expand permissions until a transition succeeds; apply downgrades immediately. */
export function effectivePermissionMode(
  session: Pick<ManagedSession, 'mode' | 'pendingPermissionModes'>,
): MitzoMode {
  const rank: Record<MitzoMode, number> = { ask: 0, agent: 1, auto: 2 };
  let mode = session.mode;
  for (const pending of session.pendingPermissionModes?.values() ?? []) {
    if (rank[pending] < rank[mode]) mode = pending;
  }
  return mode;
}

export interface ActiveSessionInfo {
  clientId: string;
  sessionId: string | undefined;
  mode: MitzoMode;
  cwd: string | undefined;
  attached: boolean;
  cumulativeSessionTokens: number;
  cumulativeCostUsd: number;
  hasSnapshot: boolean;
  taskContext: { currentTaskId: string; goalId: string } | null;
  observerCount: number;
}

export type CloseoutHandler = (clientId: string) => void;

function ownerConnectionForClientId(clientId: string): string {
  const separator = clientId.indexOf(':');
  return separator === -1 ? clientId : clientId.slice(0, separator);
}

export class SessionRegistry {
  private sessions = new Map<string, ManagedSession>();
  private leases = new Map<string, string>();
  private attached = new Set<string>();
  private detachTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closingOut = new Set<string>();
  private userClosing = new Set<string>();
  private closeoutHandler: CloseoutHandler | null = null;
  private suspended = new Set<string>();
  private suspendBuffers = new Map<string, Record<string, unknown>[]>();
  private suspendTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Register a handler called when a session enters closeout. */
  setCloseoutHandler(handler: CloseoutHandler): void {
    this.closeoutHandler = handler;
  }

  /** Check if a session is currently in the closeout phase. */
  isClosingOut(clientId: string): boolean {
    return this.closingOut.has(clientId);
  }

  /** Mark a session as being closed by the user. */
  markUserClose(clientId: string): void {
    this.userClosing.add(clientId);
    this.closingOut.add(clientId);
  }

  /** Check if a session close was user-initiated. */
  isUserClose(clientId: string): boolean {
    return this.userClosing.has(clientId);
  }

  register(
    clientId: string,
    init: Omit<
      ManagedSession,
      | 'queryInstance'
      | 'inputQueue'
      | 'currentSnapshot'
      | 'worktreePaths'
      | 'activeSkillPolicy'
      | 'observers'
      | 'cumulativeSessionTokens'
      | 'cumulativeCostUsd'
      | 'taskContext'
      | 'activeTaskIds'
      | 'agentDefinition'
      | 'agentDefinitionSource'
      | 'currentExecution'
      | 'pendingExecutions'
      | 'activatingPending'
      | 'runtimeLeaseId'
      | 'pendingExecutionBytes'
      | 'replacingExecution'
      | 'ownerReservation'
      | 'replacementInputBarrier'
      | 'replacementInputCount'
      | 'replacementInputBytes'
      | 'ownerRevision'
    > & {
      sessionId?: string;
    },
  ): void {
    const previous = this.sessions.get(clientId);
    if (previous) {
      // A runtime replacement invalidates any old provider-input wait. Do not
      // leave its timer retaining a stale session closure until it expires.
      this.clearReplacementInputBarrier(previous);
      this.leases.delete(previous.runtimeLeaseId);
    }
    const session: ManagedSession = {
      ...init,
      runtimeLeaseId: randomUUID(),
      worktreePaths: new Map(),
      currentSnapshot: null,
      activeSkillPolicy: null,
      observers: new Set(),
      cumulativeSessionTokens: 0,
      cumulativeCostUsd: 0,
      taskContext: null,
      activeTaskIds: new Map(),
      agentDefinition: null,
      agentDefinitionSource: undefined,
      currentExecution: undefined,
      stoppedExecution: undefined,
      pendingExecutions: [],
      pendingExecutionBytes: 0,
      activatingPending: false,
      replacingExecution: false,
      ownerReservation: undefined,
      replacementInputBarrier: undefined,
      replacementInputCount: 0,
      replacementInputBytes: 0,
      ownerConnectionId: init.ownerConnectionId ?? ownerConnectionForClientId(clientId),
      ownerRevision: 1,
    };
    this.sessions.set(clientId, session);
    this.leases.set(session.runtimeLeaseId, clientId);
    this.attached.add(clientId);
  }

  get(clientId: string): ManagedSession | undefined {
    return this.sessions.get(clientId);
  }

  entries(): IterableIterator<[string, ManagedSession]> {
    return this.sessions.entries();
  }

  isActive(clientId: string): boolean {
    return this.sessions.has(clientId);
  }

  isAttached(clientId: string): boolean {
    return this.attached.has(clientId);
  }

  /** Queue work synchronously before durable admission so the bound is race-free. */
  enqueuePendingExecution(clientId: string, input: PendingExecutionInput): boolean {
    const session = this.sessions.get(clientId);
    if (
      !session ||
      !this.isValidRetainedBytes(input.retainedBytes) ||
      input.retainedBytes > MAX_PENDING_EXECUTION_RETAINED_BYTES ||
      session.pendingExecutions.length >= MAX_PENDING_EXECUTIONS_PER_SESSION ||
      session.pendingExecutionBytes > MAX_PENDING_EXECUTIONS_RETAINED_BYTES - input.retainedBytes
    ) {
      return false;
    }
    session.pendingExecutions.push(input);
    session.pendingExecutionBytes += input.retainedBytes;
    return true;
  }

  /** Bounded lookup for a receipt that has not yet acquired a RUNNING row. */
  findPendingExecution(clientId: string, clientMsgId: string): PendingExecutionInput | undefined {
    return this.sessions
      .get(clientId)
      ?.pendingExecutions.find((input) => input.clientMsgId === clientMsgId);
  }

  /** Claim the controller activation slot. It is released by completePendingActivation(). */
  beginPendingActivation(clientId: string): RuntimeSessionLease | undefined {
    const session = this.sessions.get(clientId);
    if (
      !session ||
      !session.sessionId ||
      session.currentExecution ||
      session.activatingPending ||
      session.pendingExecutions.length === 0
    ) {
      return undefined;
    }
    session.activatingPending = true;
    return { runtimeLeaseId: session.runtimeLeaseId, sessionId: session.sessionId };
  }

  /** Claim activation only if this exact immutable runtime remains registered. */
  beginPendingActivationForLease(lease: RuntimeSessionLease): RuntimeSessionLease | undefined {
    const session = this.resolveLease(lease)?.session;
    if (
      !session ||
      session.currentExecution ||
      session.activatingPending ||
      session.pendingExecutions.length === 0
    ) {
      return undefined;
    }
    session.activatingPending = true;
    return lease;
  }

  completePendingActivation(lease: RuntimeSessionLease): void {
    const session = this.resolveLease(lease)?.session;
    if (session) session.activatingPending = false;
  }

  /** Resolve the exact registered object. A reused client id never matches an old lease. */
  resolveRuntimeLease(
    lease: RuntimeSessionLease,
  ): { clientId: string; session: ManagedSession } | undefined {
    return this.resolveLease(lease);
  }

  peekPendingExecution(lease: RuntimeSessionLease): PendingExecutionInput | undefined {
    return this.resolveLease(lease)?.session.pendingExecutions[0];
  }

  shiftPendingExecution(lease: RuntimeSessionLease): PendingExecutionInput | undefined {
    const session = this.resolveLease(lease)?.session;
    if (!session) return undefined;
    const pending = session.pendingExecutions.shift();
    if (!pending) return undefined;
    if (session.pendingExecutionBytes < pending.retainedBytes) {
      throw new Error('Pending execution byte accounting underflow');
    }
    session.pendingExecutionBytes -= pending.retainedBytes;
    return pending;
  }

  setCurrentExecution(lease: RuntimeSessionLease, token: ExecutionToken): boolean {
    const session = this.resolveLease(lease)?.session;
    if (!session || session.currentExecution) return false;
    if (token.sessionId !== lease.sessionId) return false;
    session.currentExecution = token;
    return true;
  }

  clearCurrentExecution(lease: RuntimeSessionLease, token: ExecutionToken): boolean {
    const session = this.resolveLease(lease)?.session;
    const current = session?.currentExecution;
    if (
      !session ||
      !current ||
      current.sessionId !== token.sessionId ||
      current.executionId !== token.executionId ||
      current.generation !== token.generation
    ) {
      return false;
    }
    session.currentExecution = undefined;
    return true;
  }

  /** Claim replacement only for this immutable runtime and exact current token. */
  claimReplacementExecution(lease: RuntimeSessionLease, token: ExecutionToken): boolean {
    const session = this.resolveLease(lease)?.session;
    const current = session?.currentExecution;
    if (
      !session ||
      session.replacingExecution ||
      !current ||
      current.sessionId !== token.sessionId ||
      current.executionId !== token.executionId ||
      current.generation !== token.generation
    )
      return false;
    session.replacingExecution = true;
    return true;
  }

  completeReplacementExecution(lease: RuntimeSessionLease): void {
    const session = this.resolveLease(lease)?.session;
    if (session) session.replacingExecution = false;
  }

  /**
   * Retain exactly one replacement while Anthropic has not yet observed the
   * predecessor's terminal boundary. The timeout callback runs only after the
   * barrier is atomically released, so a late normal consumption cannot race
   * it into a second teardown.
   */
  claimReplacementInputBarrier(
    lease: RuntimeSessionLease,
    token: ExecutionToken,
    retainedBytes: number,
    timeoutMs: number,
    onTimeout: () => void,
  ): boolean {
    const session = this.resolveLease(lease)?.session;
    const current = session?.currentExecution;
    if (
      !session ||
      !current ||
      current.executionId !== token.executionId ||
      current.generation !== token.generation ||
      token.sessionId !== lease.sessionId ||
      session.replacementInputBarrier ||
      session.replacementInputCount >= MAX_REPLACEMENT_INPUT_ENVELOPES_PER_SESSION ||
      !this.isValidRetainedBytes(retainedBytes) ||
      retainedBytes > MAX_REPLACEMENT_INPUT_RETAINED_BYTES ||
      session.replacementInputBytes > MAX_REPLACEMENT_INPUT_RETAINED_BYTES - retainedBytes
    )
      return false;
    const barrier: ReplacementInputBarrier = {
      token,
      retainedBytes,
      timer: setTimeout(() => {
        const live = this.resolveLease(lease)?.session;
        if (live?.replacementInputBarrier !== barrier) return;
        live.replacementInputBarrier = undefined;
        live.replacementInputCount -= 1;
        live.replacementInputBytes -= barrier.retainedBytes;
        onTimeout();
      }, timeoutMs),
    };
    session.replacementInputBarrier = barrier;
    session.replacementInputCount += 1;
    session.replacementInputBytes += retainedBytes;
    return true;
  }

  /** Return retained replacement input only when its exact token consumed or ended. */
  releaseReplacementInputBarrier(lease: RuntimeSessionLease, token: ExecutionToken): boolean {
    const session = this.resolveLease(lease)?.session;
    const barrier = session?.replacementInputBarrier;
    if (
      !session ||
      !barrier ||
      barrier.token.executionId !== token.executionId ||
      barrier.token.generation !== token.generation ||
      barrier.token.sessionId !== token.sessionId
    )
      return false;
    clearTimeout(barrier.timer);
    session.replacementInputBarrier = undefined;
    session.replacementInputCount -= 1;
    session.replacementInputBytes -= barrier.retainedBytes;
    return true;
  }

  hasReplacementInputBarrier(lease: RuntimeSessionLease): boolean {
    return !!this.resolveLease(lease)?.session.replacementInputBarrier;
  }

  private clearReplacementInputBarrier(session: ManagedSession): void {
    if (session.replacementInputBarrier) clearTimeout(session.replacementInputBarrier.timer);
    session.replacementInputBarrier = undefined;
    session.replacementInputCount = 0;
    session.replacementInputBytes = 0;
  }

  /** CAS current token after durable old-terminal/new-running replacement. */
  replaceCurrentExecution(
    lease: RuntimeSessionLease,
    expected: ExecutionToken,
    replacement: ExecutionToken,
  ): boolean {
    const session = this.resolveLease(lease)?.session;
    const current = session?.currentExecution;
    if (
      !session ||
      !current ||
      current.executionId !== expected.executionId ||
      current.generation !== expected.generation ||
      replacement.sessionId !== lease.sessionId
    )
      return false;
    session.currentExecution = replacement;
    return true;
  }

  /** Clear pending work when a runtime is definitively gone; no generation is allocated. */
  drainPendingExecutions(clientId: string): PendingExecutionInput[] {
    const session = this.sessions.get(clientId);
    if (!session) return [];
    const pending = session.pendingExecutions;
    session.pendingExecutions = [];
    session.pendingExecutionBytes = 0;
    return pending;
  }

  /** Capture an existing lease without claiming activation. */
  getRuntimeLease(clientId: string): RuntimeSessionLease | undefined {
    const session = this.sessions.get(clientId);
    return session?.sessionId
      ? { runtimeLeaseId: session.runtimeLeaseId, sessionId: session.sessionId }
      : undefined;
  }

  /**
   * Detach the transport from a session without killing the SDK query.
   * Starts a two-phase timer:
   * 1. At TTL - CLOSEOUT_LEAD_MS: start graceful closeout (if handler set)
   * 2. At TTL (or CLOSEOUT_TIMEOUT_MS after closeout start): abort
   */
  detach(clientId: string): void {
    const session = this.sessions.get(clientId);
    if (!session) return;

    // Suspend takes precedence — don't transition to detach while suspended.
    if (this.suspended.has(clientId)) return;

    this.attached.delete(clientId);
    this.clearDetachTimer(clientId);
    this.clearCloseoutTimer(clientId);

    if (this.closeoutHandler) {
      // Phase 1: fire closeout at TTL - CLOSEOUT_LEAD_MS
      const closeoutDelay = DETACHED_TTL_MS - CLOSEOUT_LEAD_MS;
      const timer = setTimeout(() => {
        this.detachTimers.delete(clientId);
        if (!this.sessions.has(clientId) || this.attached.has(clientId)) return;
        log.info(`detach closeout starting for ${clientId}`);
        this.closingOut.add(clientId);
        this.closeoutHandler!(clientId);
        // Phase 2: hard abort after CLOSEOUT_TIMEOUT_MS
        const abortTimer = setTimeout(() => {
          this.closeoutTimers.delete(clientId);
          // Don't delete closingOut here — abort() will do it AFTER
          // firing the abort signal, so listeners can check isClosingOut().
          if (this.sessions.has(clientId) && !this.attached.has(clientId)) {
            log.info(`closeout timeout for ${clientId}, aborting`);
            this.abort(clientId);
          }
        }, CLOSEOUT_TIMEOUT_MS);
        this.closeoutTimers.set(clientId, abortTimer);
      }, closeoutDelay);
      this.detachTimers.set(clientId, timer);
    } else {
      // No closeout handler — fall back to direct abort at full TTL
      const timer = setTimeout(() => {
        this.detachTimers.delete(clientId);
        if (this.sessions.has(clientId) && !this.attached.has(clientId)) {
          log.info(`detach TTL expired for ${clientId}, aborting`);
          this.abort(clientId);
        }
      }, DETACHED_TTL_MS);
      this.detachTimers.set(clientId, timer);
    }
  }

  /**
   * Reattach a new transport to an existing session.
   * Cancels any pending closeout. Returns true if reattached.
   */
  reattach(clientId: string, transport: SessionTransport): boolean {
    const session = this.sessions.get(clientId);
    if (!session || session.ownerReservation) return false;

    session.transport = transport;
    session.ownerRevision += 1;
    this.attached.add(clientId);
    this.clearDetachTimer(clientId);
    this.clearCloseoutTimer(clientId);
    this.closingOut.delete(clientId);
    this.userClosing.delete(clientId);
    this.clearSuspendState(clientId);
    return true;
  }

  /** Capture the exact runtime and owner expected by a delayed replacement request. */
  getRuntimeOwnerSnapshot(lease: RuntimeSessionLease): RuntimeOwnerSnapshot | undefined {
    const resolved = this.resolveLease(lease);
    if (!resolved) return undefined;
    return {
      ...lease,
      ownerConnectionId:
        resolved.session.ownerConnectionId ?? ownerConnectionForClientId(resolved.clientId),
      ownerRevision: resolved.session.ownerRevision,
    };
  }

  /**
   * Atomically make a requester the runtime's transport owner. This is the
   * only replacement-time ownership transition: provider work must wait until
   * it succeeds so an older connection cannot receive a new generation.
   */
  compareAndSwapRuntimeOwner(
    expected: RuntimeOwnerSnapshot,
    nextOwnerConnectionId: string,
    nextTransport: SessionTransport,
  ): boolean {
    const resolved = this.resolveLease(expected);
    if (!resolved || resolved.session.ownerReservation) return false;
    const session = resolved.session;
    const currentOwner = session.ownerConnectionId ?? ownerConnectionForClientId(resolved.clientId);
    if (
      currentOwner !== expected.ownerConnectionId ||
      session.ownerRevision !== expected.ownerRevision
    )
      return false;
    const changed =
      session.ownerConnectionId !== nextOwnerConnectionId || session.transport !== nextTransport;
    session.ownerConnectionId = nextOwnerConnectionId;
    session.transport = nextTransport;
    if (changed) session.ownerRevision += 1;
    this.attached.add(resolved.clientId);
    this.clearDetachTimer(resolved.clientId);
    this.clearCloseoutTimer(resolved.clientId);
    this.closingOut.delete(resolved.clientId);
    this.userClosing.delete(resolved.clientId);
    this.clearSuspendState(resolved.clientId);
    return true;
  }

  /**
   * Revert a just-committed ownership handoff only when no later handoff won.
   * `committed` includes the revision allocated by the CAS, so this can never
   * overwrite a newer owner in an ABA race.
   */
  rollbackRuntimeOwner(
    committed: RuntimeOwnerSnapshot,
    previous: RuntimeOwnerSnapshot,
    previousTransport: SessionTransport,
  ): boolean {
    return this.compareAndSwapRuntimeOwner(
      committed,
      previous.ownerConnectionId,
      previousTransport,
    );
  }

  /** Reserve an unchanged owner snapshot before durable replacement admission. */
  reserveRuntimeOwner(
    expected: RuntimeOwnerSnapshot,
    nextOwnerConnectionId: string,
    nextTransport: SessionTransport,
  ): RuntimeOwnerReservation | undefined {
    const resolved = this.resolveLease(expected);
    if (!resolved) return undefined;
    const session = resolved.session;
    const currentOwner = session.ownerConnectionId ?? ownerConnectionForClientId(resolved.clientId);
    if (
      session.ownerReservation ||
      currentOwner !== expected.ownerConnectionId ||
      session.ownerRevision !== expected.ownerRevision
    )
      return undefined;
    const reservation: RuntimeOwnerReservation = {
      ...expected,
      reservationId: Symbol('runtime-owner-reservation'),
      nextOwnerConnectionId,
      nextTransport,
    };
    session.ownerReservation = reservation;
    return reservation;
  }

  /** Make a previously fenced handoff visible immediately before provider work. */
  commitReservedRuntimeOwner(reservation: RuntimeOwnerReservation): boolean {
    const resolved = this.resolveLease(reservation);
    if (!resolved || resolved.session.ownerReservation !== reservation) return false;
    const session = resolved.session;
    const currentOwner = session.ownerConnectionId ?? ownerConnectionForClientId(resolved.clientId);
    if (
      currentOwner !== reservation.ownerConnectionId ||
      session.ownerRevision !== reservation.ownerRevision
    ) {
      session.ownerReservation = undefined;
      return false;
    }
    const changed =
      session.ownerConnectionId !== reservation.nextOwnerConnectionId ||
      session.transport !== reservation.nextTransport;
    session.ownerConnectionId = reservation.nextOwnerConnectionId;
    session.transport = reservation.nextTransport;
    if (changed) session.ownerRevision += 1;
    session.ownerReservation = undefined;
    this.attached.add(resolved.clientId);
    this.clearDetachTimer(resolved.clientId);
    this.clearCloseoutTimer(resolved.clientId);
    this.closingOut.delete(resolved.clientId);
    this.userClosing.delete(resolved.clientId);
    this.clearSuspendState(resolved.clientId);
    return true;
  }

  /** DB failure/stale preflight: restore the exact no-routing state. */
  releaseRuntimeOwnerReservation(reservation: RuntimeOwnerReservation): boolean {
    const resolved = this.resolveLease(reservation);
    if (!resolved || resolved.session.ownerReservation !== reservation) return false;
    resolved.session.ownerReservation = undefined;
    return true;
  }

  /** Promote a known live connection outside a delayed replacement transaction. */
  promoteRuntimeOwner(
    clientId: string,
    ownerConnectionId: string,
    transport: SessionTransport,
  ): boolean {
    const lease = this.getRuntimeLease(clientId);
    if (!lease) return false;
    const expected = this.getRuntimeOwnerSnapshot(lease);
    return !!expected && this.compareAndSwapRuntimeOwner(expected, ownerConnectionId, transport);
  }

  /**
   * Re-key a session from oldId to newId. Moves all state (session data,
   * attached flag, detach timer) atomically. Used after transport reattach so
   * that the new connection's clientId becomes the canonical key, preventing
   * split-brain where isActive/stop/send target a stale key.
   */
  rekey(oldId: string, newId: string): boolean {
    const session = this.sessions.get(oldId);
    if (!session || session.ownerReservation || (oldId !== newId && this.sessions.has(newId)))
      return false;

    // A key move changes the authority used by legacy routing fallbacks.
    // Invalidate snapshots captured before it even when the transport object
    // itself is retained, so a delayed replacement cannot win an ABA race.
    if (oldId !== newId) session.ownerRevision += 1;

    this.sessions.delete(oldId);
    this.sessions.set(newId, session);
    this.leases.set(session.runtimeLeaseId, newId);

    if (this.attached.has(oldId)) {
      this.attached.delete(oldId);
      this.attached.add(newId);
    }

    const timer = this.detachTimers.get(oldId);
    if (timer) {
      this.detachTimers.delete(oldId);
      this.detachTimers.set(newId, timer);
    }

    this.moveKey(this.closeoutTimers, oldId, newId);
    this.moveSetKey(this.closingOut, oldId, newId);
    this.moveSetKey(this.userClosing, oldId, newId);
    this.moveSetKey(this.suspended, oldId, newId);
    this.moveKey(this.suspendBuffers, oldId, newId);
    this.moveKey(this.suspendTimers, oldId, newId);

    return true;
  }

  /**
   * Find a session by its SDK session ID (for reconnection by session ID).
   */
  findBySessionId(sessionId: string): { clientId: string; session: ManagedSession } | null {
    for (const [clientId, session] of this.sessions) {
      if (session.sessionId === sessionId) {
        return { clientId, session };
      }
    }
    return null;
  }

  /**
   * Add an observer transport to the session identified by sessionId.
   * Returns the clientId of the driver if successful, null otherwise.
   * Deduplicates (same transport is a no-op) and caps at MAX_OBSERVERS_PER_SESSION.
   */
  addObserver(sessionId: string, transport: SessionTransport): string | null {
    const found = this.findBySessionId(sessionId);
    if (!found) return null;
    // Already observing — idempotent no-op
    if (found.session.observers.has(transport)) return found.clientId;
    if (found.session.observers.size >= MAX_OBSERVERS_PER_SESSION) {
      log.warn('observer cap reached', { sessionId, max: MAX_OBSERVERS_PER_SESSION });
      return null;
    }
    found.session.observers.add(transport);
    // An active observer means someone is listening — don't let the detach
    // TTL kill the session out from under them.
    this.clearDetachTimer(found.clientId);
    log.info('observer added', { sessionId, observers: found.session.observers.size });
    return found.clientId;
  }

  /**
   * Remove a transport from all observer sets (cleanup on disconnect).
   * If the last observer leaves a detached session, restart the detach timer
   * so the session doesn't leak indefinitely.
   */
  removeObserver(transport: SessionTransport): void {
    for (const [clientId, session] of this.sessions) {
      if (!session.observers.delete(transport)) continue;
      if (session.observers.size === 0 && !this.attached.has(clientId)) {
        log.info('last observer left detached session, restarting detach timer', { clientId });
        this.detach(clientId);
      }
    }
  }

  setSessionId(clientId: string, sessionId: string): void {
    const session = this.sessions.get(clientId);
    if (session) session.sessionId = sessionId;
  }

  setMode(clientId: string, mode: MitzoMode): void {
    const session = this.sessions.get(clientId);
    if (session) session.mode = mode;
  }

  /**
   * Abort the SDK query and remove the session entirely.
   */
  abort(clientId: string): void {
    const session = this.sessions.get(clientId);
    if (!session) return;

    this.clearDetachTimer(clientId);
    this.clearCloseoutTimer(clientId);
    this.clearSuspendState(clientId);
    // Fire abort signal BEFORE clearing closingOut — abort listeners
    // check isClosingOut() to distinguish 'abandoned' vs 'closed' status.
    session.abortController.abort();
    this.clearReplacementInputBarrier(session);
    this.rejectPendingExecutions(session, 'Execution cancelled because the runtime closed');
    session.observers.clear();
    session.currentExecution = undefined;
    session.pendingExecutions = [];
    session.pendingExecutionBytes = 0;
    session.activatingPending = false;
    session.replacingExecution = false;
    this.leases.delete(session.runtimeLeaseId);
    this.sessions.delete(clientId);
    this.attached.delete(clientId);
    this.closingOut.delete(clientId);
    this.userClosing.delete(clientId);
  }

  /**
   * Remove a session from the registry without aborting.
   * Used when the SDK query finishes naturally.
   */
  remove(clientId: string): void {
    const session = this.sessions.get(clientId);
    if (session) {
      this.clearReplacementInputBarrier(session);
      this.rejectPendingExecutions(session, 'Execution cancelled because the runtime ended');
      session.observers.clear();
      session.currentExecution = undefined;
      session.pendingExecutions = [];
      session.pendingExecutionBytes = 0;
      session.activatingPending = false;
      session.replacingExecution = false;
      this.leases.delete(session.runtimeLeaseId);
    }
    this.clearDetachTimer(clientId);
    this.clearCloseoutTimer(clientId);
    this.clearSuspendState(clientId);
    this.sessions.delete(clientId);
    this.attached.delete(clientId);
    this.closingOut.delete(clientId);
    this.userClosing.delete(clientId);
  }

  private rejectPendingExecutions(session: ManagedSession, message: string): void {
    for (const pending of session.pendingExecutions) {
      try {
        pending.onRejected?.(new Error(message));
      } catch {
        // A receipt observer cannot prevent bounded runtime teardown.
      }
    }
  }

  /**
   * Clean up all sessions and timers. Used for graceful shutdown.
   */
  dispose(): void {
    for (const timer of this.detachTimers.values()) {
      clearTimeout(timer);
    }
    this.detachTimers.clear();

    for (const timer of this.closeoutTimers.values()) {
      clearTimeout(timer);
    }
    this.closeoutTimers.clear();
    this.closingOut.clear();
    this.userClosing.clear();

    for (const timer of this.suspendTimers.values()) {
      clearTimeout(timer);
    }
    this.suspendTimers.clear();
    this.suspended.clear();
    this.suspendBuffers.clear();

    for (const [clientId] of this.sessions) {
      this.abort(clientId);
    }
  }

  // ─── Suspend (proactive iOS backgrounding) ───────────────────────────────

  /**
   * Suspend a session. The client signals this BEFORE iOS kills the WebSocket,
   * enabling event buffering and instant resume. Starts a grace timer — if
   * the client doesn't resume within SUSPEND_GRACE_MS, the session transitions
   * to the normal detach flow.
   *
   * @param _lastClientSeq Reserved for future seq-based replay optimisation.
   *   Currently unused — reconnect replays from EventStore using the client's
   *   lastSeq, making this parameter redundant. Kept in the API so callers
   *   don't need changing when the optimisation lands.
   */
  suspend(clientId: string, _lastClientSeq: number): void {
    const session = this.sessions.get(clientId);
    if (!session) return;

    // Idempotent: if already suspended, only refresh the grace timer —
    // don't reset the buffer (visibilitychange + pagehide can fire twice).
    if (!this.suspended.has(clientId)) {
      this.suspended.add(clientId);
      this.suspendBuffers.set(clientId, []);
    }
    this.clearDetachTimer(clientId);
    this.clearSuspendTimer(clientId);

    const timer = setTimeout(() => {
      this.suspendTimers.delete(clientId);
      if (!this.sessions.has(clientId) || !this.suspended.has(clientId)) return;
      log.info('suspend grace expired, transitioning to detach', { clientId });
      this.suspended.delete(clientId);
      this.suspendBuffers.delete(clientId);
      this.detach(clientId);
    }, SUSPEND_GRACE_MS);
    this.suspendTimers.set(clientId, timer);
  }

  isSuspended(clientId: string): boolean {
    return this.suspended.has(clientId);
  }

  /**
   * Buffer an event for a suspended session. Returns false if the buffer
   * is full or the session is not suspended.
   */
  bufferEvent(clientId: string, event: Record<string, unknown>): boolean {
    if (!this.suspended.has(clientId)) return false;
    const buffer = this.suspendBuffers.get(clientId);
    if (!buffer) return false;
    if (buffer.length >= SUSPEND_BUFFER_MAX) {
      log.warn('suspend buffer full, dropping event', {
        clientId,
        bufferSize: buffer.length,
        droppedType: event.type,
      });
      return false;
    }
    buffer.push(event);
    return true;
  }

  /**
   * Resume a suspended session. Returns buffered events and clears suspend state.
   */
  resume(clientId: string): Record<string, unknown>[] {
    if (!this.suspended.has(clientId)) return [];
    const buffer = this.suspendBuffers.get(clientId) ?? [];
    this.clearSuspendState(clientId);
    return buffer;
  }

  /**
   * Return a serializable snapshot of all active sessions.
   */
  getActiveSessions(): ActiveSessionInfo[] {
    const result: ActiveSessionInfo[] = [];
    for (const [clientId, session] of this.sessions) {
      result.push({
        clientId,
        sessionId: session.sessionId,
        mode: session.mode,
        cwd: session.cwd,
        attached: this.attached.has(clientId),
        cumulativeSessionTokens: session.cumulativeSessionTokens,
        cumulativeCostUsd: session.cumulativeCostUsd,
        hasSnapshot: session.currentSnapshot !== null,
        taskContext: session.taskContext,
        observerCount: session.observers.size,
      });
    }
    return result;
  }

  private clearSuspendState(clientId: string): void {
    this.suspended.delete(clientId);
    this.suspendBuffers.delete(clientId);
    this.clearSuspendTimer(clientId);
  }

  private clearSuspendTimer(clientId: string): void {
    const existing = this.suspendTimers.get(clientId);
    if (existing) {
      clearTimeout(existing);
      this.suspendTimers.delete(clientId);
    }
  }

  private clearDetachTimer(clientId: string): void {
    const existing = this.detachTimers.get(clientId);
    if (existing) {
      clearTimeout(existing);
      this.detachTimers.delete(clientId);
    }
  }

  private clearCloseoutTimer(clientId: string): void {
    const existing = this.closeoutTimers.get(clientId);
    if (existing) {
      clearTimeout(existing);
      this.closeoutTimers.delete(clientId);
    }
  }

  private resolveLease(
    lease: RuntimeSessionLease,
  ): { clientId: string; session: ManagedSession } | undefined {
    const clientId = this.leases.get(lease.runtimeLeaseId);
    if (!clientId) return undefined;
    const session = this.sessions.get(clientId);
    if (
      !session ||
      session.runtimeLeaseId !== lease.runtimeLeaseId ||
      session.sessionId !== lease.sessionId
    ) {
      return undefined;
    }
    return { clientId, session };
  }

  private isValidRetainedBytes(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
  }

  private moveKey<T>(map: Map<string, T>, oldId: string, newId: string): void {
    const value = map.get(oldId);
    if (value !== undefined) {
      map.delete(oldId);
      map.set(newId, value);
    }
  }

  private moveSetKey(set: Set<string>, oldId: string, newId: string): void {
    if (set.delete(oldId)) set.add(newId);
  }
}
