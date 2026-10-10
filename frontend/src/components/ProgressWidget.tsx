import { UiIcon } from './UiIcon';
import { progressStatusIcons } from '../lib/status-icons';
import { useState } from 'react';
import type { ProgressItem } from '@mitzo/protocol';

interface Props {
  items: ProgressItem[];
}

export function ProgressWidget({ items }: Props) {
  const [expanded, setExpanded] = useState(true);

  const doneCount = items.filter((i) => i.status === 'done').length;
  const total = items.length;
  const activeItem = items.find((i) => i.status === 'in_progress');
  const allDone = total > 0 && doneCount === total;
  const pct = total > 0 ? (doneCount / total) * 100 : 0;

  return (
    <div className={`progress-widget ${allDone ? 'progress-widget--done' : ''}`}>
      <button
        className="progress-widget-header"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
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
        <span className="progress-widget-chevron">
          <UiIcon name={expanded ? 'down' : 'forward'} size={16} />
        </span>
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
                role="img"
                aria-label={`Status: ${item.status.replaceAll('_', ' ')}`}
              >
                <UiIcon name={progressStatusIcons[item.status]} size={16} />
              </span>
              <span className="progress-widget-title">{item.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
