import { useState, useEffect, useMemo } from 'react';

export interface CalendarEvent {
  id: string;
  type: 'meeting' | 'milestone';
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  // Meeting fields
  location?: string;
  attendees?: string[];
  attendeeCount?: number;
  status?: string;
  hangoutLink?: string;
  // Milestone fields
  version?: string;
  milestone?: string;
  label?: string;
  daysAway?: number;
  ourFeatures?: number;
  totalFeatures?: number;
}

export interface SprintInfo {
  id: string;
  type: 'sprint';
  title: string;
  start: string;
  end: string;
}

interface CalendarData {
  startDate: string;
  endDate: string;
  events: CalendarEvent[];
  sprints: SprintInfo[];
  error?: string;
}

export interface UseCalendarDataResult {
  loading: boolean;
  events: CalendarEvent[];
  meetings: CalendarEvent[];
  milestones: CalendarEvent[];
  sprints: SprintInfo[];
  startDate: string;
  endDate: string;
  error?: string;
}

export function useCalendarData(date: string, days: number = 7): UseCalendarDataResult {
  const [data, setData] = useState<CalendarData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetch(`/api/calendar?date=${date}&days=${days}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Calendar API returned ${r.status}`);
        return r.json();
      })
      .then((result: CalendarData) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setData({ startDate: date, endDate: date, events: [], sprints: [] });
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [date, days]);

  const meetings = useMemo(() => (data?.events ?? []).filter((e) => e.type === 'meeting'), [data]);

  const milestones = useMemo(
    () => (data?.events ?? []).filter((e) => e.type === 'milestone'),
    [data],
  );

  return {
    loading,
    events: data?.events ?? [],
    meetings,
    milestones,
    sprints: data?.sprints ?? [],
    startDate: data?.startDate ?? date,
    endDate: data?.endDate ?? date,
    error: data?.error,
  };
}
