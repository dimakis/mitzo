import { useState, useMemo, useRef, type ComponentProps } from 'react';
import { useCalendarData, type CalendarEvent } from '../hooks/useCalendarData';
import { EventCard } from '../components/EventCard';
import { SprintBar } from '../components/SprintBar';
import { PageHeader } from '../components/PageHeader';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';

function DesktopCalendarHeader({ center, children }: ComponentProps<typeof PageHeader>) {
  return (
    <header className="cal-desktop-toolbar" aria-label="Calendar controls">
      {center}
      <div className="cal-desktop-filters">{children}</div>
    </header>
  );
}

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

export function CalendarView({ desktop = false }: { desktop?: boolean } = {}) {
  const agendaRef = useRef<HTMLDivElement>(null);
  const Header = desktop ? DesktopCalendarHeader : PageHeader;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [baseDate, setBaseDate] = useState(getToday);
  const [viewDays, setViewDays] = useState(DEFAULT_VIEW_DAYS);
  const [filterMode, setFilterMode] = useState<'all' | 'releases'>('all');
  const [savedViewDays, setSavedViewDays] = useState(DEFAULT_VIEW_DAYS);

  const { loading, events, sprints, error } = useCalendarData(baseDate, viewDays);

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
    setSelectedId(null);
    setBaseDate(addDays(baseDate, -navStep));
  }

  function handleNext() {
    setSelectedId(null);
    setBaseDate(addDays(baseDate, navStep));
  }

  function handleToday() {
    setSelectedId(null);
    setBaseDate(getToday());
  }

  function handleFilterAll() {
    setSelectedId(null);
    setFilterMode('all');
    setViewDays(savedViewDays);
  }

  function handleFilterReleases() {
    setSelectedId(null);
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

  const visibleDates =
    desktop && filterMode === 'releases'
      ? dates.filter((date) => (eventsByDate.get(date)?.length ?? 0) > 0)
      : dates;
  const selected = !loading ? filteredEvents.find((event) => event.id === selectedId) : undefined;
  return (
    <div
      className={`cal-page${desktop ? ` collection-page calendar-desktop${viewDays === 7 && filterMode === 'all' ? ' calendar-week' : ' calendar-agenda'}` : ''}`}
    >
      {desktop && (
        <WorkspacePageHeading
          className="collection-heading"
          eyebrow="Your workspace"
          title="Calendar"
          description="Your agenda, release milestones and meeting context."
        />
      )}
      <Header
        title="Calendar"
        center={
          <div className="cal-header-center">
            <button className="cal-nav-prev" aria-label="Previous period" onClick={handlePrev}>
              &lsaquo;
            </button>
            {desktop && (
              <button className="cal-today" onClick={handleToday}>
                Today
              </button>
            )}
            <button className="cal-header-title" onClick={handleToday} title="Return to today">
              {startLabel} &ndash; {endLabel}
            </button>
            <button className="cal-nav-next" aria-label="Next period" onClick={handleNext}>
              &rsaquo;
            </button>
          </div>
        }
      >
        <div className="cal-view-toggle">
          <button
            className={`cal-view-btn${viewDays === 1 ? ' cal-view-btn--active' : ''}`}
            aria-pressed={viewDays === 1}
            disabled={filterMode === 'releases'}
            onClick={() => {
              setSelectedId(null);
              setViewDays(1);
            }}
          >
            Day
          </button>
          <button
            className={`cal-view-btn${viewDays === 7 ? ' cal-view-btn--active' : ''}`}
            aria-pressed={viewDays === 7}
            disabled={filterMode === 'releases'}
            onClick={() => {
              setSelectedId(null);
              setViewDays(7);
            }}
          >
            Week
          </button>
        </div>
        <div className="cal-filter-toggle cal-view-toggle">
          <button
            className={`cal-view-btn${filterMode === 'all' ? ' cal-view-btn--active' : ''}`}
            aria-pressed={filterMode === 'all'}
            onClick={handleFilterAll}
          >
            All
          </button>
          <button
            className={`cal-view-btn${filterMode === 'releases' ? ' cal-view-btn--active' : ''}`}
            aria-pressed={filterMode === 'releases'}
            onClick={handleFilterReleases}
          >
            Releases
          </button>
        </div>
      </Header>

      {sprints.length > 0 && (
        <div className="cal-sprints">
          {sprints.map((s) => (
            <SprintBar key={s.id} sprint={s} />
          ))}
        </div>
      )}

      {error && <p role="alert">{error}</p>}
      {loading && (
        <div className="cal-loading">
          <div className="cal-loading-spinner" />
        </div>
      )}

      {!loading && (
        <div
          className={
            desktop
              ? `cal-desktop-panels${selected ? ' cal-desktop-panels--selected' : ''}`
              : 'collection-mobile-body'
          }
        >
          <div
            className="cal-body"
            ref={agendaRef}
            tabIndex={desktop ? 0 : undefined}
            aria-label={desktop ? 'Calendar agenda' : undefined}
          >
            {visibleDates.length === 0 && (
              <p className="cal-day-empty">No releases in this period</p>
            )}
            {visibleDates.map((dateStr) => {
              const dayEvents = eventsByDate.get(dateStr) ?? [];
              return (
                <div
                  key={dateStr}
                  className={`cal-day${dateStr === getToday() ? ' cal-day--today' : ''}`}
                >
                  <div className="cal-day-header">{formatDateHeader(dateStr)}</div>
                  {dayEvents.length === 0 && <div className="cal-day-empty">No events</div>}
                  {dayEvents.map((evt) => (
                    <EventCard
                      key={evt.id}
                      event={evt}
                      selected={selectedId === evt.id}
                      onSelect={desktop ? () => setSelectedId(evt.id) : undefined}
                    />
                  ))}
                </div>
              );
            })}
          </div>
          {desktop && selected && (
            <section
              className="collection-inspector cal-inspector"
              aria-label="Event details"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  agendaRef.current
                    ?.querySelector<HTMLButtonElement>('[aria-current="true"]')
                    ?.focus();
                  setSelectedId(null);
                }
              }}
            >
              <button
                className="cal-inspector-close"
                aria-label="Close event details"
                autoFocus
                onClick={() => {
                  agendaRef.current
                    ?.querySelector<HTMLButtonElement>('[aria-current="true"]')
                    ?.focus();
                  setSelectedId(null);
                }}
              >
                ×
              </button>
              <p className="workspace-muted">{formatDateHeader(toLocalDate(selected.start))}</p>
              <h2>{selected.title}</h2>
              <EventCard key={selected.id} event={selected} detail />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
