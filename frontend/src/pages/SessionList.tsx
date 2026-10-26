import { ConversationPins } from '../components/ConversationPins';
import { SessionRemovalDialog } from '../components/SessionRemovalDialog';
import { ResizableSessionLayout } from '../components/ResizableSessionLayout';
import { SessionInspector } from '../components/SessionInspector';
import { SessionContextMenu, type SessionMenuState } from '../components/SessionContextMenu';
import { SessionRenameDialog } from '../components/SessionRenameDialog';
import { SessionDetailsDialog } from '../components/SessionDetailsDialog';
import { SessionWorkLink } from '../components/SessionWorkLink';
import { useMediaQuery } from '../hooks/useMediaQuery';
import type { SessionActionPoint } from '../hooks/useSessionInteraction';
import '../styles/session-library.css';
import { SdkConversationImport } from '../components/SdkConversationImport';
import { sessionNeedsYouReason } from '../lib/session-attention';
import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSavedChatDrafts } from '../hooks/useSavedChatDrafts';
import '../styles/chat-drafts.css';
import type { Session } from '../types/chat';
import { formatRelativeTime } from '../lib/formatTime';
import { useLongPress } from '../hooks/useLongPress';
import { computeSwipeState, REVEAL_WIDTH } from '../lib/swipe-reveal';
import { selectionChanged } from '../lib/haptics';
import { useSessionList } from '../hooks/useSessionList';
import type { QuickAction } from '../hooks/useSessionList';
import { useSessionSearch } from '../hooks/useSessionSearch';
import { useSessionOverview, type SessionActivity } from '../hooks/useSessionOverview';
import { SessionPreview } from '../components/SessionPreview';
import { UiIcon } from '../components/UiIcon';

