import { ModelTokenLimitsSchema } from '@mitzo/protocol';
import type { Session, SessionMeta } from '@mitzo/protocol';
import type { EventStore } from '@mitzo/protocol/event-store';
import { createLogger } from './logger.js';
import { sessionMetadataDiagnostic } from './session-metadata-error.js';

const log = createLogger('session-model');
type ModelSelection = { model?: string };

/** Absent receipts retain legacy metadata; unreadable receipts make the model unknown. */
export function readSessionModelSelection(
  store: Pick<EventStore, 'getLatestOrdinaryCommandAdmission'>,
  sessionId: string,
): ModelSelection | null | undefined {
  try {
    return store.getLatestOrdinaryCommandAdmission?.(sessionId)?.selection;
  } catch (error) {
    log.warn('Session model selection unavailable', {
      code: 'session_model_selection_unavailable',
      stage: 'model_selection',
      sessionId,
      ...sessionMetadataDiagnostic(error),
    });
    return null;
  }
}

export function sessionModelIdentity(
  meta: Partial<SessionMeta>,
  alias: (accountId: string, fallback: string) => string = (_id, fallback) => fallback,
  selection?: ModelSelection | null,
): Pick<Session, 'model' | 'accountLabel' | 'modelUnavailable' | 'modelObservedAt'> {
  const binding = meta.accountBinding;
  return {
    modelObservedAt: Date.now(),
    ...(selection === null ? { modelUnavailable: true } : {}),
    model:
      selection === null
        ? undefined
        : (selection?.model ??
          meta.selectedModel ??
          (binding?.provider !== 'unavailable' ? binding?.model : undefined)),
    accountLabel: binding ? alias(binding.accountId, binding.accountLabel) : undefined,
  };
}

/** Read-only list projection. Cumulative usage never establishes context occupancy. */
export function sessionListMetadata(
  meta: Partial<SessionMeta>,
  event: { payload: Record<string, unknown>; createdAt: number; seatId?: string } | null,
  alias?: (accountId: string, fallback: string) => string,
  selection?: ModelSelection | null,
): Pick<
  Session,
  | 'telosTaskId'
  | 'cwd'
  | 'contextUsage'
  | 'model'
  | 'accountLabel'
  | 'modelUnavailable'
  | 'modelObservedAt'
> {
  const context = event?.payload.agentContext;
  const limits = ModelTokenLimitsSchema.safeParse(event?.payload.tokenLimits);
  return {
    ...sessionModelIdentity(meta, alias, selection),
    telosTaskId: meta.telosTaskId ?? undefined,
    cwd: meta.cwd ?? undefined,
    contextUsage:
      event && !event.seatId && !meta.symposiumConfig
        ? {
            used:
              typeof context === 'number' && Number.isSafeInteger(context) && context > 0
                ? context
                : null,
            measuredAt: event.createdAt,
            limits: limits.success ? limits.data : null,
          }
        : undefined,
  };
}
