import { useEffect, useRef, useState } from 'react';
import { HomeDialog } from './HomeDialog';
import { readApiJson } from '../lib/api-json-read';
import { sessionRemovalAction } from '../lib/session-removal-action';
import { AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from '../lib/api-fetch';
import type { SandboxCleanupPreview, SessionRemovalOptions } from '../types/sandboxes';
interface Review {
  sandbox: SandboxCleanupPreview | null;
  blockedReason?: string | null;
  needsPreparation?: boolean;
  removal?: { operationId: string; phase: string; canKeep: boolean } | null;
  localWorkspace?: { action: 'retire' | 'retain'; reason: string } | null;
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
  const scope = useRef(new AbortController());
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    inFlight.current = false;
    setBusy(false);
    const changed = () => {
      controller.abort();
      closeRef.current();
    };
    window.addEventListener(AUTH_LOST_EVENT, changed);
    window.addEventListener(AUTH_RESTORED_EVENT, changed);
    return () => {
      controller.abort();
      window.removeEventListener(AUTH_LOST_EVENT, changed);
      window.removeEventListener(AUTH_RESTORED_EVENT, changed);
    };
  }, [sessionId]);
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
    const signal = scope.current.signal;
    inFlight.current = true;
    setBusy(true);
    try {
      const removed = await onRemove(options);
      if (signal.aborted) return;
      if (removed) onClose();
      else {
        setReview(null);
        setError('Removal could not be confirmed. Review again before retrying.');
      }
    } catch {
      if (!signal.aborted) {
        setReview(null);
        setError('Removal could not be confirmed. Review again before retrying.');
      }
    } finally {
      if (!signal.aborted) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  const action = async (kind: 'prepare-deletion' | 'keep-chat') => {
    if (inFlight.current) return;
    const signal = scope.current.signal;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const next = await sessionRemovalAction<Review>(
        '/api/sessions/' + encodeURIComponent(sessionId) + '/' + kind,
        kind === 'keep-chat' ? { removalOperationId: review?.removal?.operationId } : {},
        signal,
      );
      if (signal.aborted) return;
      if (kind === 'keep-chat') onClose();
      else if (next && Object.prototype.hasOwnProperty.call(next, 'sandbox')) setReview(next);
      else throw Error('Removal review is unconfirmed. Review again.');
    } catch (error) {
      if (!signal.aborted) {
        setReview(null);
        setError(
          error instanceof Error
            ? error.message + ' Use Review again to check this removal.'
            : 'Removal is unconfirmed. Review again.',
        );
      }
    } finally {
      if (!signal.aborted) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  const blocked =
    !review ||
    !!review.needsPreparation ||
    !!review.blockedReason ||
    review.sandbox?.action === 'none';
  return (
    <HomeDialog
      title="Delete chat?"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {review?.localWorkspace ? (
        <p>{review.localWorkspace.reason}</p>
      ) : (
        <p>
          Delete removes this chat from Chats and releases its sandbox after saving and verifying a
          recovery checkpoint. Saved history and the checkpoint are retained.
        </p>
      )}
      {review?.needsPreparation && (
        <p>
          Stop and review cancels this chat’s timers and submitted queued messages, closes its
          runtime, and checks preservation. You review deletion separately afterward.
        </p>
      )}
      {review?.removal?.canKeep && (
        <p>
          This chat is paused for removal. Keep chat allows new work again; cancelled timers stay
          cancelled.
        </p>
      )}
      <p>Archive removes the chat from Chats and keeps its sandbox.</p>
      {!review && !error && <p role="status">Reviewing sandbox…</p>}
      {review?.sandbox?.action === 'none' && (
        <p role="status">
          Deletion is blocked:{' '}
          {review.sandbox.blockers.map((b) => b.replaceAll('_', ' ')).join(', ') ||
            'ownership or recovery needs review'}
          .{' '}
          {review.needsPreparation
            ? 'Stop and review to check whether its runtime can close safely.'
            : 'Review unfinished work before deleting.'}
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
        {review?.removal?.canKeep && (
          <button
            className="home-secondary"
            disabled={busy}
            onClick={() => void action('keep-chat')}
          >
            Keep chat
          </button>
        )}
        {review?.needsPreparation && (
          <button
            className="home-secondary"
            disabled={busy}
            onClick={() => void action('prepare-deletion')}
          >
            Stop and review deletion
          </button>
        )}
        <button
          className="home-secondary home-danger"
          disabled={busy || blocked}
          onClick={() =>
            void remove({
              ...(review?.sandbox ? { cleanupToken: review.sandbox.token } : {}),
              ...(review?.removal ? { removalOperationId: review.removal.operationId } : {}),
            })
          }
        >
          {busy ? 'Removing…' : review?.sandbox ? 'Delete chat and sandbox' : 'Delete chat'}
        </button>
      </div>
    </HomeDialog>
  );
}
