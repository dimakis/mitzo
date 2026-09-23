import { createHash } from 'node:crypto';
import {
  DeliberationOrchestrator,
  DEFAULT_DELIBERATION_CONFIG,
  type DeliberationConfig,
  type DeliberationResult,
  type ReasoningEventHandler,
  type ModelProvider,
} from '@mitzo/harness';
import type { ExecutionToken } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import { ExecutionAdmissionError } from '@mitzo/protocol/event-store';
import { deliberateRouteRevision } from './deliberate-route.js';

export interface DeliberationRequest {
  sessionId: string;
  clientMsgId: string;
  task: string;
  selection?: Record<string, unknown>;
  confirmAmbiguous?: boolean;
}
export type DeliberationOutcome =
  | { status: 'completed'; result?: DeliberationResult }
  | { status: 'running' | 'failed' | 'ambiguous' | 'cancelled' };

const active = new WeakMap<
  EventStore,
  Map<string, { token: ExecutionToken; abort: AbortController }>
>();

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Stable for sessionless requests across transports and reconnects. */
export function deliberateSessionId(clientMsgId: string): string {
  return `deliberate-${hash(clientMsgId)}`;
}

function outcome(store: EventStore, token: ExecutionToken): DeliberationOutcome {
  const attempts = store.getProviderAttempts(token);
  if (
    attempts.some((a) => a.terminalReason === 'ambiguous' || a.terminalReason === 'server_restart')
  ) {
    return { status: 'ambiguous' };
  }
  const session = store.getSession(token.sessionId);
  if (session?.executionId === token.executionId) {
    if (session.executionPhase !== 'TERMINAL') return { status: 'running' };
    if (session.executionTerminalReason === 'completed') return { status: 'completed' };
    if (session.executionTerminalReason === 'stopped') return { status: 'cancelled' };
    // A restart between completed child calls is still an unfinished deliberation.
    if (session.executionTerminalReason === 'server_restart' && attempts.length)
      return { status: 'ambiguous' };
    return { status: 'failed' };
  }
  // Old receipts remain deduplicated after later generations. No replay of work.
  return { status: 'completed' };
}

export function cancelDeliberation(store: EventStore, sessionId: string): boolean {
  const run = active.get(store)?.get(sessionId);
  if (!run) return false;
  store.transitionExecution(run.token, 'STOPPING');
  run.abort.abort();
  for (const attempt of store.getProviderAttempts(run.token)) {
    if (attempt.phase === 'RUNNING')
      store.transitionProviderAttempt(attempt.token, 'TERMINAL', 'ambiguous');
  }
  store.transitionExecution(run.token, 'TERMINAL', 'stopped');
  active.get(store)?.delete(sessionId);
  return true;
}

/** Synchronous durable admission, followed by asynchronous provider work. */
export function startDeliberation(options: {
  store: EventStore;
  request: DeliberationRequest;
  config?: Omit<DeliberationConfig, 'onEvent'>;
  routeRevision?: () => string;
  createProvider?: (model: string) => ModelProvider;
  onEvent?: ReasoningEventHandler;
}): { token: ExecutionToken; duplicate: boolean; completion: Promise<DeliberationOutcome> } {
  const { store, request } = options;
  if (!request.task.trim()) throw new Error('Deliberation requires a task');
  const config = structuredClone(options.config ?? DEFAULT_DELIBERATION_CONFIG);
  const routeRevision = options.routeRevision ?? deliberateRouteRevision;
  const route = routeRevision();
  const fingerprint = `deliberate-v1:${hash({
    command: 'deliberate',
    task: request.task.trim(),
    config,
    selection: request.selection ?? null,
    route,
    orchestrationRevision: 1,
    trustDomainRevision: 'host-direct-v1',
  })}`;
  const prior = store.getExecutionAdmission(request.sessionId, request.clientMsgId);
  if (prior) {
    if (prior.requestFingerprint !== fingerprint) {
      throw new ExecutionAdmissionError(
        'fingerprint_conflict',
        'Command ID already admitted for a different request',
      );
    }
    return {
      token: prior.token,
      duplicate: true,
      completion: Promise.resolve(outcome(store, prior.token)),
    };
  }
  const previous = store.getSession(request.sessionId);
  if (
    previous?.executionId &&
    previous.executionGeneration &&
    outcome(store, {
      sessionId: request.sessionId,
      executionId: previous.executionId,
      generation: previous.executionGeneration,
    }).status === 'ambiguous' &&
    !request.confirmAmbiguous
  ) {
    throw new Error(
      'Explicit confirmation required: previous deliberation may have performed provider work',
    );
  }
  if (!previous) store.upsertSession({ sessionId: request.sessionId });
  const admitted = store.beginExecution(
    request.sessionId,
    undefined,
    request.clientMsgId,
    fingerprint,
  );
  if (admitted.duplicate)
    return { ...admitted, completion: Promise.resolve(outcome(store, admitted.token)) };
  const token = admitted.token;
  const abort = new AbortController();
  let runs = active.get(store);
  if (!runs) {
    runs = new Map();
    active.set(store, runs);
  }
  runs.set(request.sessionId, { token, abort });

  const completion = (async (): Promise<DeliberationOutcome> => {
    try {
      const orchestrator = new DeliberationOrchestrator(
        { ...config, onEvent: options.onEvent },
        {
          createProvider: options.createProvider,
          signal: abort.signal,
          call: async (phase, invoke) => {
            abort.signal.throwIfAborted();
            if (routeRevision() !== route) throw new Error('Provider route changed');
            const attempt = store.beginProviderAttempt(
              token,
              `deliberate:${token.executionId}:${phase}`,
            );
            if (attempt.duplicate) throw new Error('Provider attempt already admitted');
            try {
              const result = await invoke();
              abort.signal.throwIfAborted();
              const terminal = store.transitionProviderAttempt(
                attempt.token,
                'TERMINAL',
                'completed',
              );
              if (!terminal.applied) throw new Error('Provider attempt no longer active');
              return result;
            } catch {
              store.transitionProviderAttempt(attempt.token, 'TERMINAL', 'ambiguous');
              throw new Error('Deliberation provider outcome is uncertain');
            }
          },
        },
      );
      const result = await orchestrator.run(request.task.trim(), '');
      abort.signal.throwIfAborted();
      const terminal = store.transitionExecution(token, 'TERMINAL', 'completed');
      if (!terminal.applied) throw new Error('Deliberation no longer active');
      return { status: 'completed', result };
    } catch {
      if (abort.signal.aborted) return { status: 'cancelled' };
      const attempts = store.getProviderAttempts(token);
      // Store errors propagate if durable terminalization is unavailable; recovery
      // still owns the persisted RUNNING receipt and exact retries never dispatch.
      store.transitionExecution(token, 'TERMINAL', attempts.length ? 'failed' : 'startup_failed');
      return outcome(store, token);
    } finally {
      if (runs.get(request.sessionId)?.token === token) runs.delete(request.sessionId);
    }
  })();
  return { token, duplicate: false, completion };
}
