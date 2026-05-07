import { useCallback } from 'react';
import { useTaskBoard } from '../hooks/useTaskBoard';
import { TaskNode } from './TaskNode';
import { CollapsibleSection } from './CollapsibleSection';
import type { TaskStatus } from '../types/task';

const STATE_LABELS: Record<string, string> = {
  idle: 'Idle',
  running: 'Running',
  paused: 'Paused',
};

const STATE_COLORS: Record<string, string> = {
  idle: '#888',
  running: '#b48cff',
  paused: '#fbbf24',
};

export interface TaskBoardSectionProps {
  activeSessionId?: string;
}

export function TaskBoardSection({ activeSessionId: _activeSessionId }: TaskBoardSectionProps) {
  const {
    loading,
    tasks,
    loopStatus,
    updateTask,
    deleteTask,
    pauseLoop,
    resumeLoop,
    stopLoop,
    approveTask,
    rejectTask,
    approveSpec,
    rejectSpec,
    refresh,
  } = useTaskBoard();

  const handleStatusChange = useCallback(
    (id: string, status: TaskStatus) => {
      updateTask(id, { status });
    },
    [updateTask],
  );

  const handleDelete = useCallback(
    (id: string) => {
      deleteTask(id);
    },
    [deleteTask],
  );

  // No-op for add child in compact mode — users go to full task board
  const handleAddChild = useCallback(() => {
    // Not supported in sidebar compact view
  }, []);

  const { state, progress, awaitingApproval } = loopStatus;

  // Count items needing attention
  const needsAttention = tasks.filter(
    (t) => t.status === 'pending_review' || t.status === 'blocked' || t.status === 'failed',
  ).length;

  return (
    <CollapsibleSection
      title="Tasks"
      badge={needsAttention || undefined}
      storageKey="cc-taskboard"
      actions={
        <button className="cc-section-action-btn" onClick={refresh} title="Refresh">
          &#x21bb;
        </button>
      }
    >
      {/* Compact loop bar */}
      {state !== 'idle' && (
        <div className="cc-loop-bar">
          <div className="cc-loop-status">
            <span className="cc-loop-dot" style={{ background: STATE_COLORS[state] }} />
            <span className="cc-loop-label">{STATE_LABELS[state]}</span>
            {progress && (
              <span className="cc-loop-progress">
                {progress.done}/{progress.total}
              </span>
            )}
          </div>
          <div className="cc-loop-actions">
            {state === 'running' && !awaitingApproval && (
              <>
                <button className="cc-btn cc-btn--subtle" onClick={pauseLoop} title="Pause">
                  &#x23F8;
                </button>
                <button className="cc-btn cc-btn--danger" onClick={stopLoop} title="Stop">
                  &#x25A0;
                </button>
              </>
            )}
            {state === 'paused' && !awaitingApproval && (
              <>
                <button className="cc-btn cc-btn--approve" onClick={resumeLoop} title="Resume">
                  &#x25B6;
                </button>
                <button className="cc-btn cc-btn--danger" onClick={stopLoop} title="Stop">
                  &#x25A0;
                </button>
              </>
            )}
          </div>
          {progress && progress.total > 0 && (
            <div className="cc-loop-progress-bar">
              <div
                className="cc-loop-progress-fill"
                style={{ width: `${(progress.done / progress.total) * 100}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* Spec approval gate */}
      {awaitingApproval && (
        <div className="cc-approval">
          <p className="cc-approval-msg">Task breakdown ready</p>
          <div className="cc-approval-actions">
            <button className="cc-btn cc-btn--approve" onClick={approveSpec}>
              Approve
            </button>
            <button className="cc-btn cc-btn--danger" onClick={rejectSpec}>
              Reject
            </button>
          </div>
        </div>
      )}

      {loading && <p className="cc-empty">Loading...</p>}

      {!loading && tasks.length === 0 && state === 'idle' && <p className="cc-empty">No tasks</p>}

      {/* Task tree */}
      <div className="cc-task-list">
        {tasks.map((task) => (
          <TaskNode
            key={task.id}
            task={task}
            depth={0}
            activeTaskId={loopStatus.activeTaskId}
            onStatusChange={handleStatusChange}
            onDelete={handleDelete}
            onAddChild={handleAddChild}
            onApprove={approveTask}
            onReject={rejectTask}
          />
        ))}
      </div>
    </CollapsibleSection>
  );
}
