import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SessionLaunchRecord } from '@mitzo/protocol';
import type { SessionLinksData } from '../hooks/useSessionLaunch';
import { useSessionSearch } from '../hooks/useSessionSearch';
import { apiFetch } from '../lib/api-fetch';
import { loadSessionLaunchDefaults, sessionLaunchRuntime } from '../lib/session-launch-defaults';
import { createChatRuntimeSelection } from '../lib/chat-runtime-selection';
import { createBrowserId } from '../lib/browser-crypto';
import { LaunchReview, SessionLaunchCards, SessionLaunchOrigin } from './SessionLaunchCards';
import { UiIcon } from './UiIcon';

/** Navigation and launch review share their read owner; neither grants tool access. */
export function SessionChatLinks({
  sessionId,
  data,
  disabled,
}: {
  sessionId?: string;
  data?: SessionLinksData;
  disabled: boolean;
}) {
  const search = useSessionSearch();
  const [all, setAll] = useState(false);
  const [draft, setDraft] = useState<SessionLaunchRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unlink, setUnlink] = useState<string | null>(null);
  const live = useRef(true);
  const defaultsRead = useRef<AbortController | null>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      defaultsRead.current?.abort();
    };
  }, []);
  async function newChat() {
    if (disabled || busy || !sessionId || !data) return;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    defaultsRead.current = controller;
    try {
      const defaults = await loadSessionLaunchDefaults(controller.signal);
      if (!live.current || controller.signal.aborted) return;
      const runtime = sessionLaunchRuntime(createChatRuntimeSelection());
      setDraft({
        proposalId: createBrowserId(),
        requestId: createBrowserId(),
        sourceSessionId: sessionId,
        title: '',
        prompt: '',
        configuration: defaults.configuration ?? {
          version: 1,
          runtime,
          mode: 'ask',
          isolation: true,
          repositoryWorkspaceId: null,
          contextBlocks: [],
          extraTools: [],
        },
        revision: 1,
        state: 'pending',
        childSessionId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    } catch (cause) {
      if (!controller.signal.aborted) {
        console.warn('Session defaults could not be loaded', {
          code: 'session_link_defaults_failed',
          stage: 'read',
          sessionId,
          cause: cause instanceof Error ? cause.name : 'UnknownError',
        });
        if (live.current) setError('Could not load session defaults. Try New chat again.');
      }
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function changeLink(target: string, remove = false) {
    if (disabled || busy || !sessionId || !data) return;
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch(
        `/api/session-launch/links/${encodeURIComponent(sessionId)}/${encodeURIComponent(target)}`,
        {
          method: remove ? 'DELETE' : 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
      );
      if (!response.ok) throw Error(`session_link_http_${response.status}`);
      if (live.current) {
        setUnlink(null);
        search.clear();
        data?.refresh();
      }
    } catch (cause) {
      console.warn('Chat link could not be confirmed', {
        code: 'session_link_change_unconfirmed',
        stage: remove ? 'unlink' : 'link',
        sessionId,
        cause: cause instanceof Error ? cause.name : 'UnknownError',
      });
      if (live.current)
        setError('Could not confirm the link change. Refresh links to check its current state.');
    } finally {
      if (live.current) setBusy(false);
    }
  }
  const requests = data?.requests ?? [];
  const links = data?.links ?? [];
  const observed = draft && requests.find((request) => request.requestId === draft.requestId);
  if (!data)
    return (
      <section className="session-links">
        <h3>Linked chats</h3>
        <p className="workspace-muted">Linked chats are unavailable for this conversation.</p>
      </section>
    );
  return (
    <section className="session-links">
      <div className="session-links-heading">
        <h3>Linked chats</h3>
        <button
          type="button"
          className="session-links-new"
          disabled={disabled || busy || !sessionId}
          onClick={() => void newChat()}
        >
          <UiIcon name="plus" size={16} />
          {busy ? 'Checking…' : 'New chat'}
        </button>
      </div>
      <SessionLaunchOrigin origin={data?.origin} />
      {(error || data?.error) && <p role="alert">{error || data?.error}</p>}
      {data && (
        <SessionLaunchCards
          requests={all ? requests : requests.slice(-2)}
          onUpdate={data.refresh}
          disabled={disabled}
        />
      )}
      {(all ? links : links.slice(0, 2)).map((link) => (
        <div className="session-link-row" key={link.sessionId}>
          {link.available ? (
            <Link to={`/chat/${encodeURIComponent(link.sessionId)}`}>
              {link.title || 'Chat'}
              <UiIcon name="arrowUpRight" size={16} />
            </Link>
          ) : (
            <span>{link.title || 'Chat'} · Unavailable</span>
          )}
          <button
            type="button"
            className="header-action"
            disabled={disabled || busy || !sessionId}
            aria-label={`Unlink ${link.title || 'chat'}`}
            onClick={() => setUnlink(link.sessionId)}
          >
            <UiIcon name="close" size={16} />
          </button>
          {unlink === link.sessionId && (
            <div>
              <p>Remove this link? Both chats and their permissions stay intact.</p>
              <button
                type="button"
                className="session-links-new"
                disabled={busy || disabled}
                onClick={() => void changeLink(link.sessionId, true)}
              >
                Unlink chat
              </button>
              <button
                type="button"
                className="session-links-new"
                disabled={busy}
                onClick={() => setUnlink(null)}
              >
                Keep link
              </button>
            </div>
          )}
        </div>
      ))}
      {!requests.length && !links.length && !data?.origin && (
        <p className="workspace-muted">No linked chats yet.</p>
      )}
      {(requests.length > 2 || links.length > 2) && (
        <button
          type="button"
          className="session-links-new"
          onClick={() => setAll((value) => !value)}
        >
          {all ? 'Show recent chats' : `All linked chats (${requests.length + links.length})`}
          <UiIcon name={all ? 'up' : 'forward'} size={16} />
        </button>
      )}
      <details className="session-link-picker">
        <summary>Link existing chat</summary>
        <label>
          Search chats
          <input
            value={search.query}
            onChange={(event) => search.setQuery(event.target.value)}
            disabled={disabled || busy || !sessionId}
          />
        </label>
        {search.searching && <p role="status">Searching…</p>}
        {search.error && <p role="alert">{search.error}</p>}
        {search.results
          .filter(
            (result) =>
              result.sessionId !== sessionId &&
              !links.some((link) => link.sessionId === result.sessionId) &&
              !requests.some((request) => request.childSessionId === result.sessionId) &&
              data?.origin?.sessionId !== result.sessionId,
          )
          .map((result) => (
            <button
              key={result.sessionId}
              type="button"
              className="session-links-new"
              disabled={busy || disabled || !sessionId}
              onClick={() => void changeLink(result.sessionId)}
            >
              {result.summary || 'Untitled chat'}
              <UiIcon name="plus" size={16} />
            </button>
          ))}
        {search.active && !search.searching && !search.error && !search.results.length && (
          <p>No matching chats.</p>
        )}
      </details>
      <p className="workspace-muted">Links connect conversations. Access is granted separately.</p>
      {data && (
        <button
          type="button"
          className="session-links-new"
          disabled={busy}
          onClick={() => {
            setError('');
            data.refresh();
          }}
        >
          Refresh links
        </button>
      )}
      {draft && (
        <LaunchReview
          request={observed || draft}
          create={!observed}
          readRevision={data?.readRevision}
          disabled={disabled}
          onClose={() => setDraft(null)}
          onUpdate={() => data?.refresh()}
        />
      )}
    </section>
  );
}
