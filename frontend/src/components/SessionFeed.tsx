import { useNavigate } from 'react-router-dom';
import type { SessionActivity, SessionActivityState } from '@mitzo/protocol';
import { useSessionFeed, type FeedFilter } from '../hooks/useSessionFeed';
import { formatRelativeTime } from '../lib/formatTime';

// ─── State config ────────────────────────────────────────────────────────────

const STATE_CONFIG: Record<SessionActivityState, { icon: string; color: string; label: string }> = {
  working: { icon: '●', color: '#b48cff', label: 'working' },
  waiting: { icon: '⚠', color: '#ff6d6d', label: 'waiting' },
  done: { icon: '✓', color: '#4ade80', label: 'done' },
  idle: { icon: '○', color: 'var(--text-dim)', label: 'idle' },
  init: { icon: '○', color: 'var(--text-dim)', label: 'starting' },
  paused: { icon: '⏸', color: 'var(--text-dim)', label: 'paused' },
};

// ─── Filter chips ────────────────────────────────────────────────────────────

const FILTERS: {
  key: FeedFilter;
  label: string;
  countKey: 'all' | 'needsMe' | 'inProgress' | 'done';
}[] = [
  { key: 'all', label: 'All', countKey: 'all' },
  { key: 'needs_me', label: 'Needs me', countKey: 'needsMe' },
  { key: 'in_progress', label: 'In progress', countKey: 'inProgress' },
  { key: 'done', label: 'Done', countKey: 'done' },
];

// ─── Feed item card ──────────────────────────────────────────────────────────

function FeedItem({
  activity,
  onTap,
}: {
  activity: SessionActivity;
  onTap: (sessionId: string) => void;
}) {
  const config = STATE_CONFIG[activity.state];
  const timeLabel = formatRelativeTime(activity.lastEventAt);

  // Build meta label
  let metaText = config.label;
  if (activity.awaitingReply) metaText = 'awaiting reply';
  else if (activity.waitReason === 'permission') metaText = 'permission';
  else if (activity.waitReason === 'review') metaText = 'review needed';
  else if (activity.waitReason === 'blocked') metaText = 'blocked';
  else if (activity.uncommittedWork) metaText = 'uncommitted work';

  if (activity.progress) {
    metaText += ` \u00B7 ${activity.progress.done}/${activity.progress.total}`;
  }
  metaText += ` \u00B7 ${timeLabel}`;

  // Icon: mail for awaiting reply, otherwise state icon
  const icon = activity.awaitingReply ? '✉' : config.icon;
  const iconColor = activity.awaitingReply ? '#b48cff' : config.color;

  return (
    <button
      className="feed-card"
      onClick={() => onTap(activity.sessionId)}
      style={{ '--card-accent': iconColor } as React.CSSProperties}
    >
      <span className="feed-card-icon" style={{ color: iconColor }}>
        {icon}
      </span>
      <div className="feed-card-body">
        <div className="feed-card-title">
          {activity.repo && <span className="feed-card-repo">{activity.repo}:</span>}{' '}
          {activity.title}
        </div>
        {activity.lastMessagePreview && (
          <div className="feed-card-preview">{activity.lastMessagePreview}</div>
        )}
        <div className="feed-card-meta">{metaText}</div>
      </div>
    </button>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export function SessionFeed() {
  const { items, counts, filter, setFilter } = useSessionFeed();
  const navigate = useNavigate();

  const handleTap = (sessionId: string) => {
    navigate(`/chat/${sessionId}`);
  };

  // Don't render if nothing in the working batch
  if (counts.all === 0) return null;

  return (
    <div className="feed-section">
      {/* Filter chips */}
      <div className="feed-filters">
        {FILTERS.map(({ key, label, countKey }) => {
          const count = counts[countKey];
          const isActive = filter === key;
          return (
            <button
              key={key}
              className={`feed-filter-pill${isActive ? ' feed-filter-pill--active' : ''}`}
              onClick={() => setFilter(key)}
            >
              {label}
              {count > 0 && <span className="feed-filter-count">{count}</span>}
            </button>
          );
        })}
      </div>

      {/* Feed list */}
      <div className="feed-list">
        {items.length === 0 && (
          <div className="feed-empty">{filter === 'needs_me' ? 'All clear' : 'No sessions'}</div>
        )}
        {items.map((activity) => (
          <FeedItem key={activity.sessionId} activity={activity} onTap={handleTap} />
        ))}
      </div>
    </div>
  );
}
