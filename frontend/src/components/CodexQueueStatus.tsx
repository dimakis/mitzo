import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '../lib/api-fetch';
import './CodexQueueStatus.css';

const Queue = z.object({
  paused: z.boolean(),
  connected: z.boolean(),
  recovering: z.boolean().optional(),
  recoveryPhase: z.enum(['starting_workspace', 'reconnecting']).optional(),
  queued: z.number().int().nonnegative(),
  interrupted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative().optional().default(0),
  retryAvailableAt: z.number().int().positive().optional(),
  retryable: z.boolean().optional(),
});
const QueuedCommands = z.object({
  queued: z.array(z.object({ id: z.string(), preview: z.string() })),
  cancelledIds: z.array(z.string()),
  hasMore: z.boolean().optional(),
});

type QueueState = z.infer<typeof Queue>;
type QueuedCommand = z.infer<typeof QueuedCommands>['queued'][number];

const hiddenKey = (sessionId: string) => `mitzo-codex-status-hidden:${sessionId}`;

function isHidden(sessionId: string) {
  try {
    return sessionStorage.getItem(hiddenKey(sessionId)) === '1';
  } catch {
    return false;
  }
}

function setHidden(sessionId: string, hidden: boolean) {
  try {
    if (hidden) sessionStorage.setItem(hiddenKey(sessionId), '1');
    else sessionStorage.removeItem(hiddenKey(sessionId));
  } catch {
    /* This is a local preference only. */
  }
}

