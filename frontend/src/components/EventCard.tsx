import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMitzoStore } from '@mitzo/client/hooks';
import type { CalendarEvent } from '../hooks/useCalendarData';
import { buildMeetingPrepPrompt, buildMeetingContext } from '../lib/calendar-utils';

function formatTime(isoStr: string): string {
  if (!isoStr.includes('T')) return '';
  const d = new Date(isoStr);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function EventCard({ event }: { event: CalendarEvent }) {
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();
  const setPendingSession = useMitzoStore((s) => s.setPendingSession);

  function handlePrepClick(e: React.MouseEvent) {
    e.stopPropagation();
    setPendingSession({
      prompt: buildMeetingPrepPrompt(event),
      context: buildMeetingContext(event),
      agentName: 'mitzo-calendar',
    });
    navigate('/chat');
  }

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
                {event.ourFeatures} of our features {'\u00b7'} {event.totalFeatures} total
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
          <div className="cal-event-actions">
            <button className="cal-action-prep" onClick={handlePrepClick}>
              Prep for this meeting
            </button>
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
        </div>
      )}
    </div>
  );
}
