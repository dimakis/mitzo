import { useSessionList } from '../hooks/useSessionList';
import { formatRelativeTime } from '../lib/formatTime';

export interface SessionPanelProps {
  activeSessionId: string | undefined;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
}

export function SessionPanel({ activeSessionId, onSelectSession, onNewChat }: SessionPanelProps) {
  const { sessions, loading, dismissSession } = useSessionList();

  return (
    <div className="session-panel">
      <button className="session-panel-new" onClick={onNewChat}>
        New Chat
      </button>

      {loading && <p className="session-panel-empty">Loading...</p>}

      {!loading && sessions.length === 0 && <p className="session-panel-empty">No sessions</p>}

      {!loading && sessions.length > 0 && (
        <div className="session-panel-list">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-panel-item${s.id === activeSessionId ? ' session-panel-item--active' : ''}`}
              onClick={() => onSelectSession(s.id)}
            >
              <div className="session-panel-item-text">
                <div className="session-panel-item-summary">{s.summary || 'Untitled session'}</div>
                <div className="session-panel-item-meta">
                  <span className="session-panel-item-time">
                    {formatRelativeTime(s.lastModified)}
                  </span>
                  {s.branch && <span className="session-panel-item-branch">{s.branch}</span>}
                </div>
              </div>
              <button
                className="session-panel-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  dismissSession(s.id);
                }}
                title="Delete session"
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
