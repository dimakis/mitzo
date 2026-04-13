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
      {sessionId && (
        <span className="status-session" title={sessionId}>
          {sessionId.slice(0, 12)}
        </span>
      )}
      {isWorktree && wtId && (
        <span className="status-wt-badge" title={`session: ${wtId}\nbranch: ${branch}`}>
          {wtId.slice(-6)}
        </span>
      )}
      {branch && <span className="status-branch">{branch}</span>}
    </div>
  );
}
