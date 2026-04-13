import type { TaskStore, Task } from './task-store.js';
import { sendToChat } from './chat.js';
import { createLogger } from './logger.js';

const log = createLogger('task-orchestrator');

export type LoopState = 'idle' | 'running' | 'paused';

export interface LoopStatus {
  state: LoopState;
  goalId: string | null;
  activeTaskId: string | null;
  progress: { done: number; total: number } | null;
}

export interface OrchestratorDeps {
  store: TaskStore;
  /** Resolve session's clientId for the reuse session */
  getClientId: () => string | null;
  /** Set task context on the session */
  setTaskContext: (taskId: string, goalId: string) => void;
  /** Clear task context on the session */
  clearTaskContext: () => void;
  /** Broadcast loop status change */
  broadcastStatus: (status: LoopStatus) => void;
  /** Broadcast task tree change */
  broadcastTasks: () => void;
}

export class TaskOrchestrator {
  private state: LoopState = 'idle';
  private goalId: string | null = null;
  private activeTaskId: string | null = null;
  private deps: OrchestratorDeps;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  getStatus(): LoopStatus {
    const progress = this.goalId ? this.computeProgress(this.goalId) : null;
    return {
      state: this.state,
      goalId: this.goalId,
      activeTaskId: this.activeTaskId,
      progress,
    };
  }

  start(goalId: string): LoopStatus {
    if (this.state === 'running') {
      log.warn('start() called while already running');
      return this.getStatus();
    }

    const goal = this.deps.store.get(goalId);
    if (!goal) {
      log.error('start() with nonexistent goalId', { goalId });
      return this.getStatus();
    }

    this.state = 'running';
    this.goalId = goalId;
    this.activeTaskId = null;

    log.info('orchestrator started', { goalId, title: goal.title });
    this.broadcastAndTick();

    return this.getStatus();
  }

  pause(): LoopStatus {
    if (this.state !== 'running') return this.getStatus();
    this.state = 'paused';
    log.info('orchestrator paused');
    this.deps.broadcastStatus(this.getStatus());
    return this.getStatus();
  }

  resume(): LoopStatus {
    if (this.state !== 'paused') return this.getStatus();
    this.state = 'running';
    log.info('orchestrator resumed');
    this.broadcastAndTick();
    return this.getStatus();
  }

  stop(): LoopStatus {
    if (this.state === 'idle') return this.getStatus();
    this.state = 'idle';
    this.goalId = null;
    this.activeTaskId = null;
    this.deps.clearTaskContext();
    log.info('orchestrator stopped');
    this.deps.broadcastStatus(this.getStatus());
    return this.getStatus();
  }

  /** Called when a task completes (from tool interception). */
  onTaskCompleted(taskId: string): void {
    if (this.state !== 'running') return;
    log.info('task completed, triggering tick', { taskId });
    this.tick();
  }

  /** Called when a task is blocked (from tool interception). */
  onTaskBlocked(taskId: string): void {
    if (this.state !== 'running') return;
    log.info('task blocked, triggering tick', { taskId });
    this.tick();
  }

  /**
   * Core loop iteration. Stateless — re-reads state from SQLite.
   * 1. Find next executable task (DFS)
   * 2. Assign it to the session
   * 3. Inject task context
   * 4. Send prompt to agent
   */
  tick(): void {
    if (this.state !== 'running' || !this.goalId) return;

    // Re-read goal state (statelessness invariant)
    const goal = this.deps.store.get(this.goalId);
    if (!goal) {
      log.error('goal disappeared during tick', { goalId: this.goalId });
      this.stop();
      return;
    }

    // Check if goal is complete
    const goalStatus = this.deps.store.deriveParentStatus(this.goalId);
    if (goalStatus === 'done' || goalStatus === 'failed') {
      log.info('goal reached terminal state', {
        goalId: this.goalId,
        status: goalStatus,
      });
      this.stop();
      return;
    }

    // Find next executable task
    const next = this.deps.store.getNextExecutable(this.goalId);
    if (!next) {
      // No executable tasks — could be all blocked or pending_review
      log.info('no executable tasks found', { goalId: this.goalId });
      this.state = 'paused';
      this.deps.broadcastStatus(this.getStatus());
      return;
    }

    // Assign task
    this.activeTaskId = next.id;
    this.deps.store.update(next.id, { status: 'active' });
    this.deps.store.cascadeStatus(next.id);

    // Set task context on session
    this.deps.setTaskContext(next.id, this.goalId);

    // Broadcast updates
    this.deps.broadcastTasks();
    this.deps.broadcastStatus(this.getStatus());

    // Send prompt to agent session
    const clientId = this.deps.getClientId();
    if (clientId) {
      const prompt = this.buildTaskPrompt(next);
      sendToChat(clientId, prompt);
    }
  }

  private broadcastAndTick(): void {
    this.deps.broadcastStatus(this.getStatus());
    this.tick();
  }

  private buildTaskPrompt(task: Task): string {
    return (
      `Work on this task: "${task.title}"\n` +
      (task.description ? `\nDetails: ${task.description}\n` : '') +
      '\nUse TaskStatus to see your context, TaskSet to decompose, ' +
      'and TaskComplete when done.'
    );
  }

  private computeProgress(goalId: string): { done: number; total: number } {
    const children = this.deps.store.getChildren(goalId);
    if (children.length === 0) return { done: 0, total: 0 };
    const done = children.filter((c) => c.status === 'done' || c.status === 'skipped').length;
    return { done, total: children.length };
  }
}