function SwipeableSession({
  session,
  snippet,
  activity,
  onDismiss,
  onClick,
  onRename,
  desktop = false,
  selected = false,
  onPreview,
  onActions,
}: {
  session: Session;
  desktop?: boolean;
  selected?: boolean;
  onPreview?: (session: Session) => void;
  onActions?: (session: Session, trigger: HTMLElement, point?: SessionActionPoint) => void;
  snippet?: string;
  activity?: SessionActivity;
  onDismiss: (id: string) => void;
  onClick: (id: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const startX = useRef(0);
  const startY = useRef(0);
  const currentX = useRef(0);
  const swiping = useRef(false);
  const directionLocked = useRef<'horizontal' | 'vertical' | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const moved = useRef(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [revealed, setRevealed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const enterEditMode = useCallback(() => {
    setEditValue(session.summary || '');
    setEditing(true);
  }, [session.summary]);

  const showPreview = useCallback(
    (point?: SessionActionPoint) => {
      if (editing) return;
      const trigger = ref.current?.querySelector<HTMLElement>('.session-item-navigation');
      trigger?.focus();
      selectionChanged();
      if (desktop && trigger) {
        onPreview?.(session);
        onActions?.(session, trigger, point);
      } else setPreviewing(true);
    },
    [editing, desktop, onPreview, onActions, session],
  );
  const closePreview = useCallback(() => setPreviewing(false), []);
  const longPress = useLongPress(showPreview);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  function handleSave() {
    const trimmed = editValue.trim();
    setEditing(false);
    if (trimmed && trimmed !== session.summary) {
      onRename(session.id, trimmed);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      setEditing(false);
    }
  }

  function snapTo(x: number) {
    if (!ref.current) return;
    ref.current.style.transition = 'transform var(--motion-duration-standard) var(--motion-ease)';
    ref.current.style.transform = `translateX(${x}px)`;
    setTimeout(() => {
      if (ref.current) ref.current.style.transition = '';
    }, 200);
  }

  function closeReveal() {
    setRevealed(false);
    snapTo(0);
  }

  function handleDeleteTap(e: React.MouseEvent | React.TouchEvent) {
    e.stopPropagation();
    closeReveal();
    onDismiss(session.id);
  }

  function handleTouchStart(e: React.TouchEvent) {
    if (e.touches.length !== 1) {
      longPress.cancel();
      return;
    }
    moved.current = false;
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
    currentX.current = startX.current;
    swiping.current = true;
    directionLocked.current = null;
    if (!editing) longPress.start();
  }

  function handleTouchMove(e: React.TouchEvent) {
    if (longPress.didFire()) return;
    if (!swiping.current || !ref.current) return;
    currentX.current = e.touches[0].clientX;
    const dx = currentX.current - startX.current;
    const dy = e.touches[0].clientY - startY.current;

    if (!directionLocked.current && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      directionLocked.current = Math.abs(dy) > Math.abs(dx) ? 'vertical' : 'horizontal';
      moved.current = true;
      longPress.cancel();
    }

    if (directionLocked.current === 'vertical') return;

    if (revealed) {
      const offset = Math.min(0, -REVEAL_WIDTH + dx);
      ref.current.style.transform = `translateX(${offset}px)`;
    } else if (dx < 0) {
      const clamped = Math.max(dx, -REVEAL_WIDTH);
      ref.current.style.transform = `translateX(${clamped}px)`;
    }
  }

  function handleTouchEnd() {
    longPress.cancel();
    if (!swiping.current || !ref.current) return;
    swiping.current = false;
    if (longPress.didFire()) return;
    if (directionLocked.current === 'vertical') {
      snapTo(revealed ? -REVEAL_WIDTH : 0);
      return;
    }
    const dx = currentX.current - startX.current;

    const phase = computeSwipeState(dx, revealed);

    if (phase === 'reveal') {
      setRevealed(true);
      snapTo(-REVEAL_WIDTH);
    } else if (phase === 'close' || phase === 'idle') {
      closeReveal();
    } else {
      // dragging but didn't reach threshold — snap back
      snapTo(0);
    }
  }

  function handleClick(keyboard = false) {
    const held = longPress.consumeClick();
    const dragged = moved.current;
    moved.current = false;
    if (editing || previewing || (!keyboard && (held || dragged))) return;
    if (revealed) {
      closeReveal();
      return;
    }
    if (desktop && !keyboard) onPreview?.(session);
    else onClick(session.id);
  }

  return (
    <div className="session-item-wrapper" data-selected={selected}>
      <div
        className="session-item-delete-action"
        onClick={handleDeleteTap}
        onTouchEnd={handleDeleteTap}
      >
        Delete
      </div>
      <div
        ref={ref}
        className="session-item"
        data-selected={selected}
        onDoubleClick={(event) => {
          if (event.target instanceof Element && event.target.closest('button, a, input')) return;
          if (desktop && !editing) onClick(session.id);
        }}
        onClick={() => handleClick()}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={() => {
          longPress.cancel();
          swiping.current = false;
          closeReveal();
        }}
        onContextMenu={(event) => {
          if (editing) return;
          event.preventDefault();
          showPreview({ x: event.clientX, y: event.clientY });
        }}
      >
        {session.isActive && session.isAttached != null && (
          <span
            className={`session-status-dot ${session.isAttached ? 'attached' : 'detached'}`}
            role="status"
            aria-label={session.isAttached ? 'Session active' : 'Session detached'}
          />
        )}
        <div className="session-item-content">
          {editing ? (
            <input
              ref={inputRef}
              className="session-rename-input"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleSave}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
            />
          ) : (
            <div
              className="session-item-navigation"
              role={desktop ? 'button' : 'link'}
              tabIndex={0}
              aria-label={`${desktop ? 'Preview' : 'Open'} ${session.summary || 'Untitled conversation'}`}
              onFocus={() => {
                if (desktop) onPreview?.(session);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                  e.preventDefault();
                  showPreview();
                } else if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  handleClick(true);
                }
              }}
            >
              <div className="session-item-summary">
                {session.summary || 'Untitled conversation'}
              </div>
              {snippet && <div className="conversation-result-snippet">{snippet}</div>}
              <div className="session-item-meta">
                {activity && (
                  <span className={`conversation-state conversation-state--${activity.state}`}>
                    {activityLabel(activity)}
                  </span>
                )}
                {activity?.progress && (
                  <span className="conversation-progress">
                    {activity.progress.done}/{activity.progress.total} tasks
                  </span>
                )}
                {!activity && session.isActive && (
                  <span className="conversation-state">Active</span>
                )}
                <span className="session-item-time">
                  {formatRelativeTime(session.lastModified)}
                </span>
              </div>
            </div>
          )}
          <button
            type="button"
            className="session-action-trigger conversation-row-actions"
            aria-label={`Actions for ${session.summary || 'Untitled conversation'}`}
            onClick={(event) => {
              event.stopPropagation();
              showPreview({
                x: event.currentTarget.getBoundingClientRect().right,
                y: event.currentTarget.getBoundingClientRect().bottom,
              });
            }}
            onTouchStart={(event) => event.stopPropagation()}
          >
            <UiIcon name="more" size={16} />
          </button>
          {session.telosTaskId && <SessionWorkLink taskId={session.telosTaskId} />}
        </div>
        {!editing && (
          <span className="session-item-chevron">
            <UiIcon name="forward" size={16} />
          </span>
        )}
      </div>
      {previewing && (
        <SessionPreview
          session={session}
          onClose={closePreview}
          onOpen={() => {
            closePreview();
            onClick(session.id);
          }}
          onRename={() => {
            closePreview();
            enterEditMode();
          }}
          onDelete={() => {
            closePreview();
            closeReveal();
            onDismiss(session.id);
          }}
        />
      )}
    </div>
  );
}

export function SessionList() {
  const [removing, setRemoving] = useState<string | null>(null);
  const navigate = useNavigate();
  const desktop = useMediaQuery('(min-width: 768px)');
  const [mobilePinPreview, setMobilePinPreview] = useState<Session | null>(null);
  const [preview, setPreview] = useState<Session | null>(null);
  const [menu, setMenu] = useState<SessionMenuState | null>(null);
  const [renaming, setRenaming] = useState<Session | null>(null);
  const [details, setDetails] = useState<Session | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const showActions = useCallback(
    (session: Session, trigger: HTMLElement, point?: SessionActionPoint) => {
      setPreview(session);
      setMenu({ session, trigger, point });
    },
    [],
  );
  const drafts = useSavedChatDrafts();
  const {
    sessions,
    quickActions,
    loading,
    error,
    loadingMore,
    hasMore,
    dismissSession,
    clearAll,
    handleRename: renameSession,
    loadMore,
    retry,
  } = useSessionList();
  const search = useSessionSearch();
  const [importOpen, setImportOpen] = useState(false);
  const conversationOptions = useRef<HTMLElement>(null);

  const { activities } = useSessionOverview();
  const [filter, setFilter] = useState<'all' | 'active' | 'attention'>('all');
  const byId = new Map(activities.map((a) => [a.sessionId, a]));
  const combined = new Map(sessions.map((s) => [s.id, s]));
  for (const a of activities) {
    const existing = combined.get(a.sessionId);
    combined.set(a.sessionId, {
      ...existing,
      id: a.sessionId,
      summary: existing?.summary || a.title,
      lastModified: Math.max(existing?.lastModified ?? 0, a.lastEventAt),
      isActive: !['idle', 'done'].includes(a.state),
    });
  }
  const all = [...combined.values()].sort((a, b) => b.lastModified - a.lastModified);
  const active = all.filter((s) => s.isActive);
  const attention = all.filter((s) => {
    const activity = byId.get(s.id);
    return activity && sessionNeedsYouReason(activity) !== null;
  });
  const visible = filter === 'active' ? active : filter === 'attention' ? attention : all;
  const selectedPreview = preview
    ? (combined.get(preview.id) ?? preview)
    : search.active
      ? search.results[0]
        ? {
            ...combined.get(search.results[0].sessionId),
            id: search.results[0].sessionId,
            summary: search.results[0].summary || '',
            lastModified: search.results[0].updatedAt,
          }
        : null
      : (visible[0] ?? null);
  const previewSession = useCallback((session: Session) => setPreview(session), []);
  function openSession(id: string) {
    selectionChanged();
    navigate(`/chat/${id}`);
  }
  function dismiss(id: string) {
    setRemoving(id);
  }

  async function handleRename(id: string, title: string) {
    if (await renameSession(id, title))
      setPreview((current) => (current?.id === id ? { ...current, summary: title } : current));
  }

  function handleQuickAction(action: QuickAction) {
    const path = action.path || '/chat';
    const params = new URLSearchParams();
    if (action.prompt) params.set('prompt', action.prompt);
    if (action.cwd) params.set('cwd', action.cwd);
    if (action.extraTools) params.set('extraTools', action.extraTools);
    const qs = params.toString();
    navigate(qs ? `${path}?${qs}` : path);
  }

  return (
    <div className="session-list-page workspace-page conversation-library">
      <header className="session-list-header">
        <div className="session-list-header-title">
          <h1>Chats</h1>
        </div>
        <div className="conversation-header-actions">
          <button
            className="hero-chat-btn workspace-primary"
            aria-label="New chat"
            onClick={() => {
              selectionChanged();
              navigate('/chat');
            }}
          >
            <UiIcon name="edit" size={16} />
            <span className="conversation-new-label">New chat</span>
          </button>
          <details className="conversation-options">
            <summary ref={conversationOptions} aria-label="Conversation options">
              <UiIcon name="more" />
            </summary>
            <div className="conversation-options-menu">
              <button
                onClick={(event) => {
                  event.currentTarget.closest('details')?.removeAttribute('open');
                  setImportOpen(true);
                }}
              >
                Import CLI conversation
              </button>
              {quickActions
                .filter((a) => !['Chat Session', 'Files', 'Deploy Mitzo'].includes(a.label))
                .map((a) => (
                  <button key={a.label} onClick={() => handleQuickAction(a)}>
                    {a.label}
                  </button>
                ))}
              <button
                onClick={async () => {
                  if (await clearAll()) {
                    search.clear();
                    setPreview(null);
                    setMobilePinPreview(null);
                  }
                }}
              >
                Archive all chats
              </button>
            </div>
          </details>
        </div>
      </header>
      <div className="conversation-search">
        <input
          type="search"
          aria-label="Search conversations"
          placeholder="Search conversations…"
          value={search.query}
          onChange={(e) => search.setQuery(e.target.value)}
        />
        {search.active && <button onClick={search.clear}>Clear search</button>}
      </div>
      {!search.active && (
        <div className="conversation-filters" aria-label="Conversation filters">
          <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            All
          </button>
          <button aria-pressed={filter === 'active'} onClick={() => setFilter('active')}>
            Active <span>{active.length}</span>
          </button>
          <button aria-pressed={filter === 'attention'} onClick={() => setFilter('attention')}>
            Needs you <span>{attention.length}</span>
          </button>
        </div>
      )}
      <ResizableSessionLayout
        preview={
          desktop && selectedPreview ? (
            <SessionInspector
              session={selectedPreview}
              onOpen={() => openSession(selectedPreview.id)}
              onActions={showActions}
            />
          ) : undefined
        }
      >
        <div className="session-list-scroll">
          <ConversationPins
            sessions={all}
            selectedId={desktop ? selectedPreview?.id : undefined}
            onSelect={(id, session) => {
              if (desktop) setPreview(session);
              else openSession(id);
            }}
            onPreview={desktop ? previewSession : undefined}
            onOpen={desktop ? openSession : undefined}
            onActions={(session, trigger, point) => {
              if (desktop) showActions(session, trigger, point);
              else setMobilePinPreview(session);
            }}
          />
          {drafts.length > 0 && (
            <Link to="/sessions/drafts" className="conversation-drafts-link">
              <UiIcon name="edit" />
              <span>
                <strong>Drafts</strong>
                <span className="workspace-muted">Pick up where you left off</span>
              </span>
              <span className="conversation-draft-count">{drafts.length}</span>
              <UiIcon name="forward" size={16} />
            </Link>
          )}
          {importOpen && (
            <SdkConversationImport
              onClose={() => {
                setImportOpen(false);
                conversationOptions.current?.focus();
              }}
              onImported={(id) => {
                setImportOpen(false);
                openSession(id);
              }}
            />
          )}
          {search.active ? (
            <div className="conversation-results" aria-live="polite">
              {!search.error && (
                <p className="conversation-list-caption">
                  {search.searching ? 'Searching…' : `${search.results.length} results`}
                </p>
              )}
              {search.error && (
                <div className="session-list-error" role="alert">
                  <span>{search.error}</span>
                  <button type="button" onClick={search.retry}>
                    Try again
                  </button>
                </div>
              )}
              {!search.searching && !search.error && search.results.length === 0 && (
                <p className="session-list-empty">No matching conversations</p>
              )}
              {search.results.map((r) => (
                <SwipeableSession
                  key={r.sessionId}
                  session={{
                    ...combined.get(r.sessionId),
                    id: r.sessionId,
                    summary: r.summary || '',
                    lastModified: r.updatedAt,
                  }}
                  snippet={r.snippet}
                  activity={byId.get(r.sessionId)}
                  onDismiss={dismiss}
                  desktop={desktop}
                  selected={desktop && selectedPreview?.id === r.sessionId}
                  onPreview={previewSession}
                  onActions={showActions}
                  onClick={openSession}
                  onRename={handleRename}
                />
              ))}
            </div>
          ) : (
            <>
              <p className="conversation-list-caption">
                {filter === 'all'
                  ? 'Recent conversations'
                  : filter === 'active'
                    ? 'In progress'
                    : 'Waiting for you'}
              </p>
              {loading && <p className="session-list-empty">Loading…</p>}
              {!loading && error && (
                <div className="session-list-error" role="alert">
                  <span>{error}</span>
                  <button type="button" onClick={retry}>
                    Try again
                  </button>
                </div>
              )}
              {!loading && !error && visible.length === 0 && (
                <p className="session-list-empty">
                  {filter === 'attention'
                    ? 'Nothing needs you right now'
                    : filter === 'active'
                      ? 'No active conversations'
                      : 'Start your first conversation'}
                </p>
              )}
              <div className="session-list">
                {visible.map((s) => (
                  <SwipeableSession
                    key={s.id}
                    session={s}
                    activity={byId.get(s.id)}
                    onDismiss={dismiss}
                    desktop={desktop}
                    selected={desktop && selectedPreview?.id === s.id}
                    onPreview={previewSession}
                    onActions={showActions}
                    onClick={openSession}
                    onRename={handleRename}
                  />
                ))}
              </div>
              {hasMore && filter === 'all' && (
                <button className="session-load-more" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : 'Load more conversations'}
                </button>
              )}
            </>
          )}
        </div>
      </ResizableSessionLayout>
      <SessionContextMenu
        state={menu}
        onClose={closeMenu}
        onOpen={() => {
          if (menu) openSession(menu.session.id);
          closeMenu();
        }}
        onRename={() => {
          if (menu) setRenaming(menu.session);
          closeMenu();
        }}
        onDelete={() => {
          if (menu) dismiss(menu.session.id);
          closeMenu();
        }}
        onDetails={() => {
          if (menu) setDetails(menu.session);
          closeMenu();
        }}
      />
      {renaming && (
        <SessionRenameDialog
          session={renaming}
          onSave={handleRename}
          onClose={() => setRenaming(null)}
        />
      )}
      {details && <SessionDetailsDialog session={details} onClose={() => setDetails(null)} />}
      {removing && (
        <SessionRemovalDialog
          sessionId={removing}
          onClose={() => setRemoving(null)}
          onRemove={async (options) => {
            const removed = await dismissSession(removing, options);
            if (removed) setPreview((current) => (current?.id === removing ? null : current));
            return removed;
          }}
        />
      )}
      {mobilePinPreview && (
        <SessionPreview
          session={mobilePinPreview}
          onClose={() => setMobilePinPreview(null)}
          onOpen={() => openSession(mobilePinPreview.id)}
          onRename={() => {
            setRenaming(mobilePinPreview);
            setMobilePinPreview(null);
          }}
          onDelete={() => {
            dismiss(mobilePinPreview.id);
            setMobilePinPreview(null);
          }}
        />
      )}
    </div>
  );
}

function activityLabel(activity: SessionActivity): string {
  if (activity.state === 'waiting') {
    return activity.waitReason === 'review'
      ? 'Review needed'
      : activity.waitReason === 'permission'
        ? 'Permission needed'
        : activity.waitReason === 'blocked'
          ? 'Blocked'
          : 'Needs attention';
  }
  return { init: 'Starting', working: 'Working', done: 'Finished', idle: 'Idle', paused: 'Paused' }[
    activity.state
  ];
}
