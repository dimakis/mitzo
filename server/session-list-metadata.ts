import { ModelTokenLimitsSchema } from '@mitzo/protocol';
import type { Session, SessionMeta } from '@mitzo/protocol';

export function sessionModelIdentity(
  meta: Partial<SessionMeta>,
  alias: (accountId: string, fallback: string) => string = (_id, fallback) => fallback,
): Pick<Session, 'model' | 'accountLabel'> {
  const binding = meta.accountBinding;
  return {
    model: meta.selectedModel ?? (binding?.provider !== 'unavailable' ? binding?.model : undefined),
    accountLabel: binding ? alias(binding.accountId, binding.accountLabel) : undefined,
  };
}

/** Read-only list projection. Cumulative usage never establishes context occupancy. */
export function sessionListMetadata(
  meta: Partial<SessionMeta>,
  event: { payload: Record<string, unknown>; createdAt: number; seatId?: string } | null,
  alias?: (accountId: string, fallback: string) => string,
): Pick<Session, 'telosTaskId' | 'cwd' | 'contextUsage' | 'model' | 'accountLabel'> {
  const context = event?.payload.agentContext;
  const limits = ModelTokenLimitsSchema.safeParse(event?.payload.tokenLimits);
  return {
    ...sessionModelIdentity(meta, alias),
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
