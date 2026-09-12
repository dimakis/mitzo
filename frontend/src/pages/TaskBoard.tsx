import { useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { AgentTaskWorkspace } from '../components/AgentTaskWorkspace';
import { TaskNode } from '../components/TaskNode';
import { TaskCreateForm } from '../components/TaskCreateForm';
import { WorkflowCreateForm } from '../components/WorkflowCreateForm';
import { LoopControls } from '../components/LoopControls';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';
import { useTaskBoard } from '../hooks/useTaskBoard';
import type { Task, TaskStatus } from '../types/task';

const T1_STATUS_SET: Set<TaskStatus> = new Set(['pending_review', 'blocked', 'failed']);

/** Count T1 items recursively across entire tree (roots + all descendants) */
function countT1Recursive(tasks: Task[]): number {
  let count = 0;
  for (const t of tasks) {
    if (T1_STATUS_SET.has(t.status)) count++;
    if (t.children.length > 0) count += countT1Recursive(t.children);
  }
  return count;
}

export function TaskBoard({ desktop = false }: { desktop?: boolean } = {}) {
  const [boardView, setBoardView] = useState(desktop);
  const [searchParams, setSearchParams] = useSearchParams();
  const { hash } = useLocation();
  const selectedId =
    searchParams.get('highlight') ?? (hash.startsWith('#task-') ? hash.slice(6) : null);
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
    setSpawnEnabled,
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
  const { spawnEnabled } = loopStatus;

  function renderTask(task: Task, inspect = false) {
    return (
      <TaskNode
        key={task.id}
        task={task}
        depth={0}
        activeTaskId={loopStatus.activeTaskId}
        displayMeta={
          inspect
            ? new Map([...displayMeta].map(([id, meta]) => [id, { ...meta, fadeOpacity: 1 }]))
            : displayMeta
        }
        onStatusChange={handleStatusChange}
        onDelete={handleDelete}
        onAddChild={handleAddChild}
        onApprove={approveTask}
        onReject={rejectTask}
      />
    );
  }

  return (
    <div className={`task-board-page${desktop ? ' task-board-desktop' : ''}`}>
      {desktop && (
        <WorkspacePageHeading
          className="agent-page-heading"
          eyebrow="Agents"
          title="Work in motion"
          description="Execution state, review decisions and recorded usage."
        />
      )}
      <PageHeader
        title={desktop ? 'Executions' : 'Tasks'}
        badge={t1Count > 0 ? t1Count : tasks.length || undefined}
      >
        <button
          className={`task-board-add-btn ${spawnEnabled ? 'cc-spawn-enabled' : 'cc-spawn-disabled'}`}
          onClick={() => setSpawnEnabled(!spawnEnabled)}
          title={spawnEnabled ? 'Disable session spawning' : 'Enable session spawning'}
        >
          {spawnEnabled ? '\u26A1' : '\u26D4'}
        </button>
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

      {desktop && (
        <div className="agent-view-switch" role="group" aria-label="Task view">
          <button aria-pressed={boardView} onClick={() => setBoardView(true)}>
            Board
          </button>
          <button aria-pressed={!boardView} onClick={() => setBoardView(false)}>
            Tree and attention
          </button>
        </div>
      )}

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

        {desktop && boardView ? (
          <AgentTaskWorkspace
            tasks={tasks}
            selectedId={selectedId}
            onSelect={(id) =>
              setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.set('highlight', id);
                return next;
              })
            }
            renderTask={(task) => renderTask(task, true)}
          />
        ) : (
          <div className="task-board-list">{sortedTasks.map((task) => renderTask(task))}</div>
        )}
      </div>
    </div>
  );
}
