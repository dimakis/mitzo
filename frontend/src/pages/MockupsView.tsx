import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';
import { MockupCollection } from '../components/MockupCollection';
import { UiIcon } from '../components/UiIcon';
import { useSessionList } from '../hooks/useSessionList';
import { useSessionSearch } from '../hooks/useSessionSearch';
import { collectMockups } from '../lib/mockup-catalog';
import { readApiJson } from '../lib/api-json-read';
import type { FinishedMessage } from '../types/chat';
import './MockupsView.css';

function SavedChatMockups({ sessionId }: { sessionId: string }) {
  const [messages, setMessages] = useState<FinishedMessage[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    void readApiJson<unknown>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      controller.signal,
    )
      .then((value) => {
        if (
          !Array.isArray(value) ||
          !value.every(
            (message) =>
              message &&
              typeof message.messageId === 'string' &&
              ['user', 'assistant'].includes(message.role) &&
              Array.isArray(message.blocks) &&
              message.blocks.every(
                (block: unknown) =>
                  block &&
                  typeof block === 'object' &&
                  'blockType' in block &&
                  typeof block.blockType === 'string' &&
                  (!('content' in block) || typeof block.content === 'string'),
              ),
          )
        )
          throw Error('Invalid chat history');
        if (!controller.signal.aborted) setMessages(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [sessionId, attempt]);
  const mockups = useMemo(() => collectMockups(messages ?? []), [messages]);
  if (error)
    return (
      <div role="alert">
        <p>Couldn’t load this chat’s mockups.</p>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          Retry history
        </button>
      </div>
    );
  if (messages === null) return <p role="status">Loading saved chat history…</p>;
  return <MockupCollection mockups={mockups} sessionId={sessionId} />;
}

function MockupChatPicker({
  query,
  onQuery,
  hrefFor,
}: {
  query: string;
  onQuery: (query: string) => void;
  hrefFor: (id: string, title: string) => string;
}) {
  const list = useSessionList();
  const search = useSessionSearch();
  const { query: currentQuery, setQuery: setSearchQuery } = search;
  useEffect(() => {
    if (query !== currentQuery) setSearchQuery(query);
  }, [query, currentQuery, setSearchQuery]);
  const items = search.active
    ? search.results.map((item) => ({ id: item.sessionId, summary: item.summary }))
    : list.sessions;
  const error = search.active ? search.error : list.error;
  const loading = search.active ? search.searching : list.loading;
  return (
    <>
      <label className="chat-resource-search">
        Find a chat
        <input type="search" value={query} onChange={(event) => onQuery(event.target.value)} />
      </label>
      {loading && <p role="status">Loading chats…</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button type="button" onClick={search.active ? search.retry : list.retry}>
            Retry chats
          </button>
        </div>
      )}
      {!loading && !error && !items.length && (
        <p>{search.active ? 'No matching chats.' : 'No saved chats yet.'}</p>
      )}
      <div className="access-row-group">
        {items.map((item) => (
          <Link
            className="more-link"
            key={item.id}
            to={hrefFor(item.id, item.summary || 'Untitled chat')}
          >
            <UiIcon name="chats" />
            <span>{item.summary || 'Untitled chat'}</span>
            <UiIcon name="forward" size={16} />
          </Link>
        ))}
      </div>
      {!search.active && list.hasMore && (
        <button type="button" disabled={list.loadingMore} onClick={list.loadMore}>
          {list.loadingMore ? 'Loading more chats…' : 'Load more chats'}
        </button>
      )}
    </>
  );
}

/** Saved-history navigation only; viewing a collection never attaches a provider. */
export function MockupsView() {
  const [params, setParams] = useSearchParams();
  const sessionId = params.get('sessionId');
  const picker = new URLSearchParams(params);
  picker.delete('sessionId');
  picker.delete('title');
  const pickerHref = `/mockups${picker.size ? `?${picker}` : ''}`;
  return (
    <main className="workspace-page mockups-page">
      <WorkspacePageHeading
        title="Mockups"
        description={
          sessionId
            ? params.get('title') || 'Saved chat mockups'
            : 'Choose a chat to browse its designs and revisions.'
        }
      />
      <div className="chat-resource-body">
        {sessionId ? (
          <>
            <Link className="workspace-text-link" to={pickerHref}>
              Choose another chat
            </Link>
            <SavedChatMockups key={sessionId} sessionId={sessionId} />
          </>
        ) : (
          <MockupChatPicker
            query={params.get('q') || ''}
            onQuery={(query) => setParams(query ? { q: query } : {}, { replace: true })}
            hrefFor={(id, title) => {
              const next = new URLSearchParams(params);
              next.set('sessionId', id);
              next.set('title', title);
              return `/mockups?${next}`;
            }}
          />
        )}
      </div>
    </main>
  );
}
