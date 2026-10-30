import type { ContextCompaction, StoredEvent } from '@mitzo/protocol';
const count = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
type Usage = NonNullable<ContextCompaction['usageBefore']>;

function usageObservation(
  event: StoredEvent,
): { usage: Usage; fresh: boolean; turn: number | null } | null {
  const value = event.payload;
  const tokens = count(value.agentContext);
  if (tokens === null || tokens === 0) return null;
  const limits = value.tokenLimits as Record<string, unknown> | null | undefined;
  const checkedAt = count(limits?.checkedAt);
  // Runtime capacity is timestamped alongside fresh native usage. Lifecycle echoes
  // retain that timestamp; neither their arrival time nor a smaller number proves freshness.
  const fresh =
    limits?.source === 'runtime' &&
    limits.stale === false &&
    checkedAt !== null &&
    checkedAt <= event.createdAt;
  return {
    usage: {
      tokens,
      observedAt: fresh ? checkedAt : event.createdAt,
      model: typeof limits?.model === 'string' ? limits.model : null,
      contextCeiling: count(value.contextCeiling) || null,
    },
    fresh,
    turn: count(value.turnIndex),
  };
}

/** Lifecycle timestamps remain separate from nearby usage observations. */
export function projectCompactions(events: StoredEvent[]): ContextCompaction[] {
  const records = new Map<string, ContextCompaction>();
  const latest = new Map<string, ReturnType<typeof usageObservation>>();
  const awaitingUsage = new Map<string, ContextCompaction>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const value = event.payload;
    if (event.type === 'token_update') {
      const observation = usageObservation(event);
      if (!observation) continue;
      latest.set(event.sessionId, observation);
      const pending = awaitingUsage.get(event.sessionId);
      if (
        pending &&
        observation.fresh &&
        pending.endedAt != null &&
        observation.usage.observedAt > pending.endedAt &&
        pending.turnIndex !== null &&
        pending.turnIndex === observation.turn &&
        (!pending.usageBefore?.model || pending.usageBefore.model === observation.usage.model)
      ) {
        pending.usageAfter = observation.usage;
        awaitingUsage.delete(event.sessionId);
      }
      continue;
    }
    if (
      event.type !== 'context_compaction' ||
      typeof value.id !== 'string' ||
      !['compacting', 'completed', 'failed', 'interrupted', 'unknown'].includes(String(value.phase))
    )
      continue;
    const previous = records.get(value.id);
    const starting = value.phase === 'compacting';
    const observation = starting ? latest.get(event.sessionId) : null;
    const turnIndex = previous?.turnIndex ?? count(value.turnIndex);
    const record: ContextCompaction = {
      id: value.id,
      seq: previous?.seq ?? event.seq,
      observedAt: event.createdAt,
      startedAt: previous?.startedAt ?? (starting ? event.createdAt : null),
      endedAt: starting ? null : (previous?.endedAt ?? event.createdAt),
      phase: value.phase as ContextCompaction['phase'],
      afterMessageId:
        previous?.afterMessageId ??
        (typeof value.afterMessageId === 'string' ? value.afterMessageId : null),
      turnIndex,
      beforeTokens: count(value.beforeTokens) ?? previous?.beforeTokens ?? null,
      afterTokens: count(value.afterTokens) ?? previous?.afterTokens ?? null,
      usageBefore:
        previous?.usageBefore ??
        (observation && (turnIndex === null || observation.turn === turnIndex)
          ? observation.usage
          : null),
      usageAfter: previous?.usageAfter ?? null,
      condensedRange: null,
      summary: typeof value.summary === 'string' ? value.summary : (previous?.summary ?? null),
      retainedProviderMessageIds: Array.isArray(value.retainedProviderMessageIds)
        ? value.retainedProviderMessageIds.filter((id): id is string => typeof id === 'string')
        : (previous?.retainedProviderMessageIds ?? []),
    };
    records.set(value.id, record);
    awaitingUsage.delete(event.sessionId);
    if (record.phase === 'completed' && !record.usageAfter)
      awaitingUsage.set(event.sessionId, record);
  }
  return [...records.values()].sort((a, b) => a.seq - b.seq);
}

/** Two bounded metadata reads; never load a conversation's text or tool history. */
export function readCompactionHistory(
  store: { getEventsOfType(sessionId: string, type: string, limit: number): StoredEvent[] },
  sessionId: string,
) {
  const lifecycle = store.getEventsOfType(sessionId, 'context_compaction', 513);
  const usage = lifecycle.length ? store.getEventsOfType(sessionId, 'token_update', 1024) : [];
  return {
    records: projectCompactions([...lifecycle.slice(0, 512), ...usage]),
    truncated: lifecycle.length > 512,
  };
}
