import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api-fetch';

type HistoryEvent = { sequence: number; action: string; detail: Record<string, unknown> };
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const refs = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((ref): ref is string => typeof ref === 'string') : [];

export function SymposiumReviewHistory({ url, version }: { url: string; version: number }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setEvents([]);
    void apiFetch(url, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !Array.isArray(data.history))
          throw new Error('Cannot load saved review decisions. Refresh to try again.');
        if (!controller.signal.aborted)
          setEvents([...data.history].sort((a, b) => a.sequence - b.sequence));
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : 'Cannot load review history');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, url, version]);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Review history</summary>
      {loading && <p>Loading saved decisions…</p>}
      {error && <p role="alert">{error}</p>}
      <ol>
        {events.map((event) => {
          const detail = object(event.detail);
          const evidence = object(detail.item);
          const evidenceRefs = [...refs(detail.evidenceRefs), ...refs(evidence.evidenceRefs)];
          return (
            <li key={event.sequence} data-testid="review-history-event">
              <strong>
                {event.sequence}. {event.action.replaceAll('_', ' ')}
              </strong>
              {typeof detail.actor === 'string' && <p>By {detail.actor}</p>}
              {typeof detail.reason === 'string' && <p>{detail.reason}</p>}
              {typeof detail.artifactRevision === 'string' && (
                <p>Artifact: {detail.artifactRevision}</p>
              )}
              {typeof evidence.criterion === 'string' && typeof evidence.verdict === 'string' && (
                <p>
                  {evidence.criterion}: {evidence.verdict}
                </p>
              )}
              {evidenceRefs.length > 0 && (
                <ul aria-label="Recorded evidence">
                  {evidenceRefs.map((ref, index) => (
                    <li key={`${index}:${ref}`}>{ref}</li>
                  ))}
                </ul>
              )}
              <details>
                <summary>Recorded details</summary>
                <pre>{JSON.stringify(detail, null, 2)}</pre>
              </details>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
