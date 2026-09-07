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
    setQueue(null);
    setError('');
    if (!sessionId) return;
    const read = async () => {
      try {
        const response = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/meta`);
        if (!response.ok) throw new Error();
        const data = await response.json();
        const parsed = Queue.safeParse(data.codexQueue);
        isCodex = parsed.success;
        if (!disposed) {
          setQueue(parsed.success ? parsed.data : null);
          setError('');
        }
      } catch {
        if (!disposed && isCodex)
          setError('Queue status unavailable. Retry to check saved messages.');
      }
    };
    refresh.current = read;
    void read();
    const timer = setInterval(() => {
      if (isCodex && document.visibilityState !== 'hidden') void read();
    }, 2000);
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
      if (!response.ok) throw new Error();
      await refresh.current();
    } catch {
      setError('Could not continue. Check the connection and retry.');
    } finally {
      setBusy(false);
    }
  };
  if (!queue.paused && !queue.queued && !error) return null;
  return (
    <aside className="codex-queue-status" role="status" aria-live="polite">
      <strong>
        {queue.queued} queued {queue.queued === 1 ? 'message' : 'messages'}
        {queue.paused ? ' · Paused' : ''}
      </strong>
      {queue.paused && (
        <p>
          Inspect interrupted actions before continuing. Their outcomes may be uncertain; they will
          not be replayed automatically.
        </p>
      )}
      {queue.paused && !queue.connected && (
        <p>Send a message to reconnect, then continue the saved queue.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {queue.paused && queue.connected && queue.queued > 0 && (
        <button type="button" disabled={busy} onClick={() => void continueQueue()}>
          {busy ? 'Continuing…' : 'Continue queued messages'}
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
