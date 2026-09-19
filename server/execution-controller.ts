import type {
  ConnectionRegistry,
  PendingExecutionInput,
  PreparedReplacementInput,
  RuntimeSessionLease,
  SessionRegistry,
  SessionTransport,
} from '@mitzo/harness';
import { MAX_PENDING_EXECUTION_RETAINED_BYTES } from '@mitzo/harness';
import type {
  ExecutionTerminalReason,
  ExecutionToken,
  ExecutionStateChangedPayload,
} from '@mitzo/protocol';
import type { StoredEvent } from '@mitzo/protocol';
import type {
  BeginExecutionResult,
  ExecutionAdmissionResult,
  ExecutionTransitionResult,
  ReplacementAdmissionResult,
} from '@mitzo/protocol/event-store';
import type { EventStore } from './event-store.js';

type ExecutionStore = Pick<
  EventStore,
  | 'beginExecution'
  | 'admitExecution'
  | 'transitionExecution'
  | 'admitReplacement'
  | 'getReplacementAdmission'
  | 'getExecutionAdmission'
>;

export class PendingExecutionOverflowError extends Error {
  constructor(readonly clientId: string) {
    super(`Pending execution queue or retained-byte budget is full for ${clientId}`);
    this.name = 'PendingExecutionOverflowError';
  }
}

export interface StoredExecutionEvent {
  seq: number;
  event: ExecutionStateChangedPayload;
}

/** Any already-persisted, session-scoped event eligible for live delivery. */
export interface StoredBroadcastEvent {
  seq: number;
  event: { type: string; sessionId: string };
}

export interface ExecutionControllerOptions {
  registry: SessionRegistry;
  eventStore: ExecutionStore;
  connections?: ConnectionRegistry;
}

/** Internal receipt attribution; never emitted as a durable or wire event. */
export interface ActivationFailure {
  /** The generation that was admitted before the startup callback failed. */
  token?: ExecutionToken;
  executionId: string;
  clientMsgId: string;
  requestFingerprint: string;
  error: unknown;
}

export interface ActivationResult {
  token?: ExecutionToken;
  begin?: BeginExecutionResult;
  failures: ActivationFailure[];
  stale?: true;
}

export interface FinishExecutionResult {
  transition?: ExecutionTransitionResult;
  next?: ActivationResult;
  stale?: true;
}

export interface PendingAdmissionResult {
  /** The receipt is already durable and must not re-dispatch provider work. */
  durableDuplicate?: ExecutionToken;
  /** A queued exact retry shares this bounded entry's activation receipt. */
  pending?: PendingExecutionInput;
  conflict?: true;
  unavailable?: true;
}

export interface ReplaceExecutionResult {
  token?: ExecutionToken;
  admission?: ReplacementAdmissionResult;
  busy?: true;
  stale?: true;
  /** Durable admission succeeded, but an ownership precondition prevented dispatch. */
  notDispatched?: true;
  error?: unknown;
}

function sendOnce(
  transport: SessionTransport,
  data: Record<string, unknown>,
  sent: Set<SessionTransport>,
): boolean {
  if (sent.has(transport) || !transport.isOpen()) return false;
  try {
    transport.send(data);
    sent.add(transport);
    return true;
  } catch {
    // Durable replay remains the recovery path for a failed live transport.
    return false;
  }
}

/** Deliver the exact durable row; it never appends or allocates a new seq. */
export function broadcastStoredEvent(
  lease: RuntimeSessionLease,
  stored: StoredBroadcastEvent,
  registry: SessionRegistry,
  connections?: ConnectionRegistry,
): Set<SessionTransport> {
  const resolved = registry.resolveRuntimeLease(lease);
  if (!resolved || stored.event.sessionId !== lease.sessionId) return new Set();
  const data: Record<string, unknown> = { ...stored.event, seq: stored.seq };
  const suspended = registry.isSuspended(resolved.clientId);
  const suspendedDriver = suspended
    ? new Set<SessionTransport>([resolved.session.transport])
    : undefined;
  const sent =
    connections?.broadcast(lease.sessionId, data, { excludeTransports: suspendedDriver }) ??
    new Set<SessionTransport>();
  if (suspended) {
    registry.bufferEvent(resolved.clientId, data);
  }
  if (!suspended && registry.isAttached(resolved.clientId)) {
    if (sendOnce(resolved.session.transport, data, sent)) {
      connections?.recordFallbackDelivery(lease.sessionId, resolved.session.transport, stored.seq);
    }
  }
  for (const observer of resolved.session.observers) {
    if (suspended && observer === resolved.session.transport) continue;
    if (sendOnce(observer, data, sent)) {
      connections?.recordFallbackDelivery(lease.sessionId, observer, stored.seq);
    }
  }
  return sent;
}

