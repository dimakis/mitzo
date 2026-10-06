import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api-fetch';
import { SymposiumReviewPanel } from './SymposiumReviewPanel';
interface RequestRow {
  id: string;
  hash: string;
  kind: 'url' | 'publication';
  status: string;
  seatName: string;
  accountId: string;
  model: string;
  input: {
    url?: string;
    origin?: string;
    reason?: string;
    resolvedAddresses?: string[];
    access?: string;
    title?: string;
    body?: string;
    repositoryPath?: string;
    baseBranch?: string;
    draft?: boolean;
  };
}
export function SymposiumAccessRequests({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<{ sessionId: string; rows: RequestRow[] }>({
    sessionId,
    rows: [],
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [review, setReview] = useState<string | null>(null);
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/symposium/access-requests`;
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const response = await apiFetch(path);
        if (!response.ok) throw new Error('Seat access requests are unavailable');
        const rows = (await response.json()) as RequestRow[];
        if (!Array.isArray(rows)) throw new Error('Seat access response is invalid');
        if (alive) {
          setState({ sessionId, rows });
          setError('');
        }
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : 'Access requests unavailable');
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [path, sessionId]);
  const rows =
    state.sessionId === sessionId
      ? state.rows.filter((row) => ['pending', 'review_requested'].includes(row.status))
      : [];
  const decide = async (row: RequestRow, approved: boolean) => {
    setBusy(row.id);
    setError('');
    try {
      const response = await apiFetch(`${path}/${encodeURIComponent(row.id)}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash: row.hash, approved }),
      });
      if (!response.ok)
        throw new Error(
          'The request changed or its seat is no longer executing. Refresh and try again.',
        );
      setState((previous) =>
        previous.sessionId === sessionId
          ? { ...previous, rows: previous.rows.filter((item) => item.id !== row.id) }
          : previous,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Approval failed');
    } finally {
      setBusy(null);
    }
  };
  const dismiss = async (row: RequestRow) => {
    setBusy(row.id);
    setError('');
    try {
      const response = await apiFetch(`${path}/${encodeURIComponent(row.id)}/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash: row.hash }),
      });
      if (!response.ok) throw new Error('Publication request changed; refresh and try again.');
      setState((previous) =>
        previous.sessionId === sessionId
          ? { ...previous, rows: previous.rows.filter((item) => item.id !== row.id) }
          : previous,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Dismissal failed');
    } finally {
      setBusy(null);
    }
  };
  if (!rows.length && !error && review !== sessionId) return null;
  return (
    <aside aria-label="Seat access requests">
      {rows.map((row) => (
        <section key={row.id}>
          <strong>
            {row.seatName} requests{' '}
            {row.kind === 'url' ? 'website access' : 'artifact review and publication'}
          </strong>
          <p>
            {row.accountId} · {row.model}
          </p>
          {row.kind === 'url' ? (
            <>
              <p>{row.input.url}</p>
              <p>Origin: {row.input.origin}</p>
              <p>{row.input.resolvedAddresses?.join(', ')}</p>
              <p>{row.input.reason}</p>
              <p>{row.input.access}</p>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  void decide(row, true);
                }}
              >
                Allow website reads
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  void decide(row, false);
                }}
              >
                Deny
              </button>
            </>
          ) : (
            <>
              <p>{row.input.title}</p>
              <details>
                <summary>Requested publication</summary>
                <p>{row.input.repositoryPath}</p>
                <p>Base branch: {row.input.baseBranch}</p>
                <p>{row.input.body}</p>
                <p>{row.input.draft ? 'Draft pull request' : 'Ready for review pull request'}</p>
              </details>
              <p>Review and seal the artifact, then select and approve its publication.</p>
              <button type="button" onClick={() => setReview(sessionId)}>
                Open artifact review
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  void dismiss(row);
                }}
              >
                Dismiss request
              </button>
            </>
          )}
        </section>
      ))}
      {error && <p role="alert">{error}</p>}
      {review === sessionId && <SymposiumReviewPanel sessionId={sessionId} />}
    </aside>
  );
}
