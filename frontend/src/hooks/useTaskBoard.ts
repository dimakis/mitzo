import { useState, useEffect, useCallback, useMemo } from 'react';
import { useMitzoStore } from '@mitzo/client/hooks';
import type { Task, TaskStatus, LoopStatus } from '../types/task';
import { eventBus } from '../lib/event-bus-singleton';
import { formatRelativeTime, formatDuration } from '../lib/formatTime';

// ─── Display Meta ──────────────────────────────────────────────────────────

export interface TaskDisplayMeta {
  attendTier: 1 | 2 | 3 | 4;
  fadeOpacity: number;
  completedAgo?: string;
  elapsedLabel?: string;
  sessionHash?: string;
  blockerSummary?: string;
}

export interface AttendCounts {
  t1: number;
  t2: number;
  t3: number;
}

// ─── Pure helpers ──────────────────────────────────────────────────────────

const FADE_START_MS = 5 * 60 * 1000; // 5 minutes
const FADE_END_MS = 30 * 60 * 1000; // 30 minutes

function getAttendTier(status: TaskStatus): 1 | 2 | 3 | 4 {
  switch (status) {
    case 'pending_review':
    case 'blocked':
    case 'failed':
      return 1;
    case 'done':
      return 2;
    case 'active':
      return 3;
    default:
      return 4;
  }
}

function computeFadeOpacity(completedAt: number | null): number {
  if (!completedAt) return 1;
  const elapsed = Date.now() - completedAt;
  if (elapsed < FADE_START_MS) return 1;
  if (elapsed >= FADE_END_MS) return 0;
  // Linear fade from 1 → 0.5 between 5min and 30min
  return 0.5 + 0.5 * (1 - (elapsed - FADE_START_MS) / (FADE_END_MS - FADE_START_MS));
}

function buildDisplayMeta(task: Task, now: number): TaskDisplayMeta {
  const tier = getAttendTier(task.status);
  const meta: TaskDisplayMeta = {
    attendTier: tier,
    fadeOpacity: task.status === 'done' ? computeFadeOpacity(task.completedAt) : 1,
  };

  if (task.status === 'done' && task.completedAt) {
    meta.completedAgo = formatRelativeTime(task.completedAt);
  }
  if (task.status === 'active' && task.claimedAt) {
    meta.elapsedLabel = formatDuration(now - task.claimedAt);
  }
  if (task.sessionId) {
    meta.sessionHash = task.sessionId.slice(0, 6);
  }
  if ((task.status === 'blocked' || task.status === 'failed') && task.annotations.length > 0) {
    meta.blockerSummary = task.annotations[0];
  }

  return meta;
}

function collectDisplayMeta(tasks: Task[], now: number, map: Map<string, TaskDisplayMeta>): void {
  for (const task of tasks) {
    map.set(task.id, buildDisplayMeta(task, now));
    if (task.children.length > 0) {
      collectDisplayMeta(task.children, now, map);
    }
  }
}

function countAttendTiers(tasks: Task[], counts: AttendCounts): void {
  for (const task of tasks) {
    const tier = getAttendTier(task.status);
    if (tier === 1) counts.t1++;
    else if (tier === 2) counts.t2++;
    else if (tier === 3) counts.t3++;
    if (task.children.length > 0) {
      countAttendTiers(task.children, counts);
    }
  }
}

function sortByAttendTier(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const tierA = getAttendTier(a.status);
    const tierB = getAttendTier(b.status);
    if (tierA !== tierB) return tierA - tierB;

    // Within same tier, secondary sort
    if (tierA === 1) {
      // T1: oldest first (needs attention longest)
      return a.updatedAt - b.updatedAt;
    }
    if (tierA === 2) {
      // T2: newest first (most recent completion on top)
      return (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt);
    }
    // T3, T4: preserve tree position (stable sort by priority then creation)
    return a.priority - b.priority || a.createdAt - b.createdAt;
  });
}

function sumTokenUsage(tasks: Task[]): number {
  let total = 0;
  for (const task of tasks) {
    total += task.tokenUsage;
    if (task.children.length > 0) {
      total += sumTokenUsage(task.children);
    }
  }
  return total;
}

// ─── Input/Result types ────────────────────────────────────────────────────

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
  sortedTasks: Task[];
  displayMeta: Map<string, TaskDisplayMeta>;
  attendCounts: AttendCounts;
  totalTokenUsage: number;
  showAll: boolean;
  setShowAll: (v: boolean) => void;
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

// ─── Hook ──────────────────────────────────────────────────────────────────

export function useTaskBoard(): UseTaskBoardResult {
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [now, setNow] = useState(Date.now);

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

  // Fade timer — recompute every 60s for done task opacity
  useEffect(() => {
    const hasDone = tasks.some(
      (t) => t.status === 'done' || t.children.some((c) => c.status === 'done'),
    );
    if (!hasDone) return;
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, [tasks]);

  // Sorted tasks (root level only; children keep tree order)
  const sortedTasks = useMemo(() => (showAll ? tasks : sortByAttendTier(tasks)), [tasks, showAll]);

  // Display meta for all tasks
  const displayMeta = useMemo(() => {
    const map = new Map<string, TaskDisplayMeta>();
    collectDisplayMeta(tasks, now, map);
    return map;
  }, [tasks, now]);

  // Attend counts
  const attendCounts = useMemo(() => {
    const counts: AttendCounts = { t1: 0, t2: 0, t3: 0 };
    countAttendTiers(tasks, counts);
    return counts;
  }, [tasks]);

  // Total token usage
  const totalTokenUsage = useMemo(() => sumTokenUsage(tasks), [tasks]);

  return {
    loading,
    tasks,
    sortedTasks,
    displayMeta,
    attendCounts,
    totalTokenUsage,
    showAll,
    setShowAll,
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
