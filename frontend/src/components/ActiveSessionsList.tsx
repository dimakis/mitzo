import { useSessionInteraction, type SessionActionPoint } from '../hooks/useSessionInteraction';
import { UiIcon } from './UiIcon';
import { SessionActivityStatus } from './SessionActivityStatus';
import { useSessionOrder } from '../hooks/useSessionOrder';
import { sessionStatusIcons } from '../lib/status-icons';
import { useCallback } from 'react';
import { useSessionOverview, type SessionActivity } from '../hooks/useSessionOverview';

function ActivityCard({
  activity,
  isActive,
  onTap,
  onActions,
  connected,
}: {
  activity: SessionActivity;
  isActive: boolean;
  onTap: (sessionId: string) => void;
  onActions?: (activity: SessionActivity, trigger: HTMLElement, point?: SessionActionPoint) => void;
  connected?: boolean;
}) {
  const handlers = useSessionInteraction(
    () => onTap(activity.sessionId),
    (trigger, point) => onActions?.(activity, trigger, point),
  );

  return (
    <button
      className={`cc-card cc-card--${activity.state}${isActive ? ' cc-card--current' : ''}`}
      {...(onActions ? handlers : { onClick: () => onTap(activity.sessionId) })}
    >
      <span className="cc-card-icon">
        <UiIcon name={sessionStatusIcons[activity.state]} />
      </span>
      <div className="cc-card-content">
        <div className="cc-card-title">{activity.title}</div>
        <div className="cc-card-meta">
          <SessionActivityStatus
            activity={activity}
            modifiedAt={activity.lastMessageAt ?? activity.lastEventAt}
            connected={connected}
          />
        </div>
      </div>
    </button>
  );
}

export interface ActiveSessionsListProps {
  paused?: boolean;
  activeSessionId?: string;
  onSelectSession: (id: string) => void;
  onActions?: (activity: SessionActivity, trigger: HTMLElement, point?: SessionActionPoint) => void;
}

export function ActiveSessionsList({
  paused = false,
  activeSessionId,
  onSelectSession,
  onActions,
}: ActiveSessionsListProps) {
  const { activities, attendCount, connected, lastKnownActivities = [] } = useSessionOverview();

  const display = connected === false ? lastKnownActivities : activities;
  const byId = new Map(display.map((a) => [a.sessionId, a]));
  const ordered = useSessionOrder(
    display.map((a) => ({
      id: a.sessionId,
      summary: a.title,
      lastModified: a.lastMessageAt ?? a.lastEventAt,
    })),
    activities,
    paused || connected === false,
  );
  const visible = ordered
    .map((s) => byId.get(s.id)!)
    .filter((a) => a.state !== 'idle' && a.state !== 'init');

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
          onActions={onActions}
          connected={connected}
        />
      ))}
    </div>
  );
}
