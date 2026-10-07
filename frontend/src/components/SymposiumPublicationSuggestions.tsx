import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api-fetch';
export interface PublicationSuggestion {
  id: string;
  hash: string;
  status: string;
  seatName: string;
  accountId: string;
  model: string;
  input: {
    repositoryPath?: string;
    baseBranch?: string;
    title?: string;
    body?: string;
    draft?: boolean;
  };
}
function isSuggestion(value: unknown): value is PublicationSuggestion {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  const input = row.input as Record<string, unknown> | undefined;
  return (
    row.kind === 'publication' &&
    ['review_requested', 'review_handed_off'].includes(String(row.status)) &&
    typeof row.id === 'string' &&
    typeof row.hash === 'string' &&
    Boolean(input) &&
    ['repositoryPath', 'baseBranch', 'title', 'body'].every(
      (key) => typeof input?.[key] === 'string',
    ) &&
    typeof input?.draft === 'boolean'
  );
}
/** Suggestions remain reference data; artifact sealing and publication approval supply authority. */
export function SymposiumPublicationSuggestions({
  sessionId,
  initialSuggestion,
}: {
  sessionId: string;
  initialSuggestion?: PublicationSuggestion;
}) {
  const [state, setState] = useState({
    sessionId,
    rows: initialSuggestion ? [initialSuggestion] : [],
  });
  useEffect(() => {
    const controller = new AbortController();
    setState({ sessionId, rows: initialSuggestion ? [initialSuggestion] : [] });
    const refresh = async () => {
      try {
        const response = await apiFetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/symposium/access-requests`,
          { signal: controller.signal },
        );
        if (!response.ok) return;
        const data: unknown = await response.json();
        if (!controller.signal.aborted && Array.isArray(data))
          setState({ sessionId, rows: data.filter(isSuggestion) });
      } catch {
        /* A snapshot is reference data only; failed refresh grants no authority. */
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 1500);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [sessionId, initialSuggestion]);
  const rows = state.sessionId === sessionId ? state.rows : [];
  if (!rows.length) return null;
  return (
    <aside aria-label="Publication suggestions">
      <p>
        Seat suggestions for reference. Select the reviewed artifact and approve its exact
        publication separately.
      </p>
      {rows.map((row) => (
        <details key={row.id} open>
          <summary>{row.input.title}</summary>
          <p>
            {row.seatName} · {row.accountId} · {row.model}
          </p>
          <p>{row.input.repositoryPath}</p>
          <p>Base branch: {row.input.baseBranch}</p>
          <p>{row.input.body}</p>
          <p>{row.input.draft ? 'Draft pull request' : 'Ready for review pull request'}</p>
        </details>
      ))}
    </aside>
  );
}
