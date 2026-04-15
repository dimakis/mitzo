import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Session } from '../types/chat';
import { formatRelativeTime } from '../lib/formatTime';
import { useLongPress } from '../hooks/useLongPress';
import { computeSwipeState, REVEAL_WIDTH } from '../lib/swipe-reveal';
import { EmptyState } from '../components/EmptyState';
import { useSessionList } from '../hooks/useSessionList';
import type { QuickAction } from '../hooks/useSessionList';
import { formatTokens } from '../lib/formatTokens';

function SwipeableSession({
  session,
  onDismiss,
  onClick,
  onRename,
}: {
  session: Session;
  onDismiss: (id: string) => void;
  onClick: (id: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const startX = useRef(0);
  const currentX = useRef(0);
  const swiping = useRef(false);
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
    currentX.current = startX.current;
    swiping.current = true;
    if (!editing) longPress.start();
  }

  function handleTouchMove(e: React.TouchEvent) {
    if (!swiping.current || !ref.current) return;
    currentX.current = e.touches[0].clientX;
    const dx = currentX.current - startX.current;
    // Cancel long-press on horizontal movement
    if (Math.abs(dx) > 10) longPress.cancel();

    if (revealed) {
      // When revealed, allow swiping back to close
      const offset = Math.min(0, -REVEAL_WIDTH + dx);
      ref.current.style.transform = `translateX(${offset}px)`;
    } else if (dx < 0) {
      // Clamp drag to reveal width
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
        onClick={handleClick}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {session.isActive && (
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
            <div className="session-item-summary">{session.summary || 'Untitled session'}</div>
          )}
          <div className="session-item-meta">
            <span className="session-item-hash">{session.id.slice(-6)}</span>
            <span className="session-item-time">{formatRelativeTime(session.lastModified)}</span>
            {session.branch && <span className="session-item-branch">{session.branch}</span>}
            {session.totalTokens != null && session.totalTokens > 0 && (
              <span className="session-item-tokens">{formatTokens(session.totalTokens)}</span>
            )}
          </div>
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
    <div className="session-list-page">
      <header className="session-list-header">
        <h1>Mitzo</h1>
        <div className="session-list-header-actions">
          <button
            className="check-update-btn"
            onClick={checkForUpdates}
            disabled={checking}
            title="Check for server updates"
          >
            {checking ? '…' : '☁↑'}
          </button>
          <button className="refresh-ui-btn" onClick={refreshUI} title="Clear cache and reload">
            ↺
          </button>
        </div>
      </header>

      {updateAvailable && (
        <button className="update-banner" onClick={handleDeployAction}>
          Update available — Deploy Mitzo
        </button>
      )}

      <button className="hero-chat-btn" onClick={() => navigate('/chat')}>
        New Chat
      </button>

      {quickActions.length > 0 && (
        <div className="quick-list">
          {quickActions.map((action) => (
            <button
              key={action.label}
              type="button"
              className="quick-row"
              onClick={() => handleQuickAction(action)}
            >
              <span className="quick-row-label">{action.label}</span>
              <span className="quick-row-desc">{action.desc}</span>
              <span className="quick-row-chevron">&rsaquo;</span>
            </button>
          ))}
        </div>
      )}

      {loading && <p className="session-list-empty">Loading...</p>}

      {!loading && sessions.length === 0 && (
        <EmptyState icon={'\uD83D\uDCAC'} title="No past sessions" />
      )}

      {!loading && sessions.length > 0 && (
        <div className="session-list">
          <div className="session-list-section-header">
            <span className="session-list-section-title">Recent</span>
            <button className="session-list-clear" onClick={clearAll}>
              Clear
            </button>
          </div>
          {sessions.map((s) => (
            <SwipeableSession
              key={s.id}
              session={s}
              onDismiss={dismissSession}
              onClick={(id) => navigate(`/chat/${id}`)}
              onRename={handleRename}
            />
          ))}
          {hasMore && (
            <button className="session-load-more" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading...' : 'Load More'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
