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
): void {
  if (sent.has(transport) || !transport.isOpen()) return;
  try {
    transport.send(data);
    sent.add(transport);
  } catch {
    // Durable replay remains the recovery path for a failed live transport.
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
  const sent = connections?.broadcast(lease.sessionId, data) ?? new Set<SessionTransport>();
  if (registry.isSuspended(resolved.clientId)) {
    registry.bufferEvent(resolved.clientId, data);
    return sent;
  }
  if (registry.isAttached(resolved.clientId)) sendOnce(resolved.session.transport, data, sent);
  for (const observer of resolved.session.observers) sendOnce(observer, data, sent);
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
    clientId: string,
    token: ExecutionToken,
    reason: ExecutionTerminalReason,
  ): Promise<FinishExecutionResult> {
    const lease = this.options.registry.getRuntimeLease(clientId);
    if (!lease || token.sessionId !== lease.sessionId) return { stale: true };
    const transition = this.options.eventStore.transitionExecution(token, 'TERMINAL', reason);
    if (!this.options.registry.resolveRuntimeLease(lease)) return { stale: true };
    this.broadcastTransition(lease, transition);
    const cleared = this.options.registry.clearCurrentExecution(lease, token);
    if (!cleared) return { transition };
    const current = this.options.registry.resolveRuntimeLease(lease);
    const next = current ? await this.activateNextExecution(current.clientId) : undefined;
    return { transition, ...(next ? { next } : {}) };
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
        try {
          await pending.dispatch(begin.token);
          if (!this.options.registry.resolveRuntimeLease(lease)) return { failures, stale: true };
          return { token: begin.token, begin, failures };
        } catch (error: unknown) {
          failures.push({
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
