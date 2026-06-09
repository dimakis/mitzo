import type { TaskStore, Task, GateConfig } from './task-store.js';
import type { WorkloadStore } from './workload-store.js';
import { sendToChat } from './chat.js';
import { createLogger } from './logger.js';

const log = createLogger('task-orchestrator');

export type LoopState = 'idle' | 'running' | 'paused';

export interface LoopStatus {
  state: LoopState;
  goalId: string | null;
  activeTaskId: string | null;
  progress: { done: number; total: number } | null;
  specMode: boolean;
  awaitingApproval: boolean;
}

export interface StartOptions {
  specMode?: boolean;
}

export interface OrchestratorDeps {
  store: TaskStore;
  workloadStore?: WorkloadStore;
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
  /** Get active session IDs for orphan detection */
  getActiveSessionIds?: () => Set<string>;
  /** Register a signal watch for a wait_for_signal task */
  watchSignal?: (taskId: string, gateConfig: GateConfig) => void;
  /** Spawn a new headless session for a task. Returns clientId or null on failure. */
  spawnSession?: (taskId: string, prompt: string, goalId: string) => Promise<string | null>;
}

export class TaskOrchestrator {
  private state: LoopState = 'idle';
  private goalId: string | null = null;
  private activeTaskId: string | null = null;
  private specMode = false;
  private awaitingApproval = false;
  private pinnedClientId: string | null = null;
  private deps: OrchestratorDeps;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  getPinnedClientId(): string | null {
    return this.pinnedClientId;
  }

  getStatus(): LoopStatus {
    const progress = this.goalId ? this.computeProgress(this.goalId) : null;
    return {
      state: this.state,
      goalId: this.goalId,
      activeTaskId: this.activeTaskId,
      progress,
      specMode: this.specMode,
      awaitingApproval: this.awaitingApproval,
    };
  }

  start(goalId: string, opts?: StartOptions): LoopStatus {
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
    this.specMode = opts?.specMode ?? false;
    this.awaitingApproval = false;
    this.pinnedClientId = this.deps.getClientId();

    log.info('orchestrator started', {
      goalId,
      title: goal.title,
      specMode: this.specMode,
    });

    if (this.specMode) {
      // In spec mode, assign goal directly for decomposition
      this.activeTaskId = goalId;
      this.deps.store.update(goalId, { status: 'active' });
      this.deps.setTaskContext(goalId, goalId);
      this.deps.broadcastTasks();
      this.deps.broadcastStatus(this.getStatus());

      if (this.pinnedClientId) {
        sendToChat(
          this.pinnedClientId,
          `Decompose this goal into subtasks: "${goal.title}"\n` +
            (goal.description ? `\nDetails: ${goal.description}\n` : '') +
            '\nUse TaskSet to create a task breakdown. ' +
            'Do NOT start working yet — just plan.',
        );
      }
    } else {
      this.broadcastAndTick();
    }

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
    this.specMode = false;
    this.awaitingApproval = false;
    this.pinnedClientId = null;
    this.deps.clearTaskContext();
    log.info('orchestrator stopped');
    this.deps.broadcastStatus(this.getStatus());
    return this.getStatus();
  }

  /** Called when TaskSet is used in spec mode — pause for approval. */
  onSpecDecomposed(): void {
    if (!this.specMode || this.state !== 'running') return;
    this.awaitingApproval = true;
    this.state = 'paused';
    log.info('spec mode: awaiting approval');
    this.deps.broadcastStatus(this.getStatus());
  }

  /** Approve the spec mode decomposition — begin execution. */
  approveSpec(): LoopStatus {
    if (!this.awaitingApproval) return this.getStatus();
    this.awaitingApproval = false;
    this.specMode = false;
    this.state = 'running';
    log.info('spec mode: approved, beginning execution');
    this.broadcastAndTick();
    return this.getStatus();
  }

