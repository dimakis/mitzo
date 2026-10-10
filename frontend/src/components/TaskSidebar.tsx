import { UiIcon } from './UiIcon';
import { taskStatusIcons } from '../lib/status-icons';
import { useState } from 'react';
import type { Task } from '../types/task';

interface TaskSidebarProps {
  currentTask: Task | null;
  siblings: Task[];
  parentProgress: { done: number; total: number } | null;
  onApprove: (id: string) => void;
  onReject: (id: string, feedback: string) => void;
}

export function TaskSidebar({
  currentTask,
  siblings,
  parentProgress,
  onApprove,
  onReject,
}: TaskSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [rejectFeedback, setRejectFeedback] = useState('');
  const [showRejectInput, setShowRejectInput] = useState(false);

  if (!currentTask) return null;

  return (
    <div className={`task-sidebar${collapsed ? ' task-sidebar--collapsed' : ''}`}>
      <button
        className="task-sidebar-toggle"
        onClick={() => setCollapsed(!collapsed)}
        aria-expanded={!collapsed}
      >
        <UiIcon name={collapsed ? 'forward' : 'down'} size={16} /> Task
      </button>

      {!collapsed && (
        <>
          <div className="task-sidebar-current">
            <h3 className="task-sidebar-title">{currentTask.title}</h3>
            {currentTask.description && (
              <p className="task-sidebar-desc">{currentTask.description}</p>
            )}
            {currentTask.annotations.length > 0 && (
              <ul className="task-sidebar-annotations">
                {currentTask.annotations.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            )}
          </div>

          {currentTask.status === 'pending_review' && (
            <div className="task-sidebar-review">
              <button
                className="loop-controls-btn loop-controls-btn--start"
                onClick={() => onApprove(currentTask.id)}
              >
                Approve
              </button>
              {!showRejectInput ? (
                <button
                  className="loop-controls-btn loop-controls-btn--danger"
                  onClick={() => setShowRejectInput(true)}
                >
                  Reject
                </button>
              ) : (
                <div className="task-sidebar-reject-form">
                  <input
                    type="text"
                    className="task-sidebar-reject-input"
                    value={rejectFeedback}
                    onChange={(e) => setRejectFeedback(e.target.value)}
                    placeholder="Feedback..."
                    autoFocus
                  />
                  <button
                    className="loop-controls-btn loop-controls-btn--danger"
                    onClick={() => {
                      onReject(currentTask.id, rejectFeedback);
                      setRejectFeedback('');
                      setShowRejectInput(false);
                    }}
                  >
                    Send
                  </button>
                </div>
              )}
            </div>
          )}

          {siblings.length > 0 && (
            <div className="task-sidebar-siblings">
              <h4>Siblings</h4>
              <ul>
                {siblings.map((s) => (
                  <li
                    key={s.id}
                    className={`task-sidebar-sibling${s.id === currentTask.id ? ' task-sidebar-sibling--active' : ''}`}
                  >
                    <span
                      className={`task-card-chip task-card-chip--${s.status}`}
                      role="img"
                      aria-label={`Status: ${s.status.replaceAll('_', ' ')}`}
                    >
                      <UiIcon name={taskStatusIcons[s.status]} size={16} />
                    </span>
                    {s.title}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {parentProgress && parentProgress.total > 0 && (
            <div className="task-sidebar-progress">
              <div className="loop-controls-bar">
                <div
                  className="loop-controls-bar-fill"
                  style={{
                    width: `${(parentProgress.done / parentProgress.total) * 100}%`,
                  }}
                />
              </div>
              <span className="task-sidebar-progress-label">
                {parentProgress.done}/{parentProgress.total}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
