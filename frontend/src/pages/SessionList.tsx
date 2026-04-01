import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

interface Session {
  id: string;
  summary: string;
  lastModified: number;
  branch?: string;
}

interface QuickAction {
  label: string;
  desc: string;
  path: string;
  prompt?: string;
  cwd?: string;
  extraTools?: string;
}

function buildQuickActions(repoPath: string): QuickAction[] {
  const actions: QuickAction[] = [
    { label: 'Chat Session', desc: 'Interactive chat', path: '/chat' },
    {
      label: 'Morning Briefing',
      desc: 'Calendar, email, Jira',
      path: '/chat',
      prompt:
        'Run `python command_center/morning_briefing.py` and summarize the output. I want to discuss it after.',
      extraTools: 'Bash',
    },
    {
      label: 'Team Status',
      desc: 'Manager status view',
      path: '/chat',
      prompt:
        'Run `python status.py` and give me the highlights. I want to discuss the results after.',
      extraTools: 'Bash',
    },
    {
      label: 'Refresh Data',
      desc: 'Fetch Jira + dashboards',
      path: '/chat',
      prompt: 'Run `./refresh.sh` and report any errors.',
      extraTools: 'Bash',
    },
  ];

  if (repoPath) {
    actions.splice(2, 0, {
      label: 'Jira Inbox',
      desc: 'Team inbox triage',
      path: '/chat',
      prompt:
        'Run `python inbox.py --save` and summarize what needs my attention. I want to discuss it after.',
      cwd: `${repoPath}/team_home`,
      extraTools: 'Bash',
    });
  }

  return actions;
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
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

export function SessionList() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [quickActions, setQuickActions] = useState<QuickAction[]>(buildQuickActions(''));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/sessions')
        .then((r) => r.json())
        .catch(() => []),
      fetch('/api/config')
        .then((r) => r.json())
        .catch(() => ({})),
    ])
      .then(([sessData, config]) => {
        setSessions(sessData);
        if (config.repoPath) setQuickActions(buildQuickActions(config.repoPath));
      })
      .finally(() => setLoading(false));
  }, []);

  function dismissSession(id: string) {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    fetch(`/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  }

  function clearAll() {
    setSessions([]);
    fetch('/api/sessions', { method: 'DELETE' }).catch(() => {});
  }

  function handleQuickAction(action: QuickAction) {
    const params = new URLSearchParams();
    if (action.prompt) params.set('prompt', action.prompt);
    if (action.cwd) params.set('cwd', action.cwd);
    if (action.extraTools) params.set('extraTools', action.extraTools);
    const qs = params.toString();
    navigate(qs ? `${action.path}?${qs}` : action.path);
  }

  return (
    <div className="session-list-page">
      <header className="session-list-header">
        <h1>Mitzo</h1>
        <button className="new-chat-btn" onClick={() => navigate('/chat')}>
          New Chat
        </button>
      </header>

      <div className="quick-grid">
        {quickActions.map((action) => (
          <button
            key={action.label}
            type="button"
            className="quick-card"
            onClick={() => handleQuickAction(action)}
          >
            <span className="quick-card-label">{action.label}</span>
            <span className="quick-card-desc">{action.desc}</span>
          </button>
        ))}
      </div>

      {loading && <p className="session-list-empty">Loading...</p>}

      {!loading && sessions.length === 0 && <p className="session-list-empty">No past sessions</p>}

      {!loading && sessions.length > 0 && (
        <div className="session-list">
          <div className="session-list-section-header">
            <span className="session-list-section-title">Recent Sessions</span>
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
