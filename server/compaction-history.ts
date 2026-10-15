import type { ContextCompaction, StoredEvent } from '@mitzo/protocol';
const count = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
export function projectCompactions(events: StoredEvent[]): ContextCompaction[] {
  const records = new Map<string, ContextCompaction>();
  for (const event of events) {
    const value = event.payload;
    if (
      typeof value.id !== 'string' ||
      !['compacting', 'completed', 'failed'].includes(String(value.phase))
    )
      continue;
    const previous = records.get(value.id);
    records.set(value.id, {
      id: value.id,
      seq: previous?.seq ?? event.seq,
      observedAt: event.createdAt,
      phase: value.phase as ContextCompaction['phase'],
      afterMessageId:
        previous?.afterMessageId ??
        (typeof value.afterMessageId === 'string' ? value.afterMessageId : null),
      turnIndex: previous?.turnIndex ?? count(value.turnIndex),
      beforeTokens: count(value.beforeTokens) ?? previous?.beforeTokens ?? null,
      afterTokens: count(value.afterTokens) ?? previous?.afterTokens ?? null,
      condensedRange: null,
      summary: typeof value.summary === 'string' ? value.summary : (previous?.summary ?? null),
      retainedProviderMessageIds: Array.isArray(value.retainedProviderMessageIds)
        ? value.retainedProviderMessageIds.filter((id): id is string => typeof id === 'string')
        : (previous?.retainedProviderMessageIds ?? []),
    });
  }
  return [...records.values()].sort((a, b) => a.seq - b.seq);
}
