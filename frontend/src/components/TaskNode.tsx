import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Task, TaskStatus, StageType } from '../types/task';
import type { TaskDisplayMeta } from '../hooks/useTaskBoard';

const STATUS_ICONS: Record<TaskStatus, string> = {
  pending: '\u25CB', // ○
  active: '\u25C9', // ◉
  done: '\u2713', // ✓
  pending_review: '\u25D4', // ◔
  blocked: '\u2298', // ⊘
  skipped: '\u2014', // —
  failed: '\u2717', // ✗
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'pending',
  active: 'running',
  done: 'done',
  pending_review: 'review',
  blocked: 'blocked',
  skipped: 'skipped',
  failed: 'failed',
};

const STAGE_LABELS: Record<StageType, string> = {
  agent_work: '',
  wait_for_signal: 'signal',
  human_review: 'review',
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
  compact?: boolean;
  activeTaskId?: string | null;
  displayMeta?: Map<string, TaskDisplayMeta>;
  onStatusChange: (id: string, status: TaskStatus) => void;
  onDelete: (id: string) => void;
  onAddChild?: (parentId: string) => void;
  onApprove?: (id: string) => void;
  onReject?: (id: string, feedback: string) => void;
}

function ContextLine({ task, meta }: { task: Task; meta?: TaskDisplayMeta }) {
  const dot = ' \u00B7 ';

  const sessionLink =
    task.sessionId && meta?.sessionHash ? (
      <Link
        className="task-node-session-link"
        to={`/chat/${task.sessionId}`}
        onClick={(e) => e.stopPropagation()}
      >
        {meta.sessionHash}
      </Link>
    ) : null;

  switch (task.status) {
    case 'active':
      return (
        <>
          {STATUS_LABELS.active}
          {sessionLink && (
            <>
              {dot}
              {sessionLink}
            </>
          )}
          {meta?.elapsedLabel && `${dot}${meta.elapsedLabel}`}
        </>
      );
    case 'pending_review':
      return (
        <>
          awaiting approval
          {sessionLink && (
            <>
              {dot}
              {sessionLink}
            </>
          )}
        </>
      );
    case 'blocked':
      return (
        <>
          {meta?.blockerSummary ?? 'blocked'}
          {sessionLink && (
            <>
              {dot}
              {sessionLink}
            </>
          )}
        </>
      );
    case 'done':
      return (
        <>
          {meta?.completedAgo ? `done${dot}${meta.completedAgo}` : 'done'}
          {sessionLink && (
            <>
              {dot}
              {sessionLink}
            </>
          )}
        </>
      );
    case 'failed': {
      const label = meta?.blockerSummary ?? 'failed';
      const retry = task.retryCount > 0 ? `${dot}retry ${task.retryCount}` : '';
      return (
        <>
          {label}
          {retry}
          {sessionLink && (
            <>
              {dot}
              {sessionLink}
            </>
          )}
        </>
      );
    }
    default:
      return null;
  }
}

function contextColorClass(status: TaskStatus): string {
  if (status === 'pending_review') return ' task-node-context--review';
  if (status === 'blocked') return ' task-node-context--blocked';
  if (status === 'failed') return ' task-node-context--failed';
  return '';
}

// Note: Time-dependent display (fade opacity, elapsed labels) is computed by
// useTaskBoard's displayMeta and refreshed every 60s via setInterval + on each
// SSE task_state event. The component itself is a pure render of that snapshot.
export function TaskNode({
  task,
  depth,
  compact,
  activeTaskId,
  displayMeta,
  onStatusChange,
  onDelete,
  onAddChild,
  onApprove,
  onReject,
}: TaskNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = task.children.length > 0;
  const meta = displayMeta?.get(task.id);
  const isCompact = compact && task.status !== 'active';

  // Build class list
  const classes = ['task-node', `task-node--status-${task.status}`];
  if (meta?.attendTier === 1) classes.push('task-node--t1');
  if (meta && meta.fadeOpacity <= 0) classes.push('task-node--hidden');

  const contextLine = !isCompact ? <ContextLine task={task} meta={meta} /> : null;
  const fadeStyle =
    meta && meta.fadeOpacity < 1 && meta.fadeOpacity > 0
      ? { opacity: meta.fadeOpacity }
      : undefined;

  return (
    <div className={classes.join(' ')} style={fadeStyle}>
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
        <div className="task-node-body">
          <span
            className={`task-node-title${task.status === 'done' ? ' task-node-title--done' : ''}`}
          >
            {task.title}
          </span>
          {contextLine && (
            <div className={`task-node-context${contextColorClass(task.status)}`}>
              {contextLine}
            </div>
          )}
          {task.summary && <div className="task-node-summary">{task.summary}</div>}
        </div>
        {task.stageType && STAGE_LABELS[task.stageType] && (
          <span className={`task-node-stage task-node-stage--${task.stageType}`}>
            {STAGE_LABELS[task.stageType]}
          </span>
        )}
        {!isCompact && task.retryCount > 0 && task.status !== 'failed' && (
          <span className="task-node-retry" title={`Retry ${task.retryCount}/${task.maxRetries}`}>
            {'\u21BB'}
            {task.retryCount}
          </span>
        )}
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
          {onAddChild && (
            <button
              className="task-node-action"
              onClick={() => onAddChild(task.id)}
              title="Add sub-task"
            >
              +
            </button>
          )}
          <button
            className="task-node-action task-node-action--danger"
            onClick={() => onDelete(task.id)}
            title="Delete task"
          >
            &times;
          </button>
        </div>
      </div>
      {task.artifacts && Object.keys(task.artifacts).length > 0 && expanded && (
        <div className="task-node-artifacts">
          {Object.entries(task.artifacts).map(([key, value]) => (
            <div key={key} className="task-node-artifact">
              <span className="task-node-artifact-key">{key}:</span>{' '}
              <span className="task-node-artifact-value">{String(value)}</span>
            </div>
          ))}
        </div>
      )}
      {hasChildren && expanded && (
        <div className="task-node-children">
          {task.children.map((child) => {
            // Tier-1 children (pending_review, blocked, failed) should show context lines
            const childMeta = displayMeta?.get(child.id);
            const childCompact = childMeta?.attendTier !== 1;
            return (
              <TaskNode
                key={child.id}
                task={child}
                depth={depth + 1}
                compact={childCompact}
                activeTaskId={activeTaskId}
                displayMeta={displayMeta}
                onStatusChange={onStatusChange}
                onDelete={onDelete}
                onAddChild={onAddChild}
                onApprove={onApprove}
                onReject={onReject}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
