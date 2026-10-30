import { useEffect, useState } from 'react';
import type { ContextCompaction } from '@mitzo/protocol';
import { readApiJson } from '../lib/api-json-read';

const optionalTime = (value: unknown) =>
  value == null || (Number.isSafeInteger(value) && (value as number) >= 0);
const observationValid = (value: ContextCompaction['usageBefore']) =>
  value == null ||
  (Number.isSafeInteger(value.tokens) &&
    value.tokens >= 0 &&
    Number.isSafeInteger(value.observedAt) &&
    value.observedAt >= 0 &&
    (value.model === null || typeof value.model === 'string') &&
    optionalTime(value.contextCeiling));

/** Refresh on lifecycle changes and the first after-usage observation; never poll. */
export function useCompactionHistory(
  sessionId: string | null | undefined,
  refreshKey: string,
  latestContext?: number,
  latestTurnIndex?: number,
) {
  const [view, setView] = useState<{
    sessionId: string;
    records: ContextCompaction[];
    truncated: boolean;
    error?: string;
  } | null>(null);
  const latest = view?.sessionId === sessionId ? view.records.at(-1) : undefined;
  const awaitingUsage =
    latest?.phase === 'completed' &&
    latest.startedAt != null &&
    latest.endedAt != null &&
    latest.afterTokens === null &&
    !latest.usageAfter &&
    (latestTurnIndex === undefined || latestTurnIndex === latest.turnIndex);
  const usageKey = awaitingUsage ? latestContext : undefined;
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
              ['compacting', 'completed', 'failed', 'interrupted', 'unknown'].includes(
                record.phase,
              ) &&
              Number.isFinite(record.observedAt) &&
              optionalTime(record.startedAt) &&
              optionalTime(record.endedAt) &&
              observationValid(record.usageBefore) &&
              observationValid(record.usageAfter) &&
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
  }, [sessionId, refreshKey, usageKey]);
  return view && view.sessionId === sessionId
    ? view
    : { records: [], truncated: false, error: undefined };
}
