import { useEffect, useState } from 'react';
import type { ContextCompaction } from '@mitzo/protocol';
import { readApiJson } from '../lib/api-json-read';

/** Refresh on reported lifecycle/turn changes, never on streamed words or a polling timer. */
export function useCompactionHistory(sessionId: string | null | undefined, refreshKey: string) {
  const [view, setView] = useState<{
    sessionId: string;
    records: ContextCompaction[];
    truncated: boolean;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    void readApiJson<{ records: ContextCompaction[]; truncated: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/compactions`,
      controller.signal,
    )
      .then((value) => {
        if (
          !Array.isArray(value.records) ||
          !value.records.every(
            (record) =>
              typeof record.id === 'string' &&
              Number.isSafeInteger(record.seq) &&
              ['compacting', 'completed', 'failed'].includes(record.phase) &&
              Number.isFinite(record.observedAt) &&
              (record.afterMessageId === null || typeof record.afterMessageId === 'string') &&
              [record.turnIndex, record.beforeTokens, record.afterTokens].every(
                (value) => value === null || (Number.isSafeInteger(value) && value >= 0),
              ) &&
              (record.summary === null || typeof record.summary === 'string') &&
              (record.condensedRange === null ||
                (typeof record.condensedRange?.firstMessageId === 'string' &&
                  typeof record.condensedRange?.lastMessageId === 'string')) &&
              Array.isArray(record.retainedProviderMessageIds) &&
              record.retainedProviderMessageIds.every((id) => typeof id === 'string'),
          )
        )
          throw Error('Invalid compaction receipt');
        if (!controller.signal.aborted)
          setView({ sessionId, records: value.records, truncated: value.truncated === true });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setView((previous) => ({
            sessionId,
            records: previous?.sessionId === sessionId ? previous.records : [],
            truncated: previous?.truncated ?? false,
            error: 'Compaction history could not be checked.',
          }));
      });
    return () => controller.abort();
  }, [sessionId, refreshKey]);
  return view && view.sessionId === sessionId
    ? view
    : { records: [], truncated: false, error: undefined };
}
