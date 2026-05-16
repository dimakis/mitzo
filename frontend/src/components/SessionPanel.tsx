import { useState, useCallback } from 'react';
import { useSessionList } from '../hooks/useSessionList';
import { useSessionOverview } from '../hooks/useSessionOverview';
import { ActiveSessionsList } from './ActiveSessionsList';
import { formatRelativeTime } from '../lib/formatTime';

export interface SessionPanelProps {
  activeSessionId: string | undefined;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
}

type ViewMode = 'active' | 'all';

const STORAGE_KEY = 'mitzo-session-view-mode';

function readViewMode(): ViewMode {
  try {
    return (localStorage.getItem(STORAGE_KEY) as ViewMode) || 'active';
  } catch {
    return 'active';
  }
}

export function SessionPanel({ activeSessionId, onSelectSession, onNewChat }: SessionPanelProps) {
  const { sessions, loading, dismissSession } = useSessionList();
  const { attendCount } = useSessionOverview();
  const [viewMode, setViewMode] = useState<ViewMode>(readViewMode);

  const switchView = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <div className="session-panel">
      <button className="session-panel-new" onClick={onNewChat}>
        New Chat
      </button>

      <div className="session-view-toggle">
        <button
          className={viewMode === 'active' ? 'active' : ''}
          onClick={() => switchView('active')}
        >
          Active
          {attendCount > 0 && <span className="session-view-badge">{attendCount}</span>}
        </button>
        <button className={viewMode === 'all' ? 'active' : ''} onClick={() => switchView('all')}>
          All
        </button>
      </div>

      {viewMode === 'active' ? (
        <ActiveSessionsList activeSessionId={activeSessionId} onSelectSession={onSelectSession} />
      ) : (
        <>
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
                  {s.isActive ? (
                    <span
                      className={`session-panel-dot${s.isAttached ? ' session-panel-dot--attached' : ' session-panel-dot--detached'}`}
                    />
                  ) : s.closedBy ? (
                    <span
                      className={`session-panel-status session-panel-status--${s.closedBy}`}
                      title={
                        s.closedBy === 'user'
                          ? 'Closed by you'
                          : s.closedBy === 'auto'
                            ? 'Auto-closed'
                            : 'Abandoned'
                      }
                    >
                      {s.closedBy === 'user'
                        ? '\u2713'
                        : s.closedBy === 'auto'
                          ? '\u23F9'
                          : '\u2205'}
                    </span>
                  ) : null}
                  <div className="session-panel-item-text">
                    <div className="session-panel-item-summary">
                      {s.summary || 'Untitled session'}
                    </div>
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
        </>
      )}
    </div>
  );
}
