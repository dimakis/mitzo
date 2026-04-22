import { useState } from 'react';
import type { ProgressItem } from '@mitzo/protocol';

interface Props {
  progressId: string;
  items: ProgressItem[];
}

const STATUS_ICONS: Record<ProgressItem['status'], string> = {
  done: '\u2713',
  in_progress: '\u25C9',
  pending: '\u25CB',
};

export function ProgressWidget({ items }: Props) {
  const [expanded, setExpanded] = useState(true);

  const doneCount = items.filter((i) => i.status === 'done').length;
  const total = items.length;
  const activeItem = items.find((i) => i.status === 'in_progress');
  const allDone = doneCount === total;
  const pct = total > 0 ? (doneCount / total) * 100 : 0;

  return (
    <div className={`progress-widget ${allDone ? 'progress-widget--done' : ''}`}>
      <button className="progress-widget-header" onClick={() => setExpanded((e) => !e)}>
        <div className="progress-widget-bar">
          <div className="progress-widget-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="progress-widget-count">
          {doneCount}/{total}
        </span>
        {activeItem && (
          <span className="progress-widget-active">
            <span className="progress-widget-pulse" />
            {activeItem.title}
          </span>
        )}
        {allDone && !activeItem && (
          <span className="progress-widget-active progress-widget-active--done">
            All tasks complete
          </span>
        )}
        <span className="progress-widget-chevron">{expanded ? '\u25BE' : '\u25B8'}</span>
      </button>
      {expanded && (
        <div className="progress-widget-list">
          {items.map((item) => (
            <div
              key={item.id}
              className={`progress-widget-item ${item.status === 'done' ? 'progress-widget-item--done' : ''} ${item.status === 'in_progress' ? 'progress-widget-item--active' : ''}`}
            >
              <span
                className={`progress-widget-icon ${item.status === 'in_progress' ? 'progress-widget-icon--pulse' : ''}`}
              >
                {STATUS_ICONS[item.status]}
              </span>
              <span className="progress-widget-title">{item.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