/** Execution-state specialization retained for callers and focused tests. */
export function broadcastStoredExecutionEvent(
  lease: RuntimeSessionLease,
  stored: StoredExecutionEvent,
  registry: SessionRegistry,
  connections?: ConnectionRegistry,
): Set<SessionTransport> {
  return broadcastStoredEvent(lease, stored, registry, connections);
}

/** Isolated per-runtime execution admission; production provider wiring comes later. */
export class ExecutionController {
  constructor(private readonly options: ExecutionControllerOptions) {}

  enqueueExecution(clientId: string, prepared: PendingExecutionInput): void {
    if (!this.options.registry.enqueuePendingExecution(clientId, prepared)) {
      throw new PendingExecutionOverflowError(clientId);
    }
  }

  /**
   * Admit ordinary follow-up work through the canonical bounded FIFO. Pending
   * receipts are held only by the bounded queue; once RUNNING, EventStore is
   * the idempotency authority across retry/reconnect/restart.
   */
  admitPendingExecution(clientId: string, prepared: PendingExecutionInput): PendingAdmissionResult {
    const session = this.options.registry.get(clientId);
    if (!session?.sessionId) return { unavailable: true };
    const durable = this.options.eventStore.getExecutionAdmission(
      session.sessionId,
      prepared.clientMsgId,
    );
    if (durable) {
      if (durable.requestFingerprint !== prepared.requestFingerprint) return { conflict: true };
      return { durableDuplicate: durable.token };
    }
    const pending = this.options.registry.findPendingExecution(clientId, prepared.clientMsgId);
    if (pending) {
      if (pending.requestFingerprint !== prepared.requestFingerprint) return { conflict: true };
      return { pending };
    }
    try {
      this.enqueueExecution(clientId, prepared);
    } catch (error) {
      prepared.onRejected?.(error);
      throw error;
    }
    // Observe activation failures so they cannot become unhandled while an
    // HTTP caller awaits its receipt. `onRejected` is strictly pre-admission:
    // once the input has left the bounded queue, the durable RUNNING token
    // owns any provider failure through its canonical TERMINAL row.
    void this.activateNextExecution(clientId).catch((error: unknown) => {
      if (this.options.registry.findPendingExecution(clientId, prepared.clientMsgId) === prepared)
        prepared.onRejected?.(error);
    });
    return { pending: prepared };
  }

  async activateNextExecution(clientId: string): Promise<ActivationResult | undefined> {
    const lease = this.options.registry.beginPendingActivation(clientId);
    if (!lease) return undefined;
    return this.activateClaimedLease(lease);
  }

  async finishExecution(
    lease: RuntimeSessionLease,
    token: ExecutionToken,
    reason: ExecutionTerminalReason,
  ): Promise<FinishExecutionResult> {
    const resolved = this.options.registry.resolveRuntimeLease(lease);
    const current = resolved?.session.currentExecution;
    if (
      !resolved ||
      token.sessionId !== lease.sessionId ||
      !current ||
      current.sessionId !== token.sessionId ||
      current.executionId !== token.executionId ||
      current.generation !== token.generation
    ) {
      return { stale: true };
    }
    const transition = this.options.eventStore.transitionExecution(token, 'TERMINAL', reason);
    if (!this.options.registry.resolveRuntimeLease(lease)) return { stale: true };
    this.broadcastTransition(lease, transition);
    // A provider-specific replacement may still be retained behind an older
    // stream turn. Any exact terminal outcome releases that bounded input.
    if (transition.applied) this.options.registry.releaseReplacementInputBarrier(lease, token);
    const cleared = this.options.registry.clearCurrentExecution(lease, token);
    if (!cleared) return { transition };
    const nextLease = this.options.registry.beginPendingActivationForLease(lease);
    const next = nextLease ? await this.activateClaimedLease(nextLease) : undefined;
    return { transition, ...(next ? { next } : {}) };
  }

