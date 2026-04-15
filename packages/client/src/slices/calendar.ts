export interface CalendarEvent {
  id: string;
  type: 'meeting' | 'milestone';
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  location?: string;
  attendees?: string[];
  attendeeCount?: number;
  status?: string;
  hangoutLink?: string;
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

export interface CalendarState {
  events: CalendarEvent[];
  sprints: SprintInfo[];
}

export const INITIAL_CALENDAR_STATE: CalendarState = {
  events: [],
  sprints: [],
};
