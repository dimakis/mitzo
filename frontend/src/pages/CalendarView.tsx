import { useState, useMemo } from 'react';
import { useCalendarData, type CalendarEvent } from '../hooks/useCalendarData';
import { EventCard } from '../components/EventCard';
import { SprintBar } from '../components/SprintBar';
import { PageHeader } from '../components/PageHeader';

function toLocalDate(isoStr: string): string {
  if (isoStr.includes('T')) {
    const d = new Date(isoStr);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return isoStr.slice(0, 10);
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

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function getToday(): string {
  return new Date().toISOString().slice(0, 10);
}

const DEFAULT_VIEW_DAYS = 7;

export function CalendarView() {
  const [baseDate, setBaseDate] = useState(getToday);
  const [viewDays, setViewDays] = useState(DEFAULT_VIEW_DAYS);
  const [filterMode, setFilterMode] = useState<'all' | 'releases'>('all');
  const [savedViewDays, setSavedViewDays] = useState(DEFAULT_VIEW_DAYS);

  const { loading, events, sprints } = useCalendarData(baseDate, viewDays);

  // Filter events based on filter mode
  const filteredEvents = useMemo(() => {
    if (filterMode === 'releases') {
      return events.filter((e) => e.type === 'milestone');
    }
    return events;
  }, [events, filterMode]);

  // Group events by date
  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (let i = 0; i < viewDays; i++) {
      const d = addDays(baseDate, i);
      map.set(d, []);
    }
    for (const evt of filteredEvents) {
      const d = toLocalDate(evt.start);
      const existing = map.get(d);
      if (existing) {
        existing.push(evt);
      } else {
        map.set(d, [evt]);
      }
    }
    return map;
  }, [filteredEvents, baseDate, viewDays]);

  const dates = useMemo(() => Array.from(eventsByDate.keys()).sort(), [eventsByDate]);

  const navStep = filterMode === 'releases' ? 30 : viewDays;

  function handlePrev() {
    setBaseDate(addDays(baseDate, -navStep));
  }

  function handleNext() {
    setBaseDate(addDays(baseDate, navStep));
  }

  function handleToday() {
    setBaseDate(getToday());
  }

  function handleFilterAll() {
    setFilterMode('all');
    setViewDays(savedViewDays);
  }

  function handleFilterReleases() {
    if (filterMode !== 'releases') {
      setSavedViewDays(viewDays);
    }
    setFilterMode('releases');
    setViewDays(90);
  }

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
      <PageHeader
        title="Calendar"
        center={
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
        }
      >
        <div className="cal-view-toggle">
          <button
            className={`cal-view-btn${viewDays === 1 ? ' cal-view-btn--active' : ''}`}
            disabled={filterMode === 'releases'}
            onClick={() => setViewDays(1)}
          >
            Day
          </button>
          <button
            className={`cal-view-btn${viewDays === 7 ? ' cal-view-btn--active' : ''}`}
            disabled={filterMode === 'releases'}
            onClick={() => setViewDays(7)}
          >
            Week
          </button>
        </div>
        <div className="cal-filter-toggle cal-view-toggle">
          <button
            className={`cal-view-btn${filterMode === 'all' ? ' cal-view-btn--active' : ''}`}
            onClick={handleFilterAll}
          >
            All
          </button>
          <button
            className={`cal-view-btn${filterMode === 'releases' ? ' cal-view-btn--active' : ''}`}
            onClick={handleFilterReleases}
          >
            Releases
          </button>
        </div>
      </PageHeader>

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
