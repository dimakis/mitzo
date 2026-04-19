import { useState } from 'react';
import type { Task, TaskStatus } from '../types/task';

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'Pending',
  active: 'Active',
  done: 'Done',
  pending_review: 'Review',
  blocked: 'Blocked',
  skipped: 'Skipped',
  failed: 'Failed',
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
  activeTaskId?: string | null;
  onStatusChange: (id: string, status: TaskStatus) => void;
  onDelete: (id: string) => void;
  onAddChild: (parentId: string) => void;
  onApprove?: (id: string) => void;
  onReject?: (id: string, feedback: string) => void;
}

export function TaskNode({
  task,
  depth,
  activeTaskId,
  onStatusChange,
  onDelete,
  onAddChild,
  onApprove,
  onReject,
}: TaskNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = task.children.length > 0;
  const isActive = activeTaskId === task.id;

  return (
    <div className={`task-card${isActive ? ' task-card--active' : ''} task-card--${task.status}`}>
      <div className="task-card-body">
        <div className="task-card-top">
          <button
            className={`task-card-chip task-card-chip--${task.status}`}
            onClick={() => onStatusChange(task.id, NEXT_STATUS[task.status])}
            aria-label={`Status: ${task.status}`}
          >
            {STATUS_LABELS[task.status]}
          </button>
          {hasChildren && (
            <button
              className="task-card-expand"
              onClick={() => setExpanded(!expanded)}
              aria-label={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? '▾' : '▸'}
            </button>
          )}
        </div>
        <div className={`task-card-title${task.status === 'done' ? ' task-card-title--done' : ''}`}>
          {task.title}
        </div>
        <div className="task-card-actions">
          {task.status === 'pending_review' && onApprove && (
            <button
              className="task-card-action task-card-action--approve"
              onClick={() => onApprove(task.id)}
            >
              Approve
            </button>
          )}
          {task.status === 'pending_review' && onReject && (
            <button
              className="task-card-action task-card-action--reject"
              onClick={() => onReject(task.id, '')}
            >
              Reject
            </button>
          )}
          <button className="task-card-action" onClick={() => onAddChild(task.id)}>
            + Sub
          </button>
          <button
            className="task-card-action task-card-action--reject"
            onClick={() => onDelete(task.id)}
          >
            Delete
          </button>
        </div>
      </div>
      {hasChildren && expanded && (
        <div className="task-card-children">
          {task.children.map((child) => (
            <TaskNode
              key={child.id}
              task={child}
              depth={depth + 1}
              activeTaskId={activeTaskId}
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
