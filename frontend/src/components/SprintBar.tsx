import type { SprintInfo } from '../hooks/useCalendarData';

export function SprintBar({ sprint }: { sprint: SprintInfo }) {
  return (
    <div className="cal-sprint">
      <span className="cal-sprint-label">{sprint.title}</span>
      <span className="cal-sprint-dates">
        {new Date(sprint.start + 'T12:00:00').toLocaleDateString([], {
          month: 'short',
          day: 'numeric',
        })}
        {' \u2013 '}
        {new Date(sprint.end + 'T12:00:00').toLocaleDateString([], {
          month: 'short',
          day: 'numeric',
        })}
      </span>
    </div>
  );
}
