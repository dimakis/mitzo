import { UiIcon, type UiIconName } from './UiIcon';
import { sessionStatusIcons } from '../lib/status-icons';
import { useCallback } from 'react';
import {
  useSessionOverview,
  type SessionActivity,
  type SessionActivityState,
} from '../hooks/useSessionOverview';

const STATE_CONFIG: Record<
  SessionActivityState,
  { icon: UiIconName; color: string; label: string }
> = {
  init: { icon: sessionStatusIcons.init, color: 'var(--color-muted)', label: 'init' },
  working: { icon: sessionStatusIcons.working, color: 'var(--color-accent)', label: 'working' },
  waiting: { icon: sessionStatusIcons.waiting, color: 'var(--color-danger)', label: 'waiting' },
  done: { icon: sessionStatusIcons.done, color: 'var(--color-success)', label: 'done' },
  idle: { icon: sessionStatusIcons.idle, color: 'var(--color-muted)', label: 'idle' },
  paused: { icon: sessionStatusIcons.paused, color: 'var(--color-muted)', label: 'paused' },
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
        <UiIcon name={config.icon} />
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
