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

function upsertInTree(tasks: Task[], task: Task): Task[] {
  // If the task exists at root level, replace it
  let found = false;
  const updated = tasks.map((t) => {
    if (t.id === task.id) {
      found = true;
      return { ...task, children: t.children };
    }
    // Check children recursively
    const updatedChildren = upsertInTree(t.children, task);
    if (updatedChildren !== t.children) {
      found = true;
      return { ...t, children: updatedChildren };
    }
    return t;
  });

  if (found) return updated;

  // New root task — append
  if (!task.parentId) {
    return [...tasks, task];
  }

  // New child task — find parent and append
  return tasks.map((t) => {
    if (t.id === task.parentId) {
      return { ...t, children: [...t.children, task] };
    }
    return { ...t, children: upsertInTree(t.children, task) };
  });
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
        const m = msg as unknown as { tasks: Task[] };
        setTasks(m.tasks);
      } else if (msg.type === 'task_updated') {
        const m = msg as unknown as { task: Task };
        setTasks((prev) => upsertInTree(prev, m.task));
      } else if (msg.type === 'task_deleted') {
        const m = msg as unknown as { taskId: string };
        setTasks((prev) => removeFromTree(prev, m.taskId));
      }
    });
    return unsub;
  }, []);

  const createTask = useCallback(async (input: TaskCreateInput) => {
    await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  }, []);

  const updateTask = useCallback(async (id: string, input: TaskUpdateInput) => {
    await fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  }, []);

  const deleteTask = useCallback(async (id: string) => {
    await fetch(`/api/tasks/${id}`, {
      method: 'DELETE',
    });
  }, []);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return { loading, tasks, createTask, updateTask, deleteTask, refresh };
}