  /**
   * Replace the exact current generation. The EventStore transaction owns the
   * durable receipt; this method only owns the matching runtime lease and
   * provider dispatch. A duplicate never invokes dispatch again.
   */
  async replaceExecution(
    lease: RuntimeSessionLease,
    prepared: PreparedReplacementInput,
  ): Promise<ReplaceExecutionResult> {
    const prior = this.options.eventStore.getReplacementAdmission(
      lease.sessionId,
      prepared.clientMsgId,
    );
    // A durable receipt takes precedence over mutable runtime state. In
    // particular, retrying replacement A after B became current must return A
    // without claiming activation or touching a provider.
    if (prior) {
      try {
        const admission = this.options.eventStore.admitReplacement({
          expectedOldToken: prior.expectedOldToken,
          executionId: prior.token.executionId,
          clientMsgId: prepared.clientMsgId,
          requestFingerprint: prepared.requestFingerprint,
          userMessage: prepared.userMessage,
        });
        return { token: admission.token, admission };
      } catch (error) {
        return { error };
      }
    }
    if (!this.options.registry.claimReplacementExecution(lease, prepared.expectedToken)) {
      const resolved = this.options.registry.resolveRuntimeLease(lease);
      return resolved ? { busy: true } : { stale: true };
    }
    let ownerReservation: unknown;
    try {
      if (
        !Number.isSafeInteger(prepared.retainedBytes) ||
        prepared.retainedBytes < 0 ||
        prepared.retainedBytes > MAX_PENDING_EXECUTION_RETAINED_BYTES
      ) {
        return { error: new PendingExecutionOverflowError(lease.runtimeLeaseId) };
      }
      // No durable replacement row may be committed until the requester has
      // fenced competing owner transitions. A historical receipt bypassed
      // this above, so it remains side-effect free.
      if (prepared.reserveOwner) {
        ownerReservation = prepared.reserveOwner();
        if (!ownerReservation) return { busy: true };
      }
      const admission: ReplacementAdmissionResult = this.options.eventStore.admitReplacement({
        expectedOldToken: prepared.expectedToken,
        executionId: prepared.executionId,
        clientMsgId: prepared.clientMsgId,
        requestFingerprint: prepared.requestFingerprint,
        userMessage: prepared.userMessage,
        selectedModel: prepared.selectedModel,
        reasoningEffort: prepared.reasoningEffort,
      });
      if (!this.options.registry.resolveRuntimeLease(lease)) return { stale: true };
      if (!admission.duplicate) {
        if (
          !this.options.registry.replaceCurrentExecution(
            lease,
            prepared.expectedToken,
            admission.token,
          )
        )
          return { stale: true };
        if (ownerReservation && !prepared.commitOwner?.(ownerReservation)) {
          // The receipt is durable, so it must be returned as accepted even
          // though the provider cannot be routed. Terminalize only this new
          // token; exact retry will replay its receipt without side effects.
          const terminal = this.options.eventStore.transitionExecution(
            admission.token,
            'TERMINAL',
            'failed',
          );
          if (terminal.applied) {
            this.options.registry.releaseReplacementInputBarrier(lease, admission.token);
            this.options.registry.clearCurrentExecution(lease, admission.token);
          }
          return { token: admission.token, admission, stale: true, notDispatched: true };
        }
        // The durable causal boundary is visible before anything that can
        // yield to a provider (or any other external participant).  A
        // reconnect can therefore replay exactly these rows even if a stop
        // wins during the subsequent provider preparation.
        this.broadcastReplacementRows(lease, admission.rows);
        try {
          prepared.onAdmitted?.(admission.token);
        } catch {
          // Admission notifications are strictly best-effort.  The durable
          // receipt cannot be retroactively rejected by a live observer.
        }
        const dispatchAllowed = prepared.beforeDispatch
          ? await prepared.beforeDispatch(admission.token)
          : true;
        if (!dispatchAllowed) {
          const terminal = this.options.eventStore.transitionExecution(
            admission.token,
            'TERMINAL',
            'failed',
          );
          if (terminal.applied) {
            this.broadcastTransition(lease, terminal);
            this.options.registry.clearCurrentExecution(lease, admission.token);
          }
          return { token: admission.token, admission, stale: true, notDispatched: true };
        }
        const afterPreparation = this.options.registry.resolveRuntimeLease(lease);
        const afterToken = afterPreparation?.session.currentExecution;
        if (
          !afterPreparation ||
          !afterToken ||
          afterToken.executionId !== admission.token.executionId ||
          afterToken.generation !== admission.token.generation
        ) {
          // A stop/replacement won while an awaited preflight settled.  The
          // admission remains accepted; its winning terminal operation owns
          // the only terminal row. Never write a contradictory failure.
          return { token: admission.token, admission, stale: true, notDispatched: true };
        }
        try {
          await prepared.dispatch(admission.token);
        } catch (error) {
          const resolved = this.options.registry.resolveRuntimeLease(lease);
          // Admission is already durable. A stop/replacement/removal that
          // wins while provider work unwinds must not turn its exact retry
          // into an unavailable receipt.
          if (!resolved) return { token: admission.token, admission, stale: true };
          const current = resolved.session.currentExecution;
          if (
            !current ||
            current.executionId !== admission.token.executionId ||
            current.generation !== admission.token.generation
          )
            return { token: admission.token, admission, stale: true };
          const terminal = this.options.eventStore.transitionExecution(
            admission.token,
            'TERMINAL',
            'failed',
          );
          this.broadcastTransition(lease, terminal);
          if (terminal.applied)
            this.options.registry.releaseReplacementInputBarrier(lease, admission.token);
          this.options.registry.clearCurrentExecution(lease, admission.token);
          return { token: admission.token, admission, error };
        }
      }
      return { token: admission.token, admission };
    } finally {
      if (ownerReservation) prepared.releaseOwner?.(ownerReservation);
      this.options.registry.completeReplacementExecution(lease);
    }
  }

