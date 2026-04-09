export interface StatusBarProps {
  connected: boolean;
  sessionId?: string;
  branch?: string;
  isWorktree?: boolean;
}

export function StatusBar({ connected, sessionId, branch, isWorktree }: StatusBarProps) {
  return (
    <div className="desktop-status-bar">
      <span className={`status-dot ${connected ? 'status-dot--on' : 'status-dot--off'}`} />
      <span className="status-label">{connected ? 'Connected' : 'Disconnected'}</span>
      {sessionId && (
        <span className="status-session" title={sessionId}>
          {sessionId.slice(0, 12)}
        </span>
      )}
      {branch && (
        <span className="status-branch">
          {isWorktree && <span className="status-wt-badge">WT</span>}
          {branch}
        </span>
      )}
    </div>
  );
}
