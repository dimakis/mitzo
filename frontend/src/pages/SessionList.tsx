import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Session } from '../types/chat';
import { formatRelativeTime } from '../lib/formatTime';

interface QuickAction {
  label: string;
  desc: string;
  path?: string;
  prompt?: string;
  cwd?: string;
  extraTools?: string;
}

const DEFAULT_ACTIONS: QuickAction[] = [
  { label: 'Chat Session', desc: 'Interactive chat', path: '/chat' },
  { label: 'Files', desc: 'Browse repo files', path: '/files' },
];

function buildQuickActions(serverActions: QuickAction[] | undefined): QuickAction[] {
  if (!serverActions || serverActions.length === 0) return DEFAULT_ACTIONS;
  const actions: QuickAction[] = [
    { label: 'Chat Session', desc: 'Interactive chat', path: '/chat' },
    ...serverActions,
    { label: 'Files', desc: 'Browse repo files', path: '/files' },
  ];
  return actions;
}

function SwipeableSession({
  session,
  onDismiss,
  onClick,
}: {
  session: Session;
  onDismiss: (id: string) => void;
  onClick: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const startX = useRef(0);
  const currentX = useRef(0);
  const swiping = useRef(false);

  function handleTouchStart(e: React.TouchEvent) {
    startX.current = e.touches[0].clientX;
    currentX.current = startX.current;
    swiping.current = true;
  }

  function handleTouchMove(e: React.TouchEvent) {
    if (!swiping.current || !ref.current) return;
    currentX.current = e.touches[0].clientX;
    const dx = currentX.current - startX.current;
    if (dx < 0) {
      ref.current.style.transform = `translateX(${dx}px)`;
      ref.current.style.opacity = `${Math.max(0, 1 + dx / 200)}`;
    }
  }

  function handleTouchEnd() {
    if (!swiping.current || !ref.current) return;
    swiping.current = false;
    const dx = currentX.current - startX.current;
    if (dx < -100) {
      ref.current.style.transition = 'transform 0.2s, opacity 0.2s';
      ref.current.style.transform = 'translateX(-100%)';
      ref.current.style.opacity = '0';
      setTimeout(() => onDismiss(session.id), 200);
    } else {
      ref.current.style.transition = 'transform 0.2s, opacity 0.2s';
      ref.current.style.transform = 'translateX(0)';
      ref.current.style.opacity = '1';
      setTimeout(() => {
        if (ref.current) ref.current.style.transition = '';
      }, 200);
    }
  }

  return (
    <div
      ref={ref}
      className="session-item"
      onClick={() => onClick(session.id)}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <div className="session-item-content">
        <div className="session-item-summary">{session.summary || 'Untitled session'}</div>
        <div className="session-item-meta">
          <span className="session-item-time">{formatRelativeTime(session.lastModified)}</span>
          {session.branch && <span className="session-item-branch">{session.branch}</span>}
        </div>
      </div>
      <span className="session-item-chevron">&rsaquo;</span>
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
  const [sessions, setSessions] = useState<Session[]>([]);
  const [quickActions, setQuickActions] = useState<QuickAction[]>(DEFAULT_ACTIONS);
  const [loading, setLoading] = useState(true);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch('/api/sessions')
        .then((r) => r.json())
        .catch(() => []),
      fetch('/api/config')
        .then((r) => r.json())
        .catch(() => ({})),
      fetch('/api/version')
        .then((r) => r.json())
        .catch(() => ({})),
    ])
      .then(([sessData, config, version]) => {
        setSessions(sessData);
        setQuickActions(buildQuickActions(config.quickActions));
        if (version?.updateAvailable) setUpdateAvailable(true);
      })
      .finally(() => setLoading(false));
  }, []);

  async function checkForUpdates() {
    setChecking(true);
    try {
      const res = await fetch('/api/version/check', { method: 'POST' });
      const data = await res.json();
      setUpdateAvailable(data.updateAvailable);
    } catch {
      // Network error — ignore
    } finally {
      setChecking(false);
    }
  }

  function handleDeployAction() {
    const deploy = quickActions.find((a) => a.label === 'Deploy Mitzo');
    if (deploy) handleQuickAction(deploy);
  }

  function dismissSession(id: string) {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    fetch(`/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {
      // Best-effort server-side dismiss — UI already updated
    });
  }

  function clearAll() {
    setSessions([]);
    fetch('/api/sessions', { method: 'DELETE' }).catch(() => {
      // Best-effort server-side clear — UI already updated
    });
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
            {checking ? '…' : '⟳'}
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

      {!loading && sessions.length === 0 && <p className="session-list-empty">No past sessions</p>}

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
            />
          ))}
        </div>
      )}
    </div>
  );
}