export function CodexQueueStatus({ sessionId }: { sessionId: string | null }) {
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [commands, setCommands] = useState<QueuedCommand[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [continuing, setContinuing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const statusTab = useRef<HTMLButtonElement>(null);
  const hideButton = useRef<HTMLButtonElement>(null);
  const swipeStart = useRef<{ x: number; y: number; cancel: boolean } | null>(null);
  const consumeCancelClick = useRef(false);
  const sessionEpoch = useRef(0);
  const previousCollapsed = useRef<boolean | null>(null);
  const drawerId = useId();

  useEffect(() => {
    ++sessionEpoch.current;
    let disposed = false;
    let isCodex = false;
    let pending = false;
    let reading = false;
    let lastRead = 0;
    setQueue(null);
    setCommands([]);
    setHasMore(false);
    setError('');
    setNotice('');
    setCancelling(null);
    setContinuing(false);
    setRetrying(false);
    setDrawerOpen(false);
    consumeCancelClick.current = false;
    setCollapsed(sessionId ? isHidden(sessionId) : false);
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
        pending =
          parsed.success &&
          (!!parsed.data.recovering || parsed.data.queued > 0 || parsed.data.failed > 0);
        let queued: QueuedCommand[] = [];
        let moreQueued = false;
        if (parsed.success && parsed.data.queued > 0) {
          try {
            const commandResponse = await apiFetch(
              `/api/sessions/${encodeURIComponent(sessionId)}/codex-queue`,
              { signal: AbortSignal.timeout(15000) },
            );
            if (commandResponse.ok) {
              const commandData = QueuedCommands.safeParse(await commandResponse.json());
              if (commandData.success) {
                queued = commandData.data.queued;
                moreQueued = commandData.data.hasMore ?? false;
              }
            }
          } catch {
            // The compact status stays useful while the drawer details refresh.
          }
        }
        if (!disposed) {
          setQueue(parsed.success ? parsed.data : null);
          setCommands(queued);
          setHasMore(moreQueued);
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
        (pending || Date.now() - lastRead >= 30000)
      )
        void read();
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

  useEffect(() => {
    const previous = previousCollapsed.current;
    previousCollapsed.current = collapsed;
    if (previous === null || previous === collapsed) return;
    if (collapsed) statusTab.current?.focus();
    else hideButton.current?.focus();
  }, [collapsed]);

  if (!queue) return null;
  const actionable =
    !!queue.recovering || queue.queued > 0 || queue.failed > 0 || !!error || !!notice;
  if (!actionable) return null;

  const retryWaitSeconds = queue.retryAvailableAt
    ? Math.max(0, Math.ceil((queue.retryAvailableAt - Date.now()) / 1_000))
    : 0;

  const status = queue.recovering
    ? queue.recoveryPhase === 'starting_workspace'
      ? 'Starting workspace… Your message is saved.'
      : 'Reconnecting… Your message is saved.'
    : queue.failed > 0
      ? queue.retryable === false
        ? 'This failed turn needs attention and cannot be retried.'
        : retryWaitSeconds > 0
          ? `OpenAI asked us to wait ${retryWaitSeconds}s before retrying.`
          : 'Previous turn failed. Retry when available.'
      : queue.paused
        ? 'Reconnection needed. Your message is saved.'
        : queue.queued > 0
          ? `${queue.queued} ${queue.queued === 1 ? 'message is' : 'messages are'} waiting behind the current turn.`
          : 'An earlier step may be incomplete.';

  const hide = () => {
    if (sessionId) {
      setHidden(sessionId, true);
      setCollapsed(true);
    }
  };
  const show = () => {
    if (sessionId) setHidden(sessionId, false);
    setCollapsed(false);
  };
  const continueQueue = async () => {
    if (!sessionId || continuing) return;
    const epoch = sessionEpoch.current;
    setContinuing(true);
    setError('');
    setNotice('');
    try {
      const response = await apiFetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/codex-queue/continue`,
        { method: 'POST', signal: AbortSignal.timeout(15000) },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(
          typeof body.error === 'string'
            ? body.error
            : 'Could not reconnect. Your saved message is still queued.',
        );
      }
      if (epoch === sessionEpoch.current) {
        setNotice('Reconnected. Continuing saved messages.');
        await refresh.current();
      }
    } catch (error) {
      if (epoch === sessionEpoch.current)
        setNotice(
          error instanceof Error
            ? error.message
            : 'Could not reconnect. Your saved message is still queued.',
        );
    } finally {
      if (epoch === sessionEpoch.current) setContinuing(false);
    }
  };
  const retryFailed = async () => {
    if (!sessionId || retrying) return;
    const epoch = sessionEpoch.current;
    setRetrying(true);
    setError('');
    setNotice('');
    try {
      const response = await apiFetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/codex-queue/retry`,
        { method: 'POST', signal: AbortSignal.timeout(15000) },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(
          typeof body.error === 'string'
            ? body.error
            : 'Could not retry the saved turn. It remains available.',
        );
      }
      if (epoch === sessionEpoch.current) {
        setNotice('Retrying the saved turn.');
        await refresh.current();
      }
    } catch (error) {
      if (epoch === sessionEpoch.current)
        setNotice(
          error instanceof Error
            ? error.message
            : 'Could not retry the saved turn. It remains available.',
        );
    } finally {
      if (epoch === sessionEpoch.current) setRetrying(false);
    }
  };
  const cancel = async (commandId: string) => {
    if (!sessionId || cancelling) return;
    const epoch = sessionEpoch.current;
    setCancelling(commandId);
    setError('');
    setNotice('');
    try {
      const response = await apiFetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/codex-queue/${encodeURIComponent(commandId)}/cancel`,
        { method: 'POST', signal: AbortSignal.timeout(15000) },
      );
      if (!response.ok) {
        if (epoch === sessionEpoch.current) {
          setNotice(
            response.status === 409
              ? 'Could not cancel this message. It may have started; check the queue.'
              : 'Could not confirm cancellation. Check the queue.',
          );
        }
      }
    } catch {
      if (epoch === sessionEpoch.current)
        setNotice('Could not confirm cancellation. Check the queue.');
    } finally {
      if (epoch === sessionEpoch.current) {
        await refresh.current();
        setCancelling(null);
      }
    }
  };

  if (collapsed) {
    return (
      <div className="codex-status-anchor">
        <button
          className="codex-queue-status-tab"
          type="button"
          ref={statusTab}
          aria-controls={drawerId}
          aria-expanded="false"
          onClick={show}
        >
          Chat status
        </button>
      </div>
    );
  }

  return (
    <div className="codex-status-anchor codex-status-anchor--expanded">
      <aside
        className="codex-queue-status"
        id={drawerId}
        role="status"
        aria-live="polite"
        onPointerDown={(event) => {
          swipeStart.current = {
            x: event.clientX,
            y: event.clientY,
            cancel: !!(event.target as HTMLElement).closest('.codex-queue-status-command button'),
          };
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
          if (start.cancel && horizontalDistance >= 56 && horizontalDistance > verticalDistance) {
            consumeCancelClick.current = true;
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (horizontalDistance >= 56 && horizontalDistance > verticalDistance) hide();
        }}
      >
        <div className="codex-queue-status-line">
          {(error || notice) && (
            <span className="codex-queue-status-attention" role="img" aria-label="Attention">
              !
            </span>
          )}
          <strong>{status}</strong>
          {queue.paused && queue.connected && !queue.recovering && queue.queued > 0 && (
            <button
              type="button"
              className="codex-queue-status-continue"
              disabled={continuing}
              onClick={() => void continueQueue()}
            >
              {continuing ? 'Reconnecting…' : 'Reconnect and continue'}
            </button>
          )}
          {queue.failed > 0 &&
            queue.retryable !== false &&
            queue.connected &&
            !queue.recovering && (
              <button
                type="button"
                className="codex-queue-status-continue"
                disabled={retrying || retryWaitSeconds > 0}
                onClick={() => void retryFailed()}
              >
                {retrying
                  ? 'Retrying…'
                  : retryWaitSeconds > 0
                    ? `Retry in ${retryWaitSeconds}s`
                    : 'Retry saved turn'}
              </button>
            )}
          {queue.queued > 0 && (
            <button
              type="button"
              className="codex-queue-status-drawer-toggle"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen((open) => !open)}
            >
              {drawerOpen ? 'Close queue' : 'Review queue'}
            </button>
          )}
          <button
            type="button"
            className="codex-queue-status-hide"
            ref={hideButton}
            onClick={hide}
            aria-label="Hide status"
          >
            Hide
          </button>
        </div>
        {drawerOpen && queue.queued > 0 && (
          <div className="codex-queue-status-drawer" aria-label="Queued messages">
            {hasMore && commands.length === 100 && <p>Showing first 100 waiting messages.</p>}
            {commands.length > 0 ? (
              commands.map((command) => (
                <div className="codex-queue-status-command" key={command.id}>
                  <span>{command.preview}</span>
                  <button
                    type="button"
                    disabled={cancelling === command.id}
                    onPointerDown={() => {
                      // A new pointer action is a deliberate new cancellation
                      // attempt if the browser suppressed the swipe's click.
                      consumeCancelClick.current = false;
                    }}
                    onClick={(event) => {
                      // Keyboard activation has detail 0 and must never be
                      // swallowed by a stale pointer gesture.
                      if (consumeCancelClick.current && event.detail !== 0) {
                        consumeCancelClick.current = false;
                        return;
                      }
                      consumeCancelClick.current = false;
                      void cancel(command.id);
                    }}
                  >
                    {cancelling === command.id ? 'Cancelling…' : 'Cancel'}
                  </button>
                </div>
              ))
            ) : (
              <p>Checking queued messages…</p>
            )}
          </div>
        )}
        {(error || notice) && <p role="alert">{error || notice}</p>}
        {error && (
          <button type="button" onClick={() => void refresh.current()}>
            Retry
          </button>
        )}
      </aside>
    </div>
  );
}
