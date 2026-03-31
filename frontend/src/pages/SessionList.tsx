import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

interface Session {
  id: string;
  summary: string;
  lastModified: string;
  branch?: string;
}

const quickActions = [
  {
    label: 'Chat Session',
    desc: 'Open a new interactive chat',
    path: '/chat',
  },
  {
    label: 'Morning Briefing',
    desc: 'Calendar, email, Jira summary',
    path: '/chat',
    prompt: 'Read CLAUDE.md then run: python command_center/morning_briefing.py. Summarize the output.',
  },
  {
    label: 'Jira Inbox',
    desc: 'Team inbox triage',
    path: '/chat',
    prompt:
      'Read CLAUDE.md then run: python team_home/inbox.py --save. Summarize what needs attention.',
    cwd: '/Users/dsaridak/redhat/mgmt/team_home',
  },
  {
    label: 'Team Status',
    desc: 'Manager status view',
    path: '/chat',
    prompt:
      'Read CLAUDE.md then run: python status.py. Give me the highlights.',
  },
] as const;

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function SessionList() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/sessions')
      .then((r) => r.json())
      .then((data) => setSessions(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function handleQuickAction(action: (typeof quickActions)[number]) {
    const params = new URLSearchParams();
    if ('prompt' in action && action.prompt) params.set('prompt', action.prompt);
    if ('cwd' in action && action.cwd) params.set('cwd', action.cwd);
    const qs = params.toString();
    navigate(qs ? `${action.path}?${qs}` : action.path);
  }

  return (
    <div className="session-list">
      <header className="session-list-header">
        <h1>Agent</h1>
        <button onClick={() => navigate('/chat')}>New Chat</button>
      </header>

      <div className="session-list-presets">
        {quickActions.map((action) => (
          <button
            key={action.label}
            type="button"
            className="preset-card"
            onClick={() => handleQuickAction(action)}
          >
            <span className="preset-card-label">{action.label}</span>
            <span className="preset-card-desc">{action.desc}</span>
          </button>
        ))}
      </div>

      {loading && <p className="session-list-empty">Loading...</p>}

      {!loading && sessions.length === 0 && (
        <p className="session-list-empty">No past sessions</p>
      )}

      {!loading && sessions.length > 0 && (
        <div className="session-list-items">
          {sessions.map((s) => (
            <button
              key={s.id}
              className="session-list-row"
              onClick={() => navigate(`/chat/${s.id}`)}
            >
              <div className="session-list-row-text">
                <span className="session-list-row-summary">
                  {s.summary || 'Untitled session'}
                </span>
                {s.branch && (
                  <span className="session-list-row-branch">{s.branch}</span>
                )}
              </div>
              <span className="session-list-row-time">
                {formatRelativeTime(s.lastModified)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
