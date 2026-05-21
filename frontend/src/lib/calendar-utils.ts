import type { CalendarEvent } from '../hooks/useCalendarData';

/**
 * Build a meeting prep prompt for calendar events.
 */
export function buildMeetingPrepPrompt(event: CalendarEvent): string {
  const time = formatEventTime(event);
  const when = time ? ` at ${time}` : '';

  return `Prepare for "${event.title}"${when}`;
}

/**
 * Build context block for meeting prep sessions.
 */
export function buildMeetingContext(event: CalendarEvent): string {
  const lines: string[] = [];

  lines.push(`**Meeting:** ${event.title}`);

  if (event.start) {
    const startDate = new Date(event.start);
    const dateStr = startDate.toLocaleDateString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    lines.push(`**When:** ${dateStr}`);
  }

  if (event.location) {
    lines.push(`**Where:** ${event.location}`);
  }

  if (event.attendees && event.attendees.length > 0) {
    const displayAttendees = event.attendees
      .slice(0, 10)
      .map((email) => {
        const name = email.split('@')[0];
        return name;
      })
      .join(', ');

    const suffix = event.attendees.length > 10 ? ` (+${event.attendees.length - 10} more)` : '';
    lines.push(`**Attendees:** ${displayAttendees}${suffix}`);
  }

  if (event.hangoutLink) {
    lines.push(`**Video:** [Join call](${event.hangoutLink})`);
  }

  lines.push('');
  lines.push('**Context for this meeting:**');
  lines.push('- Review recent Jira activity for attendees');
  lines.push('- Check relevant docs and recent conversations');
  lines.push('- Identify key topics and decisions needed');

  return lines.join('\n');
}

function formatEventTime(event: CalendarEvent): string {
  if (!event.start || !event.start.includes('T')) return '';

  const start = new Date(event.start);
  const end = event.end ? new Date(event.end) : null;

  const startTime = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (!end) return startTime;

  const endTime = end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${startTime}–${endTime}`;
}
