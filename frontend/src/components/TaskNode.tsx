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
  onStatusChange: (id: string, status: TaskStatus) => void;
  onDelete: (id: string) => void;
  onAddChild: (parentId: string) => void;
}

export function TaskNode({ task, depth, onStatusChange, onDelete, onAddChild }: TaskNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = task.children.length > 0;

  return (
    <div className="task-node" style={{ paddingLeft: `${depth * 16}px` }}>
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
              onStatusChange={onStatusChange}
              onDelete={onDelete}
              onAddChild={onAddChild}
            />
          ))}
        </div>
      )}
    </div>
  );
}
