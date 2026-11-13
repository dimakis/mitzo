import { useSessionInteraction, type SessionActionPoint } from '../hooks/useSessionInteraction';
import { ConversationUnreadDot } from './ConversationUnreadDot';
import { SessionActivityStatus } from './SessionActivityStatus';
import { useSessionOrdering } from '../hooks/useSessionOrder';
import { MotionList } from './MotionList';
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
      data-motion-key={activity.sessionId}
      {...(onActions ? handlers : { onClick: () => onTap(activity.sessionId) })}
    >
      <ConversationUnreadDot
        session={{
          id: activity.sessionId,
          summary: activity.title,
          lastModified: activity.lastEventAt,
          replyReadState: activity.replyReadState,
        }}
      />
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
  ordering?: Pick<ReturnType<typeof useSessionOrdering>, 'sessions' | 'groups'>;
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
  ordering,
}: ActiveSessionsListProps) {
  const { activities, attendCount, connected, lastKnownActivities = [] } = useSessionOverview();

  const display = connected === false ? lastKnownActivities : activities;
  const byId = new Map(display.map((a) => [a.sessionId, a]));
  const ownOrdering = useSessionOrdering(
    display.map((a) => ({
      id: a.sessionId,
      summary: a.title,
      lastModified: a.lastMessageAt ?? a.lastEventAt,
    })),
    activities,
    paused || connected === false || ordering !== undefined,
    { grouped: true },
  );
  const { sessions: ordered, groups } = ordering ?? ownOrdering;
  const visible = ordered
    .map((s) => byId.get(s.id)!)
    .filter((a) => a && a.state !== 'idle' && a.state !== 'init');

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
      <MotionList className="active-session-rows" scrollSelector=".active-sessions-list">
        {visible.flatMap((a, index) => [
          ...(index === 0 || groups.get(a.sessionId) !== groups.get(visible[index - 1].sessionId)
            ? [
                <h2 key={`group-${groups.get(a.sessionId)}`} className="session-list-group-title">
                  {groups.get(a.sessionId) === 0 ? 'In progress' : 'Finished'}
                </h2>,
              ]
            : []),
          <ActivityCard
            key={a.sessionId}
            activity={a}
            isActive={a.sessionId === activeSessionId}
            onTap={handleTap}
            onActions={onActions}
            connected={connected}
          />,
        ])}
      </MotionList>
    </div>
  );
}
