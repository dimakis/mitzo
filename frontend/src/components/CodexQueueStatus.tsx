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
  const [collapsed, setCollapsed] = useState(false);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);
  const statusTab = useRef<HTMLButtonElement>(null);
  const hideButton = useRef<HTMLButtonElement>(null);
  const previousCollapsed = useRef<boolean | null>(null);
  useEffect(() => {
    let disposed = false;
    let isCodex = false;
    let idle = false;
    let reading = false;
    let lastRead = 0;
    setQueue(null);
    setError('');
    setCollapsed(false);
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
  useEffect(() => {
    const previous = previousCollapsed.current;
    previousCollapsed.current = collapsed;
    if (previous === null || previous === collapsed) return;
    if (collapsed) statusTab.current?.focus();
    else hideButton.current?.focus();
  }, [collapsed]);
  useEffect(() => {
    if (error) setCollapsed(false);
  }, [error]);
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
    : 'Chat paused';
  const recoveryMessage = queue.connected
    ? 'Your last step may be incomplete. Check the chat before continuing.'
    : 'Connection interrupted. Send a message to reconnect.';
  const hide = () => {
    if (!busy && !error) setCollapsed(true);
  };
  const consumeSwipe = () => {
    if (!swiped.current) return false;
    swiped.current = false;
    return true;
  };
  if (collapsed) {
    return (
      <button
        className="codex-queue-status-tab"
        type="button"
        ref={statusTab}
        aria-expanded="false"
        onClick={() => {
          swiped.current = false;
          setCollapsed(false);
        }}
      >
        Chat status
      </button>
    );
  }
  return (
    <aside
      className="codex-queue-status"
      role="status"
      aria-live="polite"
      onPointerDown={(event) => {
        swiped.current = false;
        swipeStart.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerCancel={() => {
        swipeStart.current = null;
      }}
      onPointerUp={(event) => {
        const start = swipeStart.current;
        swipeStart.current = null;
        if (!start) return;
        const horizontalDistance = Math.abs(event.clientX - start.x);
        const verticalDistance = Math.abs(event.clientY - start.y);
        if (horizontalDistance >= 56 && horizontalDistance > verticalDistance && !busy && !error) {
          swiped.current = true;
          hide();
        }
      }}
    >
      <div className="codex-queue-status-copy">
        <strong>{title}</strong>
        {hasRecovery && <span>{recoveryMessage}</span>}
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="codex-queue-status-actions">
        {queue.paused && queue.connected && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!consumeSwipe()) void continueQueue();
            }}
          >
            {busy ? 'Reconnecting…' : queue.queued > 0 ? 'Continue messages' : 'Reconnect'}
          </button>
        )}
        {error ? (
          <button type="button" onClick={() => void refresh.current()}>
            Retry
          </button>
        ) : (
          <button
            type="button"
            className="codex-queue-status-hide"
            ref={hideButton}
            onClick={() => {
              if (!consumeSwipe()) hide();
            }}
          >
            Hide
          </button>
        )}
      </div>
    </aside>
  );
}