  /** Reject the spec mode decomposition — delete children and stop. */
  rejectSpec(): LoopStatus {
    if (!this.awaitingApproval || !this.goalId) return this.getStatus();
    // Delete proposed children
    const children = this.deps.store.getChildren(this.goalId);
    for (const child of children) {
      this.deps.store.delete(child.id);
    }
    this.deps.store.update(this.goalId, { status: 'pending' });
    this.awaitingApproval = false;
    this.specMode = false;
    log.info('spec mode: rejected, children deleted');
    this.deps.broadcastTasks();
    return this.stop();
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

  /** Approve a pending_review task → done + cascade + tick. */
  approveTask(taskId: string): boolean {
    const task = this.deps.store.get(taskId);
    if (!task || task.status !== 'pending_review') return false;

    this.deps.store.update(taskId, { status: 'done' });
    this.deps.store.cascadeStatus(taskId);
    this.deps.broadcastTasks();

    log.info('task approved', { taskId });
    if (this.state === 'running') this.tick();
    return true;
  }

  /** Reject a pending_review task → active + feedback + tick. */
  rejectTask(taskId: string, feedback: string): boolean {
    const task = this.deps.store.get(taskId);
    if (!task || task.status !== 'pending_review') return false;

    const annotations = [...task.annotations, `review_feedback: ${feedback}`];
    this.deps.store.update(taskId, {
      status: 'active',
      annotations,
    });
    this.deps.store.cascadeStatus(taskId);
    this.deps.broadcastTasks();

    log.info('task rejected', { taskId, feedback });

    // Notify agent session so it retries with feedback
    if (this.state === 'running') {
      if (this.pinnedClientId) {
        sendToChat(
          this.pinnedClientId,
          `Your previous work on "${task.title}" was rejected.\n` +
            (feedback ? `Feedback: ${feedback}\n` : '') +
            '\nPlease re-attempt this task addressing the feedback.',
        );
      }
    }
    return true;
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

    // Reclaim orphaned tasks
    if (this.deps.getActiveSessionIds) {
      const activeIds = this.deps.getActiveSessionIds();
      const orphans = this.deps.store.getOrphaned(activeIds);
      for (const orphan of orphans) {
        log.info('reclaiming orphaned task', { taskId: orphan.id });
        this.deps.store.update(orphan.id, { status: 'pending' });
        this.deps.store.setSessionId(orphan.id, null);
      }
    }

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

      // Lifecycle sync: complete linked TodoItems when goal completes
      if (goalStatus === 'done' && this.deps.workloadStore) {
        this.deps.workloadStore.completeByGoal(this.goalId);
        log.info('completed linked workload items', { goalId: this.goalId });
      }

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

    // Dispatch based on stage type
    const stageType = next.stageType ?? 'agent_work';

    switch (stageType) {
      case 'wait_for_signal': {
        // Set active but don't assign to agent — register with SignalProcessor
        this.activeTaskId = next.id;
        this.deps.store.update(next.id, { status: 'active' });
        this.deps.store.cascadeStatus(next.id);
        this.deps.broadcastTasks();
        this.deps.broadcastStatus(this.getStatus());

        if (this.deps.watchSignal && next.gateConfig) {
          this.deps.watchSignal(next.id, next.gateConfig);
          log.info('registered signal watch', { taskId: next.id, type: next.gateConfig.type });
        } else {
          log.warn('wait_for_signal task has no gate config or watchSignal not wired', {
            taskId: next.id,
          });
        }
        break;
      }

      case 'human_review': {
        // Go straight to pending_review — reuse existing approval flow
        this.activeTaskId = next.id;
        this.deps.store.update(next.id, { status: 'pending_review' });
        this.deps.store.cascadeStatus(next.id);
        this.deps.broadcastTasks();
        this.deps.broadcastStatus(this.getStatus());
        log.info('human review task awaiting approval', { taskId: next.id });
        break;
      }

      case 'agent_work':
      default: {
        const policy = next.sessionPolicy ?? 'reuse';

        if (policy === 'spawn' && this.deps.spawnSession) {
          // Spawn a dedicated headless session for this task
          this.deps.store.update(next.id, { status: 'active' });
          this.deps.store.cascadeStatus(next.id);
          this.deps.broadcastTasks();
          this.deps.broadcastStatus(this.getStatus());

          const prompt = this.buildTaskPrompt(next);
          this.deps.spawnSession(next.id, prompt, this.goalId).then(
            (clientId) => {
              if (clientId) {
                this.deps.store.setSessionId(next.id, clientId);
                log.info('spawned session for task', { taskId: next.id, clientId });
              } else {
                log.error('failed to spawn session, falling back to pinned', { taskId: next.id });
                this.deps.setTaskContext(next.id, this.goalId!);
                if (this.pinnedClientId) sendToChat(this.pinnedClientId, prompt);
              }
            },
            (err) => {
              log.error('spawnSession threw', { taskId: next.id, error: (err as Error).message });
              this.deps.store.update(next.id, { status: 'pending' });
              this.deps.store.cascadeStatus(next.id);
            },
          );

          // Don't set activeTaskId — spawned tasks run independently.
          // Continue ticking to find more parallel work.
          this.tick();
        } else {
          // Reuse pinned session (original behavior)
          this.activeTaskId = next.id;
          this.deps.store.update(next.id, { status: 'active' });
          this.deps.store.cascadeStatus(next.id);
          this.deps.setTaskContext(next.id, this.goalId);
          this.deps.broadcastTasks();
          this.deps.broadcastStatus(this.getStatus());

          if (this.pinnedClientId) {
            const prompt = this.buildTaskPrompt(next);
            sendToChat(this.pinnedClientId, prompt);
          }
        }
        break;
      }
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
