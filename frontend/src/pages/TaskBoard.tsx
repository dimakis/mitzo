import { useState } from 'react';
import { TaskNode } from '../components/TaskNode';
import { TaskCreateForm } from '../components/TaskCreateForm';
import { WorkflowCreateForm } from '../components/WorkflowCreateForm';
import { LoopControls } from '../components/LoopControls';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { useTaskBoard } from '../hooks/useTaskBoard';
import type { Task, TaskStatus } from '../types/task';

// ─── Attention-tier sorting ────────────────────────────────────────────────

type AttendTier = 1 | 2 | 3 | 4;

const T1_STATUS_SET: Set<TaskStatus> = new Set(['pending_review', 'blocked', 'failed']);

/** Tier for a single task's own status */
function ownTier(status: TaskStatus): AttendTier {
  if (T1_STATUS_SET.has(status)) return 1;
  if (status === 'done') return 2;
  if (status === 'active') return 3;
  return 4; // pending, skipped
}

/** Effective tier: worst of own status and any descendant */
export function getTaskTier(task: Task): AttendTier {
  let worst = ownTier(task.status);
  for (const child of task.children) {
    const childTier = getTaskTier(child);
    if (childTier < worst) worst = childTier;
    if (worst === 1) break; // can't get worse
  }
  return worst;
}

/** Count T1 items recursively across entire tree (roots + all descendants) */
function countT1Recursive(tasks: Task[]): number {
  let count = 0;
  for (const t of tasks) {
    if (T1_STATUS_SET.has(t.status)) count++;
    if (t.children.length > 0) count += countT1Recursive(t.children);
  }
  return count;
}

/**
 * Sort root tasks by effective attention tier, with recency tiebreaker.
 * Only sorts root level — children retain tree order (rendered by TaskNode).
 * getTaskTier already considers descendant status, so a root with a blocked
 * child will bubble up even if the root itself is pending.
 */
export function sortByAttention(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const tierDiff = getTaskTier(a) - getTaskTier(b);
    if (tierDiff !== 0) return tierDiff;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

export function TaskBoard() {
  const {
    loading,
    tasks,
    sortedTasks,
    displayMeta,
    totalTokenUsage,
    showAll,
    setShowAll,
    loopStatus,
    createTask,
    updateTask,
    deleteTask,
    startLoop,
    pauseLoop,
    resumeLoop,
    stopLoop,
    approveTask,
    rejectTask,
    approveSpec,
    rejectSpec,
    refresh,
  } = useTaskBoard();
  const [creating, setCreating] = useState<{ parentId?: string } | null>(null);
  const [creatingWorkflow, setCreatingWorkflow] = useState(false);

  function handleStatusChange(id: string, status: TaskStatus) {
    updateTask(id, { status });
  }

  function handleDelete(id: string) {
    deleteTask(id);
  }

  function handleAddChild(parentId: string) {
    setCreating({ parentId });
  }

  function handleCreate(title: string, parentId?: string) {
    createTask({ title, parentId });
    setCreating(null);
  }

  // Root tasks with no parent serve as potential goals
  const goals = tasks.filter((t) => !t.parentId);

  const t1Count = countT1Recursive(tasks);

  return (
    <div className="task-board-page">
      <PageHeader title="Tasks" badge={t1Count > 0 ? t1Count : tasks.length || undefined}>
        <button
          className={`task-board-sort-btn${showAll ? '' : ' task-board-sort-btn--active'}`}
          onClick={() => setShowAll(!showAll)}
          title={showAll ? 'Sort by attention' : 'Show tree order'}
        >
          {showAll ? '\u2195' : '\u2B06'}
        </button>
        <button
          className="task-board-add-btn"
          onClick={() => setCreating({ parentId: undefined })}
          title="Add task"
        >
          +
        </button>
        <button
          className="task-board-add-btn"
          onClick={() => setCreatingWorkflow(true)}
          title="New workflow"
        >
          {'\u2699'}
        </button>
        <button
          className={`task-board-show-all${showAll ? ' task-board-show-all--active' : ''}`}
          onClick={() => setShowAll(!showAll)}
          title={showAll ? 'Sort by attention' : 'Show tree order'}
        >
          {showAll ? 'Tree' : 'Tiers'}
        </button>
        <button className="task-board-refresh" onClick={refresh} title="Refresh">
          &#x21bb;
        </button>
      </PageHeader>

      <LoopControls
        loopStatus={loopStatus}
        goals={goals}
        totalTokenUsage={totalTokenUsage}
        onStart={startLoop}
        onPause={pauseLoop}
        onResume={resumeLoop}
        onStop={stopLoop}
        onApproveSpec={approveSpec}
        onRejectSpec={rejectSpec}
      />

      {creating && (
        <TaskCreateForm
          parentId={creating.parentId}
          onCreate={handleCreate}
          onCancel={() => setCreating(null)}
        />
      )}

      {creatingWorkflow && (
        <WorkflowCreateForm
          onCreated={() => {
            setCreatingWorkflow(false);
            refresh();
          }}
          onCancel={() => setCreatingWorkflow(false)}
        />
      )}

      <div className="task-board-scroll">
        {loading && <p className="task-board-empty">Loading...</p>}

        {!loading && tasks.length === 0 && (
          <EmptyState icon={'\u2610'} title="No tasks yet" subtitle="Add a task to get started" />
        )}

        <div className="task-board-list">
          {sortedTasks.map((task) => (
            <TaskNode
              key={task.id}
              task={task}
              depth={0}
              activeTaskId={loopStatus.activeTaskId}
              displayMeta={displayMeta}
              onStatusChange={handleStatusChange}
              onDelete={handleDelete}
              onAddChild={handleAddChild}
              onApprove={approveTask}
              onReject={rejectTask}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
