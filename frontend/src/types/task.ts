export type TaskStatus =
  | 'pending'
  | 'active'
  | 'done'
  | 'pending_review'
  | 'blocked'
  | 'skipped'
  | 'failed';

export type SessionPolicy = 'reuse' | 'spawn' | 'auto';

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
  children: Task[];
}
