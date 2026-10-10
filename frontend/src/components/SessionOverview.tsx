import { MotionPresence } from './MotionPresence';
import { UiIcon, type UiIconName } from './UiIcon';
import { sessionStatusIcons } from '../lib/status-icons';
import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useSessionOverview,
  type SessionActivity,
  type SessionActivityState,
} from '../hooks/useSessionOverview';
import { selectionChanged } from '../lib/haptics';
import { formatRelativeTime } from '../lib/formatTime';

// ─── State visuals ──────────────────────────────────────────────────────────

const STATE_CONFIG: Record<
  SessionActivityState,
  { icon: UiIconName; color: string; label: string }
> = {
  init: { icon: sessionStatusIcons.init, color: 'var(--color-muted)', label: 'init' },
  working: { icon: sessionStatusIcons.working, color: 'var(--color-accent)', label: 'working' },
  waiting: { icon: sessionStatusIcons.waiting, color: 'var(--color-danger)', label: 'waiting' },
  done: { icon: sessionStatusIcons.done, color: 'var(--color-success)', label: 'done' },
  idle: { icon: sessionStatusIcons.idle, color: 'var(--color-muted)', label: 'idle' },
  paused: { icon: sessionStatusIcons.paused, color: 'var(--color-muted)', label: 'paused' },
};

// ─── Card ───────────────────────────────────────────────────────────────────

function SessionActivityCard({
  activity,
  onTap,
}: {
  activity: SessionActivity;
  onTap: (sessionId: string) => void;
}) {
  const config = STATE_CONFIG[activity.state];
  // Elapsed updates on each SSE event, not on a timer — acceptable staleness
  const timeLabel = formatRelativeTime(activity.lastEventAt);

  let metaText = config.label;
  if (activity.waitReason === 'permission') metaText = 'permission';
  else if (activity.waitReason === 'review') metaText = 'review needed';
  else if (activity.waitReason === 'blocked') metaText = 'blocked';

  if (activity.progress) {
    metaText += ` \u00B7 ${activity.progress.done}/${activity.progress.total}`;
  }

  metaText += ` \u00B7 ${timeLabel}`;

  return (
    <button
      className="overview-card"
      onClick={() => onTap(activity.sessionId)}
      style={{ '--card-accent': config.color } as React.CSSProperties}
    >
      <span className="overview-card-icon" style={{ color: config.color }}>
        <UiIcon name={config.icon} />
      </span>
      <div className="overview-card-content">
        <div className="overview-card-title">
          {activity.repo && <span className="overview-card-repo">{activity.repo}:</span>}{' '}
          {activity.title}
        </div>
        <div className="overview-card-meta">{metaText}</div>
      </div>
    </button>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export function SessionOverview() {
  const { activities, attendCount } = useSessionOverview();
  const navigate = useNavigate();

  // Filter out idle/init — only show interesting sessions
  const visible = activities.filter((a) => a.state !== 'idle' && a.state !== 'init');

  // Auto-expand when tier 1 items exist
  const hasUrgent = attendCount > 0;
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const isOpen = manualOpen ?? hasUrgent;

  const toggleOpen = useCallback(() => {
    setManualOpen((prev) => !(prev ?? hasUrgent));
  }, [hasUrgent]);

  const handleTap = useCallback(
    (sessionId: string) => {
      selectionChanged();
      navigate(`/chat/${sessionId}`);
    },
    [navigate],
  );

  // Don't render at all if no interesting sessions
  if (visible.length === 0) return null;

  // Build summary line
  const waitingCount = visible.filter((a) => a.state === 'waiting').length;
  const workingCount = visible.filter((a) => a.state === 'working').length;
  const doneCount = visible.filter((a) => a.state === 'done').length;
  const parts: string[] = [];
  if (waitingCount > 0) parts.push(`${waitingCount} waiting`);
  if (workingCount > 0) parts.push(`${workingCount} working`);
  if (doneCount > 0) parts.push(`${doneCount} done`);

  return (
    <div className="overview-section">
      <button className="overview-header" onClick={toggleOpen} aria-expanded={isOpen}>
        <span className="overview-header-title">Active Sessions</span>
        <span className="overview-header-summary">{parts.join(' \u00B7 ')}</span>
        {attendCount > 0 && <span className="overview-badge">{attendCount}</span>}
        <span className={`overview-chevron${isOpen ? ' overview-chevron--open' : ''}`}>
          <UiIcon name="forward" size={16} />
        </span>
      </button>
      <MotionPresence open={isOpen} kind="disclosure" appear={false}>
        <div className="overview-cards">
          {visible.map((a) => (
            <SessionActivityCard key={a.sessionId} activity={a} onTap={handleTap} />
          ))}
        </div>
      </MotionPresence>
    </div>
  );
}
