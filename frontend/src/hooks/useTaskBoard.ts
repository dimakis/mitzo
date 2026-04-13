import { useState, useEffect, useCallback } from 'react';
import type { Task } from '../types/task';
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
  createTask: (input: TaskCreateInput) => Promise<void>;
  updateTask: (id: string, input: TaskUpdateInput) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
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
      return { ...task, children: t.children };
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

export function useTaskBoard(): UseTaskBoardResult {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

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
      }
    });
    return unsub;
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

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return { loading, tasks, createTask, updateTask, deleteTask, refresh };
}
