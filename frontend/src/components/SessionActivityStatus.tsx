import type { SessionActivity } from '@mitzo/protocol';
import { useActivityClock } from '../hooks/useActivityClock';
import { formatRelativeTime } from '../lib/formatTime';
import { elapsedTime, sessionActivityLabel } from '../lib/session-activity';
import './SessionActivityStatus.css';

export function ActivityBars() {
  return (
    <span className="session-activity-bars" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

export function SessionActivityStatus({
  activity,
  modifiedAt,
  connected = true,
}: {
  activity?: SessionActivity;
  modifiedAt: number;
  connected?: boolean;
}) {
  const now = useActivityClock();
  const running = activity?.state === 'working' || activity?.state === 'init';
  const label = activity
    ? !connected && running
      ? 'Reconnecting'
      : sessionActivityLabel(activity)
    : undefined;
  let at = activity?.lastMessageAt ?? modifiedAt;
  let stamp = `${activity?.lastMessageAt !== undefined ? 'Last message' : 'Updated'} ${formatRelativeTime(at)}`;
  if (activity && !connected) {
    at = activity.lastEventAt;
    stamp = `last seen ${formatRelativeTime(at)}`;
  } else if (running && activity?.turnStartedAt !== undefined) {
    at = activity.turnStartedAt;
    stamp = `elapsed ${elapsedTime(at, now)}`;
  } else if (activity?.state === 'waiting' && activity.stateChangedAt !== undefined) {
    at = activity.stateChangedAt;
    stamp = `waiting ${elapsedTime(at, now)}`;
  } else if (activity?.state === 'done' && activity.completedAt !== undefined) {
    at = activity.completedAt;
    stamp = `finished ${formatRelativeTime(at)}`;
  }
  return (
    <span
      className="session-activity-status"
      data-state={activity?.state}
      data-connected={connected}
    >
      {label && (
        <span className="session-activity-label">
          {running && connected && <ActivityBars />}
          {label}
        </span>
      )}
      {activity?.progress && (
        <span>
          {activity.progress.done}/{activity.progress.total} tasks
        </span>
      )}
      <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>
        {stamp}
      </time>
    </span>
  );
}
