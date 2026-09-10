import { sessionAttentionReason } from '../lib/session-attention';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Session } from '../types/chat';
import { formatRelativeTime } from '../lib/formatTime';
import { useLongPress } from '../hooks/useLongPress';
import { computeSwipeState, REVEAL_WIDTH } from '../lib/swipe-reveal';
import { selectionChanged } from '../lib/haptics';
import { MitzoLogo } from '../components/MitzoLogo';
import { useSessionList } from '../hooks/useSessionList';
import type { QuickAction } from '../hooks/useSessionList';
import { formatTokens } from '../lib/formatTokens';
import { useSessionSearch } from '../hooks/useSessionSearch';
import { useSessionOverview, type SessionActivity } from '../hooks/useSessionOverview';
import { UiIcon } from '../components/UiIcon';

function SwipeableSession({
  session,
  activity,
  onDismiss,
  onClick,
  onRename,
}: {
  session: Session;
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
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [revealed, setRevealed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const enterEditMode = useCallback(() => {
    setEditValue(session.summary || '');
    setEditing(true);
  }, [session.summary]);

  const longPress = useLongPress(enterEditMode);

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
    ref.current.style.transition = 'transform 0.2s';
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
    if (!ref.current) return;
    ref.current.style.transition = 'transform 0.2s, opacity 0.2s';
    ref.current.style.transform = 'translateX(-100%)';
    ref.current.style.opacity = '0';
    setTimeout(() => onDismiss(session.id), 200);
  }

  function handleTouchStart(e: React.TouchEvent) {
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
    currentX.current = startX.current;
    swiping.current = true;
    directionLocked.current = null;
    if (!editing) longPress.start();
  }

  function handleTouchMove(e: React.TouchEvent) {
    if (!swiping.current || !ref.current) return;
    currentX.current = e.touches[0].clientX;
    const dx = currentX.current - startX.current;
    const dy = e.touches[0].clientY - startY.current;

    if (!directionLocked.current && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      directionLocked.current = Math.abs(dy) > Math.abs(dx) ? 'vertical' : 'horizontal';
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

  function handleClick() {
    if (longPress.didFire() || editing) return;
    if (revealed) {
      closeReveal();
      return;
    }
    onClick(session.id);
  }

  return (
    <div className="session-item-wrapper">
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
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
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
              role="link"
              tabIndex={0}
              aria-label={`Open ${session.summary || 'Untitled conversation'}`}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  handleClick();
                }
              }}
              onClick={handleClick}
            >
              <div className="session-item-summary">
                {session.summary || 'Untitled conversation'}
              </div>
              <div className="session-item-meta">
                {activity && (
                  <span className={`conversation-state conversation-state--${activity.state}`}>
                    {activityLabel(activity)}
                  </span>
                )}
                {!activity && session.isActive && (
                  <span className="conversation-state">Active</span>
                )}
                <span className="session-item-time">
                  {formatRelativeTime(session.lastModified)}
                </span>
                {activity?.repo && <span className="conversation-repo">{activity.repo}</span>}
              </div>
            </div>
          )}
          <details
            className="conversation-details"
            onClick={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <summary aria-label={`Details for ${session.summary || 'Untitled conversation'}`}>
              <UiIcon name="more" />
            </summary>
            <div className="conversation-details-body">
              <div>
                Session <span className="session-item-hash">{session.id}</span>
              </div>
              {session.branch && <div>Branch: {session.branch}</div>}
              {session.totalTokens != null && session.totalTokens > 0 && (
                <div className="session-item-tokens">
                  {formatTokens(session.totalTokens)} tokens
                </div>
              )}
              <button onClick={enterEditMode}>Rename</button>
              <button onClick={handleDeleteTap}>Delete conversation</button>
            </div>
          </details>
        </div>
        {!editing && <span className="session-item-chevron">&rsaquo;</span>}
      </div>
    </div>
  );
}

async function refreshUI() {
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  }
  location.reload();
}

export function SessionList() {
  const navigate = useNavigate();
  const {
    sessions,
    quickActions,
    loading,
    loadingMore,
    hasMore,
    updateAvailable,
    checking,
    dismissSession,
    clearAll,
    handleRename,
    checkForUpdates,
    loadMore,
  } = useSessionList();
  const search = useSessionSearch();

  const { activities } = useSessionOverview();
  const [filter, setFilter] = useState<'all' | 'active' | 'attention'>('all');
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
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
  const all = [...combined.values()]
    .filter((s) => !dismissed.has(s.id))
    .sort((a, b) => b.lastModified - a.lastModified);
  const active = all.filter((s) => s.isActive);
  const attention = all.filter((s) => {
    const activity = byId.get(s.id);
    return activity && sessionAttentionReason(activity) !== null;
  });
  const visible = filter === 'active' ? active : filter === 'attention' ? attention : all;
  function openSession(id: string) {
    selectionChanged();
    navigate(`/chat/${id}`);
  }
  function dismiss(id: string) {
    setDismissed((prev) => new Set([...prev, id]));
    dismissSession(id);
  }

  function handleDeployAction() {
    const deploy = quickActions.find((a) => a.label === 'Deploy Mitzo');
    if (deploy) handleQuickAction(deploy);
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
          <MitzoLogo />
          <h1>Chats</h1>
        </div>
        <div className="conversation-header-actions">
          <button
            className="hero-chat-btn workspace-primary"
            onClick={() => {
              selectionChanged();
              navigate('/chat');
            }}
          >
            + New chat
          </button>
          <details className="conversation-options">
            <summary aria-label="Conversation options">
              <UiIcon name="more" />
            </summary>
            <div className="conversation-options-menu">
              <button onClick={checkForUpdates} disabled={checking}>
                {checking ? 'Checking…' : 'Check for updates'}
              </button>
              <button onClick={refreshUI}>Reload interface</button>
              {quickActions
                .filter((a) => !['Chat Session', 'Files'].includes(a.label))
                .map((a) => (
                  <button key={a.label} onClick={() => handleQuickAction(a)}>
                    {a.label}
                  </button>
                ))}
              <button
                onClick={() => {
                  setDismissed(new Set(all.map((s) => s.id)));
                  search.clear();
                  clearAll();
                }}
              >
                Clear conversation history
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
            Needs attention <span>{attention.length}</span>
          </button>
        </div>
      )}
      <div className="session-list-scroll">
        {updateAvailable && (
          <button className="update-banner" onClick={handleDeployAction}>
            Update available — Deploy Mitzo
          </button>
        )}
        {search.active ? (
          <div className="conversation-results" aria-live="polite">
            <p className="conversation-list-caption">
              {search.searching ? 'Searching…' : `${search.results.length} results`}
            </p>
            {!search.searching && search.results.length === 0 && (
              <p className="session-list-empty">No matching conversations</p>
            )}
            {search.results.map((r) => (
              <button
                className="conversation-result"
                key={r.sessionId}
                onClick={() => openSession(r.sessionId)}
              >
                <span className="session-item-summary">{r.summary || 'Untitled conversation'}</span>
                <span className="conversation-result-snippet">{r.snippet}</span>
                <span className="session-item-time">{formatRelativeTime(r.updatedAt)}</span>
              </button>
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
            {!loading && visible.length === 0 && (
              <p className="session-list-empty">
                {filter === 'attention'
                  ? 'Nothing needs your attention'
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
    </div>
  );
}

function activityLabel(activity: SessionActivity): string {
  const reason = sessionAttentionReason(activity);
  if (reason === 'awaiting-reply') return 'Awaiting reply';
  if (reason === 'uncommitted-work') return 'Uncommitted work';
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
