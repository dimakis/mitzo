import { useEffect, useRef, useState } from 'react';
import { HomeDialog } from './HomeDialog';
import { readApiJson } from '../lib/api-json-read';
import type { SandboxCleanupPreview, SessionRemovalOptions } from '../types/sandboxes';
interface Review {
  sandbox: SandboxCleanupPreview | null;
  blockedReason?: string | null;
}

export function SessionRemovalDialog({
  sessionId,
  onRemove,
  onClose,
}: {
  sessionId: string;
  onRemove(options: SessionRemovalOptions): Promise<boolean>;
  onClose(): void;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const inFlight = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setReview(null);
    setError('');
    void readApiJson<Review>(
      '/api/sessions/' + encodeURIComponent(sessionId) + '/deletion-preview',
      controller.signal,
    )
      .then((next) => {
        if (!next || !Object.prototype.hasOwnProperty.call(next, 'sandbox'))
          throw Error('Deletion review unavailable.');
        if (!controller.signal.aborted) setReview(next);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('Couldn’t review sandbox deletion. Retry or archive the chat.');
      });
    return () => controller.abort();
  }, [sessionId, revision]);
  const remove = async (options: SessionRemovalOptions) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      if (await onRemove(options)) onClose();
      else {
        setReview(null);
        setError('Removal could not be confirmed. Review again before retrying.');
      }
    } catch {
      setReview(null);
      setError('Removal could not be confirmed. Review again before retrying.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const blocked = !review || !!review.blockedReason || review.sandbox?.action === 'none';
  return (
    <HomeDialog
      title="Delete chat?"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p>
        Delete removes this chat from Chats and releases its sandbox after saving and verifying a
        recovery checkpoint. Saved history and the checkpoint are retained.
      </p>
      <p>Archive removes the chat from Chats and keeps its sandbox.</p>
      {!review && !error && <p role="status">Reviewing sandbox…</p>}
      {review?.sandbox?.action === 'none' && (
        <p role="status">
          Deletion is blocked:{' '}
          {review.sandbox.blockers.map((b) => b.replaceAll('_', ' ')).join(', ') ||
            'ownership or recovery needs review'}
          . Finish active work before reviewing again.
        </p>
      )}
      {review?.blockedReason && <p role="status">{review.blockedReason}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="home-inline-actions">
        <button
          className="home-secondary"
          disabled={busy}
          onClick={() => void remove({ archive: true })}
        >
          Archive chat
        </button>
        <button
          className="home-secondary"
          disabled={busy}
          onClick={() => setRevision((r) => r + 1)}
        >
          Review again
        </button>
        <button
          className="home-secondary home-danger"
          disabled={busy || blocked}
          onClick={() => void remove(review?.sandbox ? { cleanupToken: review.sandbox.token } : {})}
        >
          {busy ? 'Removing…' : review?.sandbox ? 'Delete chat and sandbox' : 'Delete chat'}
        </button>
      </div>
    </HomeDialog>
  );
}
