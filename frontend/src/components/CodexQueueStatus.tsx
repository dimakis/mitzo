import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '../lib/api-fetch';
import './CodexQueueStatus.css';
const Queue = z.object({
  paused: z.boolean(),
  connected: z.boolean(),
  queued: z.number().int().nonnegative(),
  interrupted: z.number().int().nonnegative(),
});
type QueueState = z.infer<typeof Queue>;
export function CodexQueueStatus({ sessionId }: { sessionId: string | null }) {
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let disposed = false;
    let isCodex = false;
    let idle = false;
    let reading = false;
    let lastRead = 0;
    setQueue(null);
    setError('');
    if (!sessionId) return;
    const read = async () => {
      if (disposed || reading) return;
      reading = true;
      lastRead = Date.now();
      try {
        const response = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/meta`, {
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error();
        const data = await response.json();
        const parsed = Queue.safeParse(data.codexQueue);
        isCodex = parsed.success;
        idle = parsed.success && !parsed.data.paused && parsed.data.queued === 0;
        if (!disposed) {
          setQueue(parsed.success ? parsed.data : null);
          setError('');
        }
      } catch {
        if (!disposed && isCodex)
          setError('Queue status unavailable. Retry to check saved messages.');
      } finally {
        reading = false;
      }
    };
    refresh.current = read;
    void read();
    const timer = setInterval(() => {
      if (
        isCodex &&
        document.visibilityState !== 'hidden' &&
        (!idle || Date.now() - lastRead >= 30000)
      )
        void read();
    }, 10000);
    const focus = () => {
      if (isCodex) void read();
    };
    window.addEventListener('focus', focus);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, [sessionId]);
  if (!queue) return null;
  const continueQueue = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch(
        `/api/sessions/${encodeURIComponent(sessionId!)}/codex-queue/continue`,
        { method: 'POST' },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(
          typeof body.error === 'string'
            ? body.error
            : 'Could not continue. Check the connection and retry.',
        );
      }
      await refresh.current();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Could not continue. Check the connection and retry.',
      );
    } finally {
      setBusy(false);
    }
  };
  const hasRecovery = queue.paused && (queue.queued > 0 || queue.interrupted > 0);
  if (!hasRecovery && !queue.queued && !error) return null;
  const title = queue.queued
    ? `${queue.queued} ${queue.queued === 1 ? 'message' : 'messages'} waiting`
    : 'Session paused';
  const recoveryMessage = queue.connected
    ? 'An earlier action may be incomplete. Review the chat before continuing.'
    : 'Connection interrupted; an action may be incomplete. Send a message to reconnect.';
  return (
    <aside className="codex-queue-status" role="status" aria-live="polite">
      <div className="codex-queue-status-copy">
        <strong>{title}</strong>
        {hasRecovery && <span>{recoveryMessage}</span>}
      </div>
      {error && <p role="alert">{error}</p>}
      {queue.paused && queue.connected && (
        <button type="button" disabled={busy} onClick={() => void continueQueue()}>
          {busy
            ? 'Reconnecting…'
            : queue.queued > 0
              ? 'Continue queued messages'
              : 'Reconnect session'}
        </button>
      )}
      {error && (
        <button type="button" onClick={() => void refresh.current()}>
          Retry queue status
        </button>
      )}
    </aside>
  );
}