  /** Stop only this lease's current execution and discard queued work. */
  async stopExecution(
    lease: RuntimeSessionLease,
    token: ExecutionToken,
  ): Promise<FinishExecutionResult & { failures?: ActivationFailure[] }> {
    const resolved = this.options.registry.resolveRuntimeLease(lease);
    const current = resolved?.session.currentExecution;
    if (
      !resolved ||
      !current ||
      current.executionId !== token.executionId ||
      current.generation !== token.generation ||
      token.sessionId !== lease.sessionId
    )
      return { stale: true };
    const transition = this.options.eventStore.transitionExecution(token, 'TERMINAL', 'stopped');
    // A stale/otherwise unapplied durable transition never owns cleanup of
    // the in-memory token. Keeping it current lets its actual owner report a
    // later provider result or failure instead of stranding a RUNNING row.
    if (!transition.applied)
      return { transition, ...(transition.status === 'stale' ? { stale: true as const } : {}) };
    if (!this.options.registry.resolveRuntimeLease(lease)) return { stale: true };
    this.broadcastTransition(lease, transition);
    this.options.registry.releaseReplacementInputBarrier(lease, token);
    if (!this.options.registry.clearCurrentExecution(lease, token)) return { transition };
    // Deliberately do not activate a successor while the user is stopping.
    if (!this.options.registry.resolveRuntimeLease(lease)) return { transition, stale: true };
    const failures = this.failPendingExecutions(resolved.clientId, 'Execution stopped by user');
    return { transition, failures };
  }

  failPendingExecutions(
    clientId: string,
    message = 'Execution cancelled before activation',
  ): ActivationFailure[] {
    return this.options.registry.drainPendingExecutions(clientId).map((pending) => {
      const error = new Error(message);
      pending.onRejected?.(error);
      return {
        executionId: pending.executionId,
        clientMsgId: pending.clientMsgId,
        requestFingerprint: pending.requestFingerprint,
        error,
      };
    });
  }

