import { useCallback } from 'react';
import {
  useSessionOverview,
  type SessionActivity,
  type SessionActivityState,
} from '../hooks/useSessionOverview';

const STATE_CONFIG: Record<SessionActivityState, { icon: string; color: string; label: string }> = {
  init: { icon: '\u25CB', color: '#888', label: 'init' },
  working: { icon: '\u25CF', color: '#b48cff', label: 'working' },
  waiting: { icon: '\u26A0', color: '#ff6d6d', label: 'waiting' },
  done: { icon: '\u2713', color: '#4ade80', label: 'done' },
  idle: { icon: '\u25CB', color: '#555', label: 'idle' },
  paused: { icon: '\u23F8', color: '#888', label: 'paused' },
};

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function ActivityCard({
  activity,
  isActive,
  onTap,
}: {
  activity: SessionActivity;
  isActive: boolean;
  onTap: (sessionId: string) => void;
}) {
  const config = STATE_CONFIG[activity.state];
  const elapsed = Date.now() - activity.lastEventAt;

  let metaText = config.label;
  if (activity.waitReason === 'permission') metaText = 'permission';
  else if (activity.waitReason === 'review') metaText = 'review needed';
  else if (activity.waitReason === 'blocked') metaText = 'blocked';
  if (activity.progress) {
    metaText += ` \u00B7 ${activity.progress.done}/${activity.progress.total}`;
  }
  metaText += ` \u00B7 ${formatElapsed(elapsed)}`;

  return (
    <button
      className={`cc-card cc-card--${activity.state}${isActive ? ' cc-card--current' : ''}`}
      onClick={() => onTap(activity.sessionId)}
    >
      <span className="cc-card-icon" style={{ color: config.color }}>
        {config.icon}
      </span>
      <div className="cc-card-content">
        <div className="cc-card-title">
          {activity.repo && <span className="cc-card-repo">{activity.repo}:</span>} {activity.title}
        </div>
        <div className="cc-card-meta">{metaText}</div>
      </div>
    </button>
  );
}

export interface ActiveSessionsListProps {
  activeSessionId?: string;
  onSelectSession: (id: string) => void;
}

export function ActiveSessionsList({ activeSessionId, onSelectSession }: ActiveSessionsListProps) {
  const { activities, attendCount } = useSessionOverview();

  const visible = activities.filter((a) => a.state !== 'idle' && a.state !== 'init');

  const handleTap = useCallback(
    (sessionId: string) => {
      onSelectSession(sessionId);
    },
    [onSelectSession],
  );

  if (visible.length === 0) {
    return <p className="session-panel-empty">No active sessions</p>;
  }

  return (
    <div className="active-sessions-list">
      {attendCount > 0 && (
        <div className="active-sessions-summary">
          {attendCount} need{attendCount === 1 ? 's' : ''} attention
        </div>
      )}
      {visible.map((a) => (
        <ActivityCard
          key={a.sessionId}
          activity={a}
          isActive={a.sessionId === activeSessionId}
          onTap={handleTap}
        />
      ))}
    </div>
  );
}
