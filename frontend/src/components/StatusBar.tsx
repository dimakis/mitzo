export interface StatusBarProps {
  connected: boolean;
  sessionId?: string;
  branch?: string;
  isWorktree?: boolean;
  wtId?: string;
}

export function StatusBar({ connected, sessionId, branch, isWorktree, wtId }: StatusBarProps) {
  return (
    <div className="desktop-status-bar">
      <span className={`status-dot ${connected ? 'status-dot--on' : 'status-dot--off'}`} />
      <span className="status-label">{connected ? 'Connected' : 'Disconnected'}</span>
      {(branch || isWorktree) && (
        <span className="status-workspace">
          {isWorktree ? 'Isolated workspace' : `Branch: ${branch}`}
        </span>
      )}
      {(sessionId || branch || wtId) && (
        <details className="status-details">
          <summary>Session details</summary>
          <dl>
            {sessionId && (
              <>
                <dt>Session ID</dt>
                <dd>{sessionId}</dd>
              </>
            )}
            {branch && (
              <>
                <dt>Branch</dt>
                <dd>{branch}</dd>
              </>
            )}
            {wtId && (
              <>
                <dt>Worktree ID</dt>
                <dd>{wtId}</dd>
              </>
            )}
          </dl>
        </details>
      )}
    </div>
  );
}
