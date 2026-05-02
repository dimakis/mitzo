import { useState, useEffect, useCallback } from 'react';
import { useMitzoStore } from '@mitzo/client/hooks';
import type { Task, LoopStatus } from '../types/task';
import { eventBus } from '../lib/event-bus-singleton';

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

export function useTaskBoard(): UseTaskBoardResult {
  const [loading, setLoading] = useState(true);
  const tasks = useMitzoStore((s) => s.tasks.tree);
  const loopStatus = useMitzoStore((s) => s.tasks.loopStatus);
  const loadTasks = useMitzoStore((s) => s.loadTasks);
  const loadLoopStatus = useMitzoStore((s) => s.loadLoopStatus);
  const storeCreateTask = useMitzoStore((s) => s.createTask);
  const storeUpdateTask = useMitzoStore((s) => s.updateTask);
  const storeDeleteTask = useMitzoStore((s) => s.deleteTask);
  const storeStartLoop = useMitzoStore((s) => s.startLoop);
  const storePauseLoop = useMitzoStore((s) => s.pauseLoop);
  const storeResumeLoop = useMitzoStore((s) => s.resumeLoop);
  const storeStopLoop = useMitzoStore((s) => s.stopLoop);
  const storeApproveTask = useMitzoStore((s) => s.approveTask);
  const storeRejectTask = useMitzoStore((s) => s.rejectTask);
  const storeApproveSpec = useMitzoStore((s) => s.approveSpec);
  const storeRejectSpec = useMitzoStore((s) => s.rejectSpec);
  const refreshTasks = useMitzoStore((s) => s.refreshTasks);

  useEffect(() => {
    Promise.all([loadTasks(), loadLoopStatus()]).finally(() => setLoading(false));
  }, [loadTasks, loadLoopStatus]);

  // Live updates via SSE
  useEffect(() => {
    const unsubLoop = eventBus.on('loop_status', () => {
      loadLoopStatus();
    });
    const unsubTask = eventBus.on('task_state', () => {
      refreshTasks();
    });
    return () => {
      unsubLoop();
      unsubTask();
    };
  }, [loadLoopStatus, refreshTasks]);

  return {
    loading,
    tasks,
    loopStatus,
    createTask: useCallback(
      (input: TaskCreateInput) => storeCreateTask(input as unknown as Record<string, unknown>),
      [storeCreateTask],
    ),
    updateTask: useCallback(
      (id: string, input: TaskUpdateInput) =>
        storeUpdateTask(id, input as unknown as Record<string, unknown>),
      [storeUpdateTask],
    ),
    deleteTask: storeDeleteTask,
    startLoop: storeStartLoop,
    pauseLoop: storePauseLoop,
    resumeLoop: storeResumeLoop,
    stopLoop: storeStopLoop,
    approveTask: storeApproveTask,
    rejectTask: storeRejectTask,
    approveSpec: storeApproveSpec,
    rejectSpec: storeRejectSpec,
    refresh: refreshTasks,
  };
}
