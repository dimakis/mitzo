import { useState } from 'react';
import { TaskNode } from '../components/TaskNode';
import { TaskCreateForm } from '../components/TaskCreateForm';
import { WorkflowCreateForm } from '../components/WorkflowCreateForm';
import { LoopControls } from '../components/LoopControls';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { useTaskBoard } from '../hooks/useTaskBoard';
import type { TaskStatus } from '../types/task';

export function TaskBoard() {
  const {
    loading,
    tasks,
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

  return (
    <div className="task-board-page">
      <PageHeader title="Tasks" badge={tasks.length || undefined}>
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
        <button className="task-board-refresh" onClick={refresh} title="Refresh">
          &#x21bb;
        </button>
      </PageHeader>

      <LoopControls
        loopStatus={loopStatus}
        goals={goals}
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

      {loading && <p className="task-board-empty">Loading...</p>}

      {!loading && tasks.length === 0 && (
        <EmptyState icon={'\u2610'} title="No tasks yet" subtitle="Add a task to get started" />
      )}

      <div className="task-board-list">
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
    </div>
  );
}
