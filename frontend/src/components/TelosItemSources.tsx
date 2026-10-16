import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TelosWorkApiClient } from '@mitzo/client';
import type { TelosWorkSourceSnapshot, TelosWorkSessionLink } from '@mitzo/protocol';
import type { TodoSource } from '../types/todo';
import { apiFetch } from '../lib/api-fetch';
import { sourceIcon } from '../lib/todo-utils';
import { UiIcon } from './UiIcon';
const api = new TelosWorkApiClient(apiFetch);

/** Original evidence is separate from output files and collaborator assignment.
 * Opening resolves retained proof; it never allocates a replacement session. */
export function TelosItemSources({
  itemId,
  legacySources,
  onOpenExternal,
}: {
  itemId: string;
  legacySources: TodoSource[];
  onOpenExternal: (url: string) => void;
}) {
  const navigate = useNavigate();
  const [result, setResult] = useState<{
    itemId: string;
    sources: TelosWorkSourceSnapshot[];
    origins: TelosWorkSessionLink[];
    error?: string;
  } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentItem = useRef(itemId);
  currentItem.current = itemId;
  const operation = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setOpening(null);
    void Promise.resolve()
      .then(() => api.read(itemId, controller.signal))
      .then(
        (work) => {
          if (!controller.signal.aborted)
            setResult({
              itemId,
              sources: work.sources,
              origins: (work.links ?? []).filter(
                (link) =>
                  link.role === 'origin' &&
                  !work.sources.some(
                    (source) =>
                      source.source?.namespace === link.conversation.namespace &&
                      source.source?.conversationId === link.conversation.conversationId,
                  ),
              ),
            });
        },
        () => {
          if (!controller.signal.aborted)
            setResult({
              itemId,
              sources: [],
              origins: [],
              error: 'Original conversations unavailable.',
            });
        },
      );
    return () => {
      controller.abort();
      operation.current?.abort();
    };
  }, [itemId]);
  const current = result?.itemId === itemId ? result : null;
  async function open(source: TelosWorkSourceSnapshot) {
    if (opening) return;
    const controller = new AbortController();
    operation.current = controller;
    setError(null);
    setOpening(source.snapshotId);
    try {
      const view = await api.readSource(itemId, source.snapshotId, controller.signal);
      if (controller.signal.aborted || currentItem.current !== itemId) return;
      if (!view.available)
        throw Error('Original conversation unavailable. Retained sources are preserved.');
      navigate(view.sourceHref);
    } catch {
      if (!controller.signal.aborted && currentItem.current === itemId)
        setError('Original conversation unavailable. Retained sources are preserved.');
    } finally {
      if (!controller.signal.aborted && currentItem.current === itemId) setOpening(null);
    }
  }
  if (
    current &&
    !current.error &&
    !current.sources.length &&
    !current.origins.length &&
    !legacySources.length
  )
    return null;
  return (
    <section className="todo-detail-sources" aria-label="Sources">
      <h2>Sources</h2>
      {!current && <p role="status">Loading original conversations…</p>}
      {current?.error && <p role="status">{current.error}</p>}
      {current?.sources.map((source) => (
        <div
          key={source.snapshotId}
          className="todo-detail-source-row todo-detail-source-row--no-link"
        >
          <UiIcon name="chats" size={16} />
          <div className="todo-detail-source-content">
            <div className="todo-detail-source-title">Originating conversation</div>
            <div className="todo-detail-source-author">
              {source.author ?? 'Author unknown'} ·{' '}
              {source.sourceCreatedAt ?? 'Source date unknown'}
            </div>
            <div className="todo-detail-source-snippet">
              {source.adoptedAt ? `Added ${source.adoptedAt}` : 'Added date unknown'}
            </div>
            {source.source?.namespace === 'mitzo' && source.selection.kind === 'selected' ? (
              <button
                type="button"
                className="output-action"
                disabled={opening !== null}
                onClick={() => void open(source)}
              >
                Open original chat
              </button>
            ) : (
              <span>Reviewed exchange unknown</span>
            )}
          </div>
        </div>
      ))}
      {current?.origins.map((origin) => (
        <div
          key={origin.linkId ?? origin.conversation.conversationId}
          className="todo-detail-source-row todo-detail-source-row--no-link"
        >
          <UiIcon name="chats" size={16} />
          <div className="todo-detail-source-content">
            <div className="todo-detail-source-title">Originating conversation</div>
            <div className="todo-detail-source-snippet">Reviewed exchange unknown</div>
            {origin.conversation.namespace === 'mitzo' ? (
              <button
                type="button"
                className="output-action"
                disabled={origin.availability !== 'available'}
                onClick={() =>
                  navigate('/chat/' + encodeURIComponent(origin.conversation.conversationId))
                }
              >
                Open original chat
              </button>
            ) : (
              origin.conversation.url && (
                <button
                  type="button"
                  className="output-action"
                  onClick={() => {
                    if ('url' in origin.conversation) onOpenExternal(origin.conversation.url);
                  }}
                >
                  Open original chat
                </button>
              )
            )}
          </div>
        </div>
      ))}
      {legacySources.map((source, i) => (
        <button
          type="button"
          key={i}
          className={`todo-detail-source-row todo-detail-link-row${source.url ? '' : ' todo-detail-source-row--no-link'}`}
          disabled={!source.url}
          onClick={() => source.url && onOpenExternal(source.url)}
        >
          <span className="todo-detail-source-badge">{sourceIcon(source.type)}</span>
          <span className="todo-detail-source-content">
            <span className="todo-detail-source-title">{source.title}</span>
            <span className="todo-detail-source-author">{source.author}</span>
            {source.snippet && <span className="todo-detail-source-snippet">{source.snippet}</span>}
          </span>
        </button>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
