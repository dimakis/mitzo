import { useState, useEffect, useCallback } from 'react';
import type { Task, LoopStatus } from '../types/task';
import { wsSubscribe } from '../lib/ws-pool';
import type { WsMsg } from '../lib/ws-pool';

export interface TaskCreateInput {
  title: string;
  parentId?: string;
  description?: string;
  priority?: number;
  sessionPolicy?: string;
  annotations?: string[];
}

export interface TaskUpdateInput {
  title?: string;
  description?: string;
  status?: string;
  priority?: number;
  sessionPolicy?: string;
  annotations?: string[];
  summary?: string;
  requiresApproval?: boolean;
}

export interface UseTaskBoardResult {
  loading: boolean;
  tasks: Task[];
  loopStatus: LoopStatus;
  createTask: (input: TaskCreateInput) => Promise<void>;
  updateTask: (id: string, input: TaskUpdateInput) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  startLoop: (goalId: string, specMode?: boolean) => Promise<void>;
  pauseLoop: () => Promise<void>;
  resumeLoop: () => Promise<void>;
  stopLoop: () => Promise<void>;
  approveTask: (id: string) => Promise<void>;
  rejectTask: (id: string, feedback: string) => Promise<void>;
  approveSpec: () => Promise<void>;
  rejectSpec: () => Promise<void>;
  refresh: () => void;
}

function removeFromTree(tasks: Task[], id: string): Task[] {
  return tasks
    .filter((t) => t.id !== id)
    .map((t) => ({
      ...t,
      children: removeFromTree(t.children, id),
    }));
}

function upsertInTree(tasks: Task[], task: Task): [Task[], boolean] {
  let found = false;
  const updated = tasks.map((t) => {
    if (t.id === task.id) {
      found = true;
      return { ...task, children: task.children.length > 0 ? task.children : t.children };
    }
    if (t.children.length > 0) {
      const [updatedChildren, childFound] = upsertInTree(t.children, task);
      if (childFound) {
        found = true;
        return { ...t, children: updatedChildren };
      }
    }
    return t;
  });

  if (found) return [updated, true];

  // New root task — append
  if (!task.parentId) {
    return [[...tasks, task], true];
  }

  // New child task — find parent and append
  let inserted = false;
  const withChild = tasks.map((t) => {
    if (t.id === task.parentId) {
      inserted = true;
      return { ...t, children: [...t.children, task] };
    }
    if (t.children.length > 0) {
      const [updatedChildren, childInserted] = upsertInTree(t.children, task);
      if (childInserted) {
        inserted = true;
        return { ...t, children: updatedChildren };
      }
    }
    return t;
  });
  return [inserted ? withChild : tasks, inserted];
}

const IDLE_STATUS: LoopStatus = {
  state: 'idle',
  goalId: null,
  activeTaskId: null,
  progress: null,
  specMode: false,
  awaitingApproval: false,
};

export function useTaskBoard(): UseTaskBoardResult {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loopStatus, setLoopStatus] = useState<LoopStatus>(IDLE_STATUS);

  // Fetch tasks from REST API
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetch('/api/tasks')
      .then((r) => {
        if (!r.ok) throw new Error(`Task API returned ${r.status}`);
        return r.json();
      })
      .then((result: { tasks: Task[] }) => {
        if (!cancelled) {
          setTasks(result.tasks);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTasks([]);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // Subscribe to WS events
  useEffect(() => {
    const unsub = wsSubscribe('global', (msg: WsMsg) => {
      if (msg.type === 'task_state') {
        setTasks(msg.tasks);
      } else if (msg.type === 'task_updated') {
        setTasks((prev) => upsertInTree(prev, msg.task)[0]);
      } else if (msg.type === 'task_deleted') {
        setTasks((prev) => removeFromTree(prev, msg.taskId));
      } else if (msg.type === 'loop_status') {
        setLoopStatus({
          state: msg.state,
          goalId: msg.goalId,
          activeTaskId: msg.activeTaskId,
          progress: msg.progress,
          specMode: msg.specMode,
          awaitingApproval: msg.awaitingApproval,
        });
      }
    });
    return unsub;
  }, []);

  // Fetch initial loop status
  useEffect(() => {
    fetch('/api/loop/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((status) => {
        if (status) setLoopStatus(status);
      })
      .catch(() => {});
  }, []);

  const createTask = useCallback(async (input: TaskCreateInput) => {
    const r = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!r.ok) throw new Error(`Create task failed: ${r.status}`);
  }, []);

  const updateTask = useCallback(async (id: string, input: TaskUpdateInput) => {
    const r = await fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!r.ok) throw new Error(`Update task failed: ${r.status}`);
  }, []);

  const deleteTask = useCallback(async (id: string) => {
    const r = await fetch(`/api/tasks/${id}`, {
      method: 'DELETE',
    });
    if (!r.ok) throw new Error(`Delete task failed: ${r.status}`);
  }, []);

  const startLoop = useCallback(async (goalId: string, specMode?: boolean) => {
    const r = await fetch('/api/loop/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goalId, specMode }),
    });
    if (!r.ok) throw new Error(`Start loop failed: ${r.status}`);
  }, []);

  const pauseLoop = useCallback(async () => {
    const r = await fetch('/api/loop/pause', { method: 'POST' });
    if (!r.ok) throw new Error(`Pause loop failed: ${r.status}`);
  }, []);

  const resumeLoop = useCallback(async () => {
    const r = await fetch('/api/loop/resume', { method: 'POST' });
    if (!r.ok) throw new Error(`Resume loop failed: ${r.status}`);
  }, []);

  const stopLoop = useCallback(async () => {
    const r = await fetch('/api/loop/stop', { method: 'POST' });
    if (!r.ok) throw new Error(`Stop loop failed: ${r.status}`);
  }, []);

  const approveTask = useCallback(async (id: string) => {
    const r = await fetch(`/api/tasks/${id}/approve`, { method: 'POST' });
    if (!r.ok) throw new Error(`Approve task failed: ${r.status}`);
  }, []);

  const rejectTask = useCallback(async (id: string, feedback: string) => {
    const r = await fetch(`/api/tasks/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback }),
    });
    if (!r.ok) throw new Error(`Reject task failed: ${r.status}`);
  }, []);

  const approveSpec = useCallback(async () => {
    const r = await fetch('/api/loop/spec/approve', { method: 'POST' });
    if (!r.ok) throw new Error(`Approve spec failed: ${r.status}`);
  }, []);

  const rejectSpec = useCallback(async () => {
    const r = await fetch('/api/loop/spec/reject', { method: 'POST' });
    if (!r.ok) throw new Error(`Reject spec failed: ${r.status}`);
  }, []);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return {
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
  };
}
