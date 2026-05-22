import { describe, it, expect } from 'vitest';
import { buildMeetingPrepPrompt, buildMeetingContext } from '../calendar-utils';
import type { CalendarEvent } from '../../hooks/useCalendarData';

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-1',
    type: 'meeting',
    title: 'Standup',
    start: '2026-05-22T10:00:00Z',
    end: '2026-05-22T10:30:00Z',
    ...overrides,
  };
}

describe('buildMeetingPrepPrompt', () => {
  it('includes title and formatted time range', () => {
    const result = buildMeetingPrepPrompt(makeEvent());
    expect(result).toContain('Prepare for "Standup"');
    expect(result).toContain(' at ');
  });

  it('omits time for all-day events (no T in start)', () => {
    const result = buildMeetingPrepPrompt(makeEvent({ start: '2026-05-22', end: '2026-05-23' }));
    expect(result).toBe('Prepare for "Standup"');
  });

  it('omits time when start is empty', () => {
    const result = buildMeetingPrepPrompt(makeEvent({ start: '' }));
    expect(result).toBe('Prepare for "Standup"');
  });
});

describe('buildMeetingContext', () => {
  it('includes meeting title', () => {
    const result = buildMeetingContext(makeEvent());
    expect(result).toContain('**Meeting:** Standup');
  });

  it('includes location when present', () => {
    const result = buildMeetingContext(makeEvent({ location: 'Room 42' }));
    expect(result).toContain('**Where:** Room 42');
  });

  it('omits location when absent', () => {
    const result = buildMeetingContext(makeEvent());
    expect(result).not.toContain('**Where:**');
  });

  it('formats attendees from email addresses', () => {
    const result = buildMeetingContext(
      makeEvent({ attendees: ['alice@example.com', 'bob@example.com'] }),
    );
    expect(result).toContain('**Attendees:** alice, bob');
  });

  it('truncates attendees beyond 10 with count', () => {
    const attendees = Array.from({ length: 12 }, (_, i) => `user${i}@example.com`);
    const result = buildMeetingContext(makeEvent({ attendees }));
    expect(result).toContain('(+2 more)');
    expect(result).not.toContain('user10');
  });

  it('includes video link when present', () => {
    const result = buildMeetingContext(makeEvent({ hangoutLink: 'https://meet.google.com/abc' }));
    expect(result).toContain('**Video:** [Join call](https://meet.google.com/abc)');
  });

  it('includes context prompts at the end', () => {
    const result = buildMeetingContext(makeEvent());
    expect(result).toContain('Review recent Jira activity');
    expect(result).toContain('key topics and decisions');
  });
});
