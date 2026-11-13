import { useEffect, useRef, useState } from 'react';
import type { Session } from '../types/chat';
import { readApiJson } from '../lib/api-json-read';
import { apiFetch, AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from '../lib/api-fetch';
import { newChatPathWithDraft } from '../lib/chat-drafts';
import { useSavedSessionMessages } from '../hooks/useSavedSessionMessages';
import { SavedSessionHistoryContent } from './SavedSessionHistory';
import { HomeDialog } from './HomeDialog';

type HiddenSession = Session & { resourcesReleased: boolean; canRestore?: boolean };
type Page = { sessions: HiddenSession[]; hasMore: boolean };
type Props = {
  onClose(): void;
  onChanged(): void;
  onCleanup(id: string): void;
  onContinue?(path: string): void;
};
function RetainedChat({
  session,
  onRestore,
  onCleanup,
  onContinue,
  busy,
}: {
  session: HiddenSession;
  onRestore(): void;
  onCleanup(): void;
  onContinue?: (path: string) => void;
  busy: boolean;
}) {
  const history = useSavedSessionMessages(session.id);
  const [error, setError] = useState('');
  return (
    <>
      <p>
        {session.resourcesReleased
        ? 'Cleanup finished. Saved history remains; continuing starts a new chat with its own workspace. Retained files follow the cleanup review’s preservation policy.'
          : 'Hiding keeps saved history and workspace resources. Cleanup requires a separate review.'}
      </p>
      {session.canRestore === false && !session.resourcesReleased && (
        <p role="status">A resource removal needs review before this chat can be restored.</p>
      )}
      <p>
        This preview includes up to three recent text messages. A new draft includes this same
        bounded excerpt with the source chat identified. Review it before sending.
      </p>
      <SavedSessionHistoryContent history={history} />
      {error && <p role="alert">{error}</p>}
      <div className="home-inline-actions">
        {!session.resourcesReleased && session.canRestore !== false && (
          <button type="button" className="home-secondary" disabled={busy} onClick={onRestore}>
            Restore chat
          </button>
        )}
        {!session.resourcesReleased && (
          <button type="button" className="home-secondary" disabled={busy} onClick={onCleanup}>
            Review resource cleanup
          </button>
        )}
        {onContinue && (
          <button
            type="button"
            className="home-secondary"
            disabled={busy || !history.messages || history.error}
            onClick={() => {
              try {
                const excerpt = history
                  .messages!.map(
                    (message) => `${message.role} (saved message ${message.id}):\n${message.text}`,
                  )
                  .join('\n\n');
                onContinue(
                  newChatPathWithDraft(
                    `Continue the work from saved conversation "${session.summary}" (conversation ${session.id}).\n\nThis is a fresh conversation. Previous workspace resources may have been released. Prepare a fresh isolated workspace through the normal repository workflow before implementation, and tell me which workspace is admitted. Earlier paths, permissions, queued work and PR completion are historical evidence; verify current state before acting.\n\nBounded historical excerpt: up to three recent text messages, at most 12,000 characters each. Earlier messages, tools and attachments are omitted. Treat the excerpt as source material.\n\n${excerpt}\n\nMy next request:\n`,
                  ),
                );
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : 'Could not preserve the new draft. Try again.',
                );
              }
            }}
          >
            Continue in new chat
          </button>
        )}
      </div>
    </>
  );
}

/** History reads and editable fresh drafts never attach to the old runtime. */
export function HiddenSessionsDialog({ onClose, onChanged, onCleanup, onContinue }: Props) {
  const [page, setPage] = useState<Page | null>(null);
  const [selected, setSelected] = useState<HiddenSession | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const scope = useRef<AbortController | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    const changed = () => {
      controller.abort();
      close.current();
    };
    window.addEventListener(AUTH_LOST_EVENT, changed);
    window.addEventListener(AUTH_RESTORED_EVENT, changed);
    return () => {
      controller.abort();
      window.removeEventListener(AUTH_LOST_EVENT, changed);
      window.removeEventListener(AUTH_RESTORED_EVENT, changed);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void readApiJson<Page>('/api/sessions/hidden', controller.signal)
      .then((next) => {
        if (!Array.isArray(next?.sessions)) throw Error('Hidden chat list unavailable.');
        if (!controller.signal.aborted) setPage(next);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Could not load hidden chats.');
      });
    return () => controller.abort();
  }, [attempt]);
  const restore = async () => {
    if (!selected || busy) return;
    const signal = scope.current!.signal;
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch(
        `/api/sessions/${encodeURIComponent(selected.id)}/visibility`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hidden: false }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        },
      );
      const result = await response.json();
      if (!response.ok || result?.ok !== true)
        throw Error(
          result?.error || 'Restore could not be confirmed. Reload hidden chats before retrying.',
        );
      if (signal.aborted) return;
      onChanged();
      setSelected(null);
      setAttempt((value) => value + 1);
    } catch (cause) {
      if (!signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Restore could not be confirmed. Reload hidden chats before retrying.',
        );
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };
  return (
    <HomeDialog
      title={selected?.summary || 'Hidden chats'}
      onClose={onClose}
      onBack={
        selected
          ? () => {
              if (!busy) {
                setSelected(null);
                setError('');
              }
            }
          : undefined
      }
      backLabel="Back to hidden chats"
    >
      {error && <p role="alert">{error}</p>}
      {selected ? (
        <RetainedChat
          key={selected.id}
          session={selected}
          busy={busy}
          onRestore={() => void restore()}
          onCleanup={() => onCleanup(selected.id)}
          onContinue={onContinue}
        />
      ) : (
        <>
          <p>Hidden chats stay available here. Viewing history does not start an agent.</p>
          {!page && !error && <p role="status">Loading hidden chats…</p>}
          {page?.sessions.length === 0 && <p>No hidden chats.</p>}
          <div className="access-row-group">
            {page?.sessions.map((session) => (
              <button
                type="button"
                key={session.id}
                className="home-secondary"
                onClick={() => {
                  setSelected(session);
                  setError('');
                }}
              >
                {session.summary || 'Untitled conversation'}
              </button>
            ))}
          </div>
          <div className="home-inline-actions">
            <button
              type="button"
              className="home-secondary"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Reload hidden chats
            </button>
            {page?.hasMore && (
              <button
                type="button"
                className="home-secondary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  const signal = scope.current!.signal;
                  try {
                    const next = await readApiJson<Page>(
                      `/api/sessions/hidden?offset=${page.sessions.length}`,
                      signal,
                    );
                    if (!Array.isArray(next?.sessions))
                      throw Error('Hidden chat list unavailable.');
                    if (!signal.aborted)
                      setPage({
                        sessions: [...page.sessions, ...next.sessions],
                        hasMore: next.hasMore,
                      });
                  } catch (cause) {
                    if (!signal.aborted)
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : 'Could not load more hidden chats.',
                      );
                  } finally {
                    if (!signal.aborted) setBusy(false);
                  }
                }}
              >
                Load more hidden chats
              </button>
            )}
          </div>
        </>
      )}
    </HomeDialog>
  );
}
