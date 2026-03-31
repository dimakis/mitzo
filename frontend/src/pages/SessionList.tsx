import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

interface Session {
  id: string;
  summary: string;
  lastModified: number;
  branch?: string;
}

const quickActions = [
  {
    label: 'Chat Session',
    desc: 'Interactive chat',
    path: '/chat',
  },
  {
    label: 'Morning Briefing',
    desc: 'Calendar, email, Jira',
    path: '/chat',
    prompt: 'Run `python command_center/morning_briefing.py` and summarize the output. I want to discuss it after.',
    extraTools: 'Bash',
  },
  {
    label: 'Jira Inbox',
    desc: 'Team inbox triage',
    path: '/chat',
    prompt: 'Run `python inbox.py --save` and summarize what needs my attention. I want to discuss it after.',
    cwd: '/Users/dsaridak/redhat/mgmt/team_home',
    extraTools: 'Bash',
  },
  {
    label: 'Team Status',
    desc: 'Manager status view',
    path: '/chat',
    prompt: 'Run `python status.py` and give me the highlights. I want to discuss the results after.',
    extraTools: 'Bash',
  },
  {
    label: 'Refresh Data',
    desc: 'Fetch Jira + dashboards',
    path: '/chat',
    prompt: 'Run `./refresh.sh` and report any errors.',
    extraTools: 'Bash',
  },
  {
    label: 'Jarvis Dev',
    desc: 'Work on command center',
    path: '/chat',
    cwd: '/Users/dsaridak/tools/agent-command-center',
  },
] as const;

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
    if ('extraTools' in action && action.extraTools) params.set('extraTools', action.extraTools);
    const qs = params.toString();
    navigate(qs ? `${action.path}?${qs}` : action.path);
  }

  return (
    <div className="session-list-page">
      <header className="session-list-header">
        <h1>Jarvis</h1>
        <button className="new-chat-btn" onClick={() => navigate('/chat')}>New Chat</button>
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

      {!loading && sessions.length === 0 && (
        <p className="session-list-empty">No past sessions</p>
      )}

      {!loading && sessions.length > 0 && (
        <div className="session-list">
          <div className="session-list-section-title">Recent Sessions</div>
          {sessions.map((s) => (
            <button
              key={s.id}
              className="session-item"
              onClick={() => navigate(`/chat/${s.id}`)}
            >
              <div className="session-item-content">
                <div className="session-item-summary">
                  {s.summary || 'Untitled session'}
                </div>
                <div className="session-item-meta">
                  <span className="session-item-time">
                    {formatRelativeTime(s.lastModified)}
                  </span>
                  {s.branch && (
                    <span className="session-item-branch">{s.branch}</span>
                  )}
                </div>
              </div>
              <span className="session-item-chevron">›</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
