import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api-fetch';
import { stripFrontmatter, type InboxItem } from '../lib/inbox-utils';

export function ProposalDetail({
  item,
  onArchive,
  onDiscard,
  onReview,
}: {
  item: InboxItem;
  onArchive: (filename: string) => void;
  onDiscard: (filename: string) => void;
  onReview: (item: InboxItem, body: string) => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setContent(null);
    setError(false);
    apiFetch(`/api/inbox/${encodeURIComponent(item.filename)}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error('Could not load proposal');
        const data = await res.json();
        if (typeof data.content !== 'string') throw new Error('Missing proposal content');
        if (!controller.signal.aborted) setContent(data.content);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [item.filename, attempt]);
  return (
    <>
      <p className="workspace-muted">
        {item.agent}
        {item.timestamp && ` · ${new Date(item.timestamp).toLocaleDateString()}`}
      </p>
      <h2>{item.title}</h2>
      {error ? (
        <div role="alert">
          <p>Could not load this proposal.</p>
          <button onClick={() => setAttempt((n) => n + 1)}>Retry</button>
        </div>
      ) : content === null ? (
        <p role="status">Loading proposal…</p>
      ) : (
        <>
          <div className="collection-actions">
            <button className="collection-primary" onClick={() => onReview(item, content)}>
              Review in session
            </button>
            <button onClick={() => onArchive(item.filename)}>Archive</button>
            <button onClick={() => onDiscard(item.filename)}>Discard</button>
          </div>
          <p className="workspace-muted">
            Archive keeps the proposal for reference. Review in session opens a conversation about
            it.
          </p>
          <div className="proposal-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripFrontmatter(content)}</ReactMarkdown>
          </div>
        </>
      )}
    </>
  );
}
