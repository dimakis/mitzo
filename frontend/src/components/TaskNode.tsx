import { useState } from 'react';
import type { Task, TaskStatus } from '../types/task';

const STATUS_ICONS: Record<TaskStatus, string> = {
  pending: '\u25CB', // ○
  active: '\u25C9', // ◉
  done: '\u2713', // ✓
  pending_review: '\u25D4', // ◔
  blocked: '\u2298', // ⊘
  skipped: '\u2014', // —
  failed: '\u2717', // ✗
};

const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
  pending: 'active',
  active: 'done',
  done: 'pending',
  pending_review: 'done',
  blocked: 'active',
  skipped: 'pending',
  failed: 'pending',
};

interface TaskNodeProps {
  task: Task;
  depth: number;
  active?: boolean;
  onStatusChange: (id: string, status: TaskStatus) => void;
  onDelete: (id: string) => void;
  onAddChild: (parentId: string) => void;
  onApprove?: (id: string) => void;
  onReject?: (id: string, feedback: string) => void;
}

export function TaskNode({
  task,
  depth,
  active,
  onStatusChange,
  onDelete,
  onAddChild,
  onApprove,
  onReject,
}: TaskNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = task.children.length > 0;

  return (
    <div className={`task-node${active ? ' task-node--active' : ''}`}>
      <div className="task-node-row">
        {hasChildren && (
          <button
            className="task-node-chevron"
            onClick={() => setExpanded(!expanded)}
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? '\u25BC' : '\u25B6'}
          </button>
        )}
        <button
          className={`task-node-status task-node-status--${task.status}`}
          onClick={() => onStatusChange(task.id, NEXT_STATUS[task.status])}
          aria-label={`Status: ${task.status}`}
        >
          {STATUS_ICONS[task.status]}
        </button>
        <span
          className={`task-node-title${task.status === 'done' ? ' task-node-title--done' : ''}`}
        >
          {task.title}
        </span>
        <div className="task-node-actions">
          {task.status === 'pending_review' && onApprove && (
            <button
              className="task-node-action task-node-action--approve"
              onClick={() => onApprove(task.id)}
              title="Approve"
            >
              &#x2713;
            </button>
          )}
          {task.status === 'pending_review' && onReject && (
            <button
              className="task-node-action task-node-action--danger"
              onClick={() => onReject(task.id, '')}
              title="Reject"
            >
              &#x2717;
            </button>
          )}
          <button
            className="task-node-action"
            onClick={() => onAddChild(task.id)}
            title="Add sub-task"
          >
            +
          </button>
          <button
            className="task-node-action task-node-action--danger"
            onClick={() => onDelete(task.id)}
            title="Delete task"
          >
            &times;
          </button>
        </div>
      </div>
      {hasChildren && expanded && (
        <div className="task-node-children">
          {task.children.map((child) => (
            <TaskNode
              key={child.id}
              task={child}
              depth={depth + 1}
              active={active}
              onStatusChange={onStatusChange}
              onDelete={onDelete}
              onAddChild={onAddChild}
              onApprove={onApprove}
              onReject={onReject}
            />
          ))}
        </div>
      )}
    </div>
  );
}
