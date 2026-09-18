import type { ConnectionRegistry, PendingExecutionInput, SessionRegistry } from '@mitzo/harness';
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
    super(`Pending execution queue is full for ${clientId}`);
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

export interface ActivationResult {
  token?: ExecutionToken;
  begin?: BeginExecutionResult;
  dispatchError?: unknown;
}

export interface FinishExecutionResult {
  transition: ExecutionTransitionResult;
  next?: ActivationResult;
}

export interface PendingExecutionFailure {
  executionId: string;
  clientMsgId: string;
  requestFingerprint: string;
  error: Error;
}

/**
 * Deliver an already-durable execution event. This intentionally never calls
 * EventStore.append(): seq and payload are the authoritative stored row.
 */
export function broadcastStoredExecutionEvent(
  clientId: string,
  stored: StoredExecutionEvent,
  registry: SessionRegistry,
  connections?: ConnectionRegistry,
): void {
  const data: Record<string, unknown> = { ...stored.event, seq: stored.seq };
  const sessionId = stored.event.sessionId;

  if (registry.isSuspended(clientId)) {
    registry.bufferEvent(clientId, data);
    if (connections?.hasOpenWatchers(sessionId)) connections.broadcast(sessionId, data);
    return;
  }

  if (connections?.hasOpenWatchers(sessionId)) {
    connections.broadcast(sessionId, data);
    return;
  }

  // A detached driver has no live delivery path. The durable row will replay
  // on reconnect; attempting to send through its stale transport risks a
  // duplicate without improving delivery.
  if (!registry.isAttached(clientId)) return;
  const session = registry.get(clientId);
  if (!session) return;

  if (session.transport.isOpen()) {
    try {
      session.transport.send(data);
    } catch {
      // The durable row remains available for reconnect/periodic replay.
    }
  }
  for (const observer of session.observers) {
    if (!observer.isOpen()) continue;
    try {
      observer.send(data);
    } catch {
      // One observer must not prevent delivery to the rest.
    }
  }
}

/**
 * Serializes execution admission for one managed runtime. Provider work is
 * deliberately opaque here; production start/send/query-loop wiring lands in
 * a later slice.
 */
export class ExecutionController {
  constructor(private readonly options: ExecutionControllerOptions) {}

  enqueueExecution(clientId: string, prepared: PendingExecutionInput): void {
    if (!this.options.registry.enqueuePendingExecution(clientId, prepared)) {
      throw new PendingExecutionOverflowError(clientId);
    }
  }

  async activateNextExecution(clientId: string): Promise<ActivationResult | undefined> {
    const session = this.options.registry.beginPendingActivation(clientId);
    if (!session) return undefined;
    if (!session.sessionId) {
      this.options.registry.completePendingActivation(clientId);
      return undefined;
    }

    let dispatchError: unknown;
    try {
      while (true) {
        const pending = this.options.registry.peekPendingExecution(clientId);
        if (!pending) return dispatchError === undefined ? undefined : { dispatchError };

        const begin = this.options.eventStore.beginExecution(
          session.sessionId,
          pending.executionId,
          pending.clientMsgId,
          pending.requestFingerprint,
        );
        if (begin.duplicate) {
          // The receipt was already admitted. Remove only this FIFO item and
          // never send provider work for it or allocate a new generation.
          this.options.registry.shiftPendingExecution(clientId);
          continue;
        }

        // Set first so synchronous dispatchers can observe their token before
        // the queue mutates or any provider callback is entered.
        if (!this.options.registry.setCurrentExecution(clientId, begin.token)) {
          throw new Error(`Execution controller lost ownership for ${clientId}`);
        }
        this.options.registry.shiftPendingExecution(clientId);
        this.broadcastBegin(clientId, begin);

        try {
          await pending.dispatch(begin.token);
          return {
            token: begin.token,
            begin,
            ...(dispatchError === undefined ? {} : { dispatchError }),
          };
        } catch (error: unknown) {
          dispatchError = error;
          const terminalReason: ExecutionTerminalReason = pending.isInitial
            ? 'startup_failed'
            : 'failed';
          const terminal = this.options.eventStore.transitionExecution(
            begin.token,
            'TERMINAL',
            terminalReason,
          );
          this.broadcastTransition(clientId, terminal);
          // A late failure for an old generation cannot clear a replacement.
          this.options.registry.clearCurrentExecution(clientId, begin.token);
          // Continue under the same activation lease to preserve FIFO order.
        }
      }
    } finally {
      this.options.registry.completePendingActivation(clientId);
    }
  }

  async finishExecution(
    clientId: string,
    token: ExecutionToken,
    reason: ExecutionTerminalReason,
  ): Promise<FinishExecutionResult> {
    const transition = this.options.eventStore.transitionExecution(token, 'TERMINAL', reason);
    this.broadcastTransition(clientId, transition);
    const cleared = this.options.registry.clearCurrentExecution(clientId, token);
    const next = cleared ? await this.activateNextExecution(clientId) : undefined;
    return { transition, ...(next ? { next } : {}) };
  }

  failPendingExecutions(
    clientId: string,
    message = 'Execution cancelled before activation',
  ): PendingExecutionFailure[] {
    return this.options.registry.drainPendingExecutions(clientId).map((pending) => ({
      executionId: pending.executionId,
      clientMsgId: pending.clientMsgId,
      requestFingerprint: pending.requestFingerprint,
      error: new Error(message),
    }));
  }

  private broadcastBegin(clientId: string, result: BeginExecutionResult): void {
    if (!result.duplicate && result.seq !== undefined && result.event) {
      broadcastStoredExecutionEvent(
        clientId,
        { seq: result.seq, event: result.event },
        this.options.registry,
        this.options.connections,
      );
    }
  }

  private broadcastTransition(clientId: string, result: ExecutionTransitionResult): void {
    if (result.applied && result.seq !== undefined && result.event) {
      broadcastStoredExecutionEvent(
        clientId,
        { seq: result.seq, event: result.event },
        this.options.registry,
        this.options.connections,
      );
    }
  }
}
