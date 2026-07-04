export type TaskStatus =
  | 'pending'
  | 'active'
  | 'done'
  | 'pending_review'
  | 'blocked'
  | 'skipped'
  | 'failed';

export type SessionPolicy = 'reuse' | 'spawn' | 'auto';

export type StageType = 'agent_work' | 'wait_for_signal' | 'human_review';

export interface Task {
  id: string;
  parentId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  sessionId: string | null;
  sessionPolicy: SessionPolicy;
  priority: number;
  depth: number;
  annotations: string[];
  summary: string | null;
  requiresApproval: boolean;
  tokenUsage: number;
  claimedBy: string | null;
  claimedAt: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  stageType: StageType | null;
  gateConfig: Record<string, unknown> | null;
  artifacts: Record<string, unknown> | null;
  retryCount: number;
  maxRetries: number;
  templateId: string | null;
  children: Task[];
}

export interface LoopStatus {
  state: 'idle' | 'running' | 'paused';
  goalId: string | null;
  activeTaskId: string | null;
  progress: { done: number; total: number } | null;
  specMode: boolean;
  awaitingApproval: boolean;
  spawnEnabled: boolean;
}

export interface TasksState {
  tree: Task[];
  loopStatus: LoopStatus;
}

export const INITIAL_TASKS_STATE: TasksState = {
  tree: [],
  loopStatus: {
    state: 'idle',
    goalId: null,
    activeTaskId: null,
    progress: null,
    specMode: false,
    awaitingApproval: false,
    spawnEnabled: false,
  },
};
