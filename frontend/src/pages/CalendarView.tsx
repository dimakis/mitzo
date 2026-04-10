import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCalendarData, type CalendarEvent, type SprintInfo } from '../hooks/useCalendarData';

function toLocalDate(isoStr: string): string {
  // For all-day events the string is "YYYY-MM-DD"; for timed events "...T..."
  if (isoStr.includes('T')) {
    return new Date(isoStr).toISOString().slice(0, 10);
  }
  return isoStr.slice(0, 10);
}

function formatTime(isoStr: string): string {
  if (!isoStr.includes('T')) return '';
  const d = new Date(isoStr);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatDateHeader(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);

  const dayName = d.toLocaleDateString([], { weekday: 'short' });
  const monthDay = d.toLocaleDateString([], { month: 'short', day: 'numeric' });

  if (diff === 0) return `Today \u00b7 ${dayName} ${monthDay}`;
  if (diff === 1) return `Tomorrow \u00b7 ${dayName} ${monthDay}`;
  if (diff === -1) return `Yesterday \u00b7 ${dayName} ${monthDay}`;
  return `${dayName} ${monthDay}`;
}

function EventCard({ event }: { event: CalendarEvent }) {
  const [expanded, setExpanded] = useState(false);

  if (event.type === 'milestone') {
    return (
      <div className="cal-event cal-event-milestone" onClick={() => setExpanded(!expanded)}>
        <div className="cal-event-row">
          <span className="cal-event-badge cal-badge-milestone">Release</span>
          <span className="cal-event-title">{event.title}</span>
        </div>
        {expanded && (
          <div className="cal-event-detail">
            {event.ourFeatures != null && (
              <div className="cal-detail-line">
                {event.ourFeatures} of our features \u00b7 {event.totalFeatures} total
              </div>
            )}
            {event.daysAway != null && (
              <div className="cal-detail-line">
                {event.daysAway === 0
                  ? 'Today'
                  : event.daysAway > 0
                    ? `${event.daysAway}d away`
                    : `${Math.abs(event.daysAway)}d ago`}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // Meeting
  const time = formatTime(event.start);
  const endTime = formatTime(event.end);
  const timeStr = time && endTime ? `${time}\u2013${endTime}` : time;

  return (
    <div className="cal-event cal-event-meeting" onClick={() => setExpanded(!expanded)}>
      <div className="cal-event-row">
        {timeStr && <span className="cal-event-time">{timeStr}</span>}
        <span className="cal-event-title">{event.title}</span>
        {event.attendeeCount && event.attendeeCount > 1 && (
          <span className="cal-event-attendees">{event.attendeeCount}</span>
        )}
      </div>
      {expanded && (
        <div className="cal-event-detail">
          {event.location && <div className="cal-detail-line">{event.location}</div>}
          {event.attendees && event.attendees.length > 0 && (
            <div className="cal-detail-line cal-detail-attendees">
              {event.attendees.slice(0, 5).map((a) => (
                <span key={a} className="cal-attendee">
                  {a.split('@')[0]}
                </span>
              ))}
              {event.attendees.length > 5 && (
                <span className="cal-attendee cal-attendee-more">
                  +{event.attendees.length - 5}
                </span>
              )}
            </div>
          )}
          {event.hangoutLink && (
            <a
              className="cal-detail-link"
              href={event.hangoutLink}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              Join video call
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function SprintBar({ sprint }: { sprint: SprintInfo }) {
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

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export function CalendarView() {
  const navigate = useNavigate();
  const today = new Date().toISOString().slice(0, 10);
  const [baseDate, setBaseDate] = useState(today);
  const [viewDays, setViewDays] = useState(7);

  const { loading, events, sprints } = useCalendarData(baseDate, viewDays);

  // Group events by date
  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    // Initialize all days in range
    for (let i = 0; i < viewDays; i++) {
      const d = addDays(baseDate, i);
      map.set(d, []);
    }
    for (const evt of events) {
      const d = toLocalDate(evt.start);
      const existing = map.get(d);
      if (existing) {
        existing.push(evt);
      } else {
        map.set(d, [evt]);
      }
    }
    return map;
  }, [events, baseDate, viewDays]);

  const dates = useMemo(() => Array.from(eventsByDate.keys()).sort(), [eventsByDate]);

  function handlePrev() {
    setBaseDate(addDays(baseDate, -viewDays));
  }

  function handleNext() {
    setBaseDate(addDays(baseDate, viewDays));
  }

  function handleToday() {
    setBaseDate(today);
  }

  // Header date range label
  const startLabel = new Date(baseDate + 'T12:00:00').toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
  });
  const endLabel = new Date(addDays(baseDate, viewDays - 1) + 'T12:00:00').toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
  });

  return (
    <div className="cal-page">
      <header className="cal-header">
        <button className="cal-back" onClick={() => navigate('/')}>
          &lsaquo;
        </button>
        <div className="cal-header-center">
          <button className="cal-nav-prev" onClick={handlePrev}>
            &lsaquo;
          </button>
          <button className="cal-header-title" onClick={handleToday}>
            {startLabel} &ndash; {endLabel}
          </button>
          <button className="cal-nav-next" onClick={handleNext}>
            &rsaquo;
          </button>
        </div>
        <div className="cal-view-toggle">
          <button
            className={`cal-view-btn${viewDays === 1 ? ' cal-view-btn--active' : ''}`}
            onClick={() => setViewDays(1)}
          >
            Day
          </button>
          <button
            className={`cal-view-btn${viewDays === 7 ? ' cal-view-btn--active' : ''}`}
            onClick={() => setViewDays(7)}
          >
            Week
          </button>
        </div>
      </header>

      {sprints.length > 0 && (
        <div className="cal-sprints">
          {sprints.map((s) => (
            <SprintBar key={s.id} sprint={s} />
          ))}
        </div>
      )}

      {loading && (
        <div className="cal-loading">
          <div className="cal-loading-spinner" />
        </div>
      )}

      {!loading && (
        <div className="cal-body">
          {dates.map((dateStr) => {
            const dayEvents = eventsByDate.get(dateStr) ?? [];
            return (
              <div key={dateStr} className="cal-day">
                <div className="cal-day-header">{formatDateHeader(dateStr)}</div>
                {dayEvents.length === 0 && <div className="cal-day-empty">No events</div>}
                {dayEvents.map((evt) => (
                  <EventCard key={evt.id} event={evt} />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
