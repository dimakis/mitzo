import type {
  ConnectionRegistry,
  PendingExecutionInput,
  RuntimeSessionLease,
  SessionRegistry,
  SessionTransport,
} from '@mitzo/harness';
import type {
  ExecutionTerminalReason,
  ExecutionToken,
  ExecutionStateChangedPayload,
} from '@mitzo/protocol';
import type { BeginExecutionResult, ExecutionTransitionResult } from '@mitzo/protocol/event-store';
import type { EventStore } from './event-store.js';

type ExecutionStore = Pick<EventStore, 'beginExecution' | 'transitionExecution'>;

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
export function broadcastStoredExecutionEvent(
  lease: RuntimeSessionLease,
  stored: StoredExecutionEvent,
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

/** Isolated per-runtime execution admission; production provider wiring comes later. */
export class ExecutionController {
  constructor(private readonly options: ExecutionControllerOptions) {}

  enqueueExecution(clientId: string, prepared: PendingExecutionInput): void {
    if (!this.options.registry.enqueuePendingExecution(clientId, prepared)) {
      throw new PendingExecutionOverflowError(clientId);
    }
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
    const cleared = this.options.registry.clearCurrentExecution(lease, token);
    if (!cleared) return { transition };
    const nextLease = this.options.registry.beginPendingActivationForLease(lease);
    const next = nextLease ? await this.activateClaimedLease(nextLease) : undefined;
    return { transition, ...(next ? { next } : {}) };
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
    return this.options.registry.drainPendingExecutions(clientId).map((pending) => ({
      executionId: pending.executionId,
      clientMsgId: pending.clientMsgId,
      requestFingerprint: pending.requestFingerprint,
      error: new Error(message),
    }));
  }

  private async activateClaimedLease(lease: RuntimeSessionLease): Promise<ActivationResult> {
    const failures: ActivationFailure[] = [];
    try {
      while (true) {
        const pending = this.options.registry.peekPendingExecution(lease);
        if (!pending) return { failures };
        const begin = this.options.eventStore.beginExecution(
          lease.sessionId,
          pending.executionId,
          pending.clientMsgId,
          pending.requestFingerprint,
        );
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
        this.broadcastBegin(lease, begin);
        // Receipt acknowledgement is allowed once the exact durable token is
        // visible. Provider startup remains a separate, terminalizable phase.
        pending.onAdmitted?.(begin.token);
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
}
