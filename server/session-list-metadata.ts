import { ModelTokenLimitsSchema } from '@mitzo/protocol';
import type { Session, SessionMeta } from '@mitzo/protocol';

/** Read-only list projection. Cumulative usage never establishes context occupancy. */
export function sessionListMetadata(
  meta: Partial<SessionMeta>,
  event: { payload: Record<string, unknown>; createdAt: number; seatId?: string } | null,
): Pick<Session, 'telosTaskId' | 'cwd' | 'contextUsage'> {
  const context = event?.payload.agentContext;
  const limits = ModelTokenLimitsSchema.safeParse(event?.payload.tokenLimits);
  return {
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
