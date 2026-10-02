import { createHash } from 'node:crypto';
import {
  FusionOrchestrator,
  DEFAULT_FUSION_CONFIG,
  type FusionConfig,
  type FusionResult,
  type ReasoningEventHandler,
  type ModelProvider,
} from '@mitzo/harness';
import type { ExecutionToken } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import { ExecutionAdmissionError } from '@mitzo/protocol/event-store';
import { deliberateRouteRevision as fusionRouteRevision } from './deliberate-route.js';

export interface FusionRequest {
  sessionId: string;
  clientMsgId: string;
  task: string;
  selection?: Record<string, unknown>;
  confirmAmbiguous?: boolean;
}
export type FusionOutcome =
  | { status: 'completed'; result?: FusionResult }
  | { status: 'running' | 'failed' | 'ambiguous' | 'cancelled' };

const active = new WeakMap<
  EventStore,
  Map<string, { token: ExecutionToken; abort: AbortController }>
>();

function hash(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    return item;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

/** Confirmation is explicit user intent, never inferred from an exact retry. */
export function parseFusionInput(args: string): {
  task: string;
  self: boolean;
  confirmAmbiguous: boolean;
} {
  let task = args.trim();
  let self = false;
  let confirmAmbiguous = false;
  while (true) {
    const match = /^(--self|--confirm-ambiguous)(?:\s+|$)/.exec(task);
    if (!match) break;
    if (match[1] === '--self') self = true;
    else confirmAmbiguous = true;
    task = task.slice(match[0].length).trim();
  }
  return { task, self, confirmAmbiguous };
}

/** Stable for sessionless requests across transports and reconnects. */
export function fusionSessionId(clientMsgId: string): string {
  return `fusion-${hash(clientMsgId)}`;
}

/** Sessionless fusion IDs are durable execution streams, not SDK chats. */
export function isFusionSessionId(sessionId: string): boolean {
  return sessionId.startsWith('fusion-');
}

function outcome(store: EventStore, token: ExecutionToken): FusionOutcome {
  const attempts = store.getProviderAttempts(token);
  if (
    attempts.some((a) => a.terminalReason === 'ambiguous' || a.terminalReason === 'server_restart')
  ) {
    return { status: 'ambiguous' };
  }
  const terminal = store.getExecutionTerminalReason(token);
  if (terminal === 'completed') return { status: 'completed' };
  if (terminal === 'stopped') return { status: 'cancelled' };
  if (terminal === 'server_restart' && attempts.length) return { status: 'ambiguous' };
  if (terminal) return { status: 'failed' };
  return { status: 'running' };
}

export function cancelFusion(store: EventStore, sessionId: string): boolean {
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
export function startFusion(options: {
  store: EventStore;
  request: FusionRequest;
  config?: Omit<FusionConfig, 'onEvent'>;
  routeRevision?: () => string;
  createProvider?: (model: string) => ModelProvider;
  onEvent?: ReasoningEventHandler;
  onAdmitted?: () => void;
}): { token: ExecutionToken; duplicate: boolean; completion: Promise<FusionOutcome> } {
  const { store, request } = options;
  if (!request.task.trim()) throw new Error('Fusion requires a task');
  const config = structuredClone(options.config ?? DEFAULT_FUSION_CONFIG);
  if (!config.panelModels.length) throw new Error('Fusion requires a panel');
  const routeRevision = options.routeRevision ?? fusionRouteRevision;
  const route = routeRevision();
  const fingerprint = `fusion-v1:${hash({
    command: 'fuse',
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
    options.onAdmitted?.();
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
      'Explicit confirmation required: previous fusion may have performed provider work',
    );
  }
  if (!previous) store.upsertSession({ sessionId: request.sessionId });
  const admitted = store.beginExecution(
    request.sessionId,
    undefined,
    request.clientMsgId,
    fingerprint,
  );
  if (admitted.duplicate) {
    options.onAdmitted?.();
    return { ...admitted, completion: Promise.resolve(outcome(store, admitted.token)) };
  }
  const token = admitted.token;
  try {
    options.onAdmitted?.();
  } catch (error) {
    store.transitionExecution(token, 'TERMINAL', 'startup_failed');
    throw error;
  }
  const abort = new AbortController();
  let runs = active.get(store);
  if (!runs) {
    runs = new Map();
    active.set(store, runs);
  }
  runs.set(request.sessionId, { token, abort });

  const completion = (async (): Promise<FusionOutcome> => {
    try {
      const orchestrator = new FusionOrchestrator(
        { ...config, onEvent: options.onEvent },
        {
          createProvider: options.createProvider,
          signal: abort.signal,
          call: async (phase, invoke) => {
            abort.signal.throwIfAborted();
            if (routeRevision() !== route) throw new Error('Provider route changed');
            const attempt = store.beginProviderAttempt(
              token,
              `fusion:${token.executionId}:${phase}`,
              { allowParallel: phase.startsWith('panel-') },
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
              throw new Error('Fusion provider outcome is uncertain');
            }
          },
        },
      );
      const result = await orchestrator.run(request.task.trim(), '');
      abort.signal.throwIfAborted();
      const terminal = store.transitionExecution(token, 'TERMINAL', 'completed');
      if (!terminal.applied) throw new Error('Fusion no longer active');
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