  private async activateClaimedLease(lease: RuntimeSessionLease): Promise<ActivationResult> {
    const failures: ActivationFailure[] = [];
    try {
      while (true) {
        const pending = this.options.registry.peekPendingExecution(lease);
        if (!pending) return { failures };
        let begin: BeginExecutionResult | ExecutionAdmissionResult;
        try {
          begin = pending.userMessage
            ? this.options.eventStore.admitExecution(
                lease.sessionId,
                pending.executionId,
                pending.clientMsgId,
                pending.requestFingerprint,
                pending.userMessage,
              )
            : this.options.eventStore.beginExecution(
                lease.sessionId,
                pending.executionId,
                pending.clientMsgId,
                pending.requestFingerprint,
              );
        } catch (error: unknown) {
          // This failed before a RUNNING token was committed. Discard exactly
          // this queue head so its receipt can settle and a later FIFO item is
          // not stranded behind a rolled-back admission.
          if (!this.options.registry.shiftPendingExecution(lease)) return { failures, stale: true };
          pending.onRejected?.(error);
          failures.push({
            executionId: pending.executionId,
            clientMsgId: pending.clientMsgId,
            requestFingerprint: pending.requestFingerprint,
            error,
          });
          continue;
        }
        if (!this.options.registry.resolveRuntimeLease(lease)) return { failures, stale: true };
        if (begin.duplicate) {
          if (!this.options.registry.shiftPendingExecution(lease)) return { failures, stale: true };
          continue;
        }
        if (!this.options.registry.setCurrentExecution(lease, begin.token))
          return { failures, stale: true };
        if (!this.options.registry.shiftPendingExecution(lease)) {
          this.options.registry.clearCurrentExecution(lease, begin.token);
          return { failures, stale: true };
        }
        if ('rows' in begin && Array.isArray(begin.rows))
          this.broadcastAdmissionRows(lease, begin.rows);
        else this.broadcastBegin(lease, begin);
        // Receipt acknowledgement is allowed once the exact durable token is
        // visible. Provider startup remains a separate, terminalizable phase.
        try {
          pending.onAdmitted?.(begin.token);
        } catch {
          // Durable admission is already visible; notifications cannot undo it.
        }
        try {
          await pending.dispatch(begin.token);
          if (!this.options.registry.resolveRuntimeLease(lease)) return { failures, stale: true };
          return { token: begin.token, begin, failures };
        } catch (error: unknown) {
          failures.push({
            token: begin.token,
            executionId: pending.executionId,
            clientMsgId: pending.clientMsgId,
            requestFingerprint: pending.requestFingerprint,
            error,
          });
          // This token has already crossed the durable RUNNING boundary and
          // notified its receipt owner. Do not reinterpret a provider/setup
          // failure as a queued-send rejection: terminalize this exact token.
          // A removed lease has no owner for this late provider completion.
          // Do not mutate the durable stream of a newly registered runtime
          // that happens to reuse the same client id/session id.
          if (!this.options.registry.resolveRuntimeLease(lease)) return { failures, stale: true };
          const terminal = this.options.eventStore.transitionExecution(
            begin.token,
            'TERMINAL',
            pending.isInitial ? 'startup_failed' : 'failed',
          );
          if (!this.options.registry.resolveRuntimeLease(lease)) return { failures, stale: true };
          this.broadcastTransition(lease, terminal);
          // A stale failure must stop, not steal/admit the next FIFO item.
          if (!this.options.registry.clearCurrentExecution(lease, begin.token))
            return { failures, stale: true };
        }
      }
    } finally {
      this.options.registry.completePendingActivation(lease);
    }
  }

  private broadcastBegin(lease: RuntimeSessionLease, result: BeginExecutionResult): void {
    if (!result.duplicate && result.seq !== undefined && result.event) {
      broadcastStoredExecutionEvent(
        lease,
        { seq: result.seq, event: result.event },
        this.options.registry,
        this.options.connections,
      );
    }
  }

  private broadcastAdmissionRows(lease: RuntimeSessionLease, rows: StoredEvent[]): void {
    for (const row of rows) {
      broadcastStoredEvent(
        lease,
        {
          seq: row.seq,
          event: { ...row.payload, sessionId: row.sessionId } as {
            type: string;
            sessionId: string;
          },
        },
        this.options.registry,
        this.options.connections,
      );
    }
  }

  private broadcastTransition(lease: RuntimeSessionLease, result: ExecutionTransitionResult): void {
    if (result.applied && result.seq !== undefined && result.event) {
      broadcastStoredExecutionEvent(
        lease,
        { seq: result.seq, event: result.event },
        this.options.registry,
        this.options.connections,
      );
    }
  }

  private broadcastReplacementRows(lease: RuntimeSessionLease, rows: StoredEvent[]): void {
    for (const row of rows) {
      const resolved = this.options.registry.resolveRuntimeLease(lease);
      if (!resolved) return;
      const data = { ...row.payload, seq: row.seq };
      const suspended = this.options.registry.isSuspended(resolved.clientId);
      const suspendedDriver = suspended
        ? new Set<SessionTransport>([resolved.session.transport])
        : undefined;
      const sent =
        this.options.connections?.broadcast(lease.sessionId, data, {
          excludeTransports: suspendedDriver,
        }) ?? new Set<SessionTransport>();
      for (const observer of resolved.session.observers) {
        if (suspended && observer === resolved.session.transport) continue;
        if (sendOnce(observer, data, sent))
          this.options.connections?.recordFallbackDelivery(lease.sessionId, observer, row.seq);
      }
      if (!suspended && sent.size === 0) {
        if (sendOnce(resolved.session.transport, data, sent))
          this.options.connections?.recordFallbackDelivery(
            lease.sessionId,
            resolved.session.transport,
            row.seq,
          );
      }
    }
  }
}
