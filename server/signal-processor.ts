import { execFile } from 'child_process';
import { promisify } from 'util';
import type { TaskStore, GateConfig } from './task-store.js';
import { createLogger } from './logger.js';

const log = createLogger('signal-processor');
const execFileAsync = promisify(execFile);

export interface GateResult {
  resolved: boolean;
  status: 'pass' | 'fail';
  artifacts?: Record<string, unknown>;
}

interface WatchEntry {
  taskId: string;
  gateConfig: GateConfig;
  intervalId: NodeJS.Timeout | null; // null for non-polling gates (human_approval)
}

/** Default polling intervals by gate type (milliseconds). */
const POLL_INTERVALS: Record<string, number> = {
  gh_ci: 30_000,
  gh_review: 60_000,
  centaur_review: 30_000,
  compound: 30_000,
};

/**
 * Watches external signals for wait_for_signal tasks.
 * Polls GitHub/Centaur status or waits for manual resolution.
 */
export class SignalProcessor {
  private watches = new Map<string, WatchEntry>();
  private store: TaskStore;
  private onSignalResolved: (taskId: string) => void;

  constructor(store: TaskStore, onSignalResolved: (taskId: string) => void) {
    this.store = store;
    this.onSignalResolved = onSignalResolved;
  }

  watch(taskId: string, gateConfig: GateConfig): void {
    if (this.watches.has(taskId)) {
      log.warn('already watching task', { taskId });
      return;
    }

    const interval = POLL_INTERVALS[gateConfig.type];
    let intervalId: NodeJS.Timeout | null = null;

    if (interval && gateConfig.type !== 'human_approval') {
      intervalId = setInterval(() => this.poll(taskId), interval);
      log.info('started polling', { taskId, type: gateConfig.type, intervalMs: interval });
    } else {
      log.info('watching for manual signal', { taskId, type: gateConfig.type });
    }

    this.watches.set(taskId, { taskId, gateConfig, intervalId });
  }

  unwatch(taskId: string): void {
    const entry = this.watches.get(taskId);
    if (!entry) return;
    if (entry.intervalId) clearInterval(entry.intervalId);
    this.watches.delete(taskId);
    log.info('unwatched task', { taskId });
  }

  unwatchAll(): void {
    for (const [taskId, entry] of this.watches) {
      if (entry.intervalId) clearInterval(entry.intervalId);
      log.info('unwatched task', { taskId });
    }
    this.watches.clear();
  }

  isWatching(taskId: string): boolean {
    return this.watches.has(taskId);
  }

  /** Manually resolve a signal (used by REST endpoint or webhook push). */
  resolveSignal(
    taskId: string,
    result: { status: 'pass' | 'fail'; artifacts?: Record<string, unknown> },
  ): void {
    this.unwatch(taskId);
    const task = this.store.get(taskId);
    if (!task) {
      log.error('resolveSignal: task not found', { taskId });
      return;
    }

    if (result.status === 'pass') {
      this.store.update(taskId, {
        status: 'done',
        summary: `Signal resolved: ${task.gateConfig?.type ?? 'unknown'} passed`,
        artifacts: result.artifacts,
      });
      this.store.cascadeStatus(taskId);
      log.info('signal passed', { taskId, type: task.gateConfig?.type });
    } else {
      this.handleFailure(task.id, result.artifacts);
    }

    this.onSignalResolved(taskId);
  }

  /** Poll a gate and resolve if ready. */
  private async poll(taskId: string): Promise<void> {
    const entry = this.watches.get(taskId);
    if (!entry) return;

    try {
      const result = await checkGate(entry.gateConfig);
      if (result.resolved) {
        this.resolveSignal(taskId, { status: result.status, artifacts: result.artifacts });
      }
    } catch (err) {
      log.error('poll error', { taskId, error: (err as Error).message });
    }
  }

  /** Handle a failed gate — retry or mark failed. */
  private handleFailure(
    taskId: string,
    artifacts?: Record<string, unknown>,
  ): void {
    const task = this.store.get(taskId);
    if (!task) return;

    if (task.maxRetries > 0 && task.retryCount < task.maxRetries) {
      // Store failure context in annotations
      const failAnnotation = `retry_${task.retryCount}: ${JSON.stringify(artifacts ?? {})}`;
      const annotations = [...task.annotations, failAnnotation];

      // Reset this task to pending with incremented retry count
      this.store.update(taskId, {
        status: 'pending',
        retryCount: task.retryCount + 1,
        annotations,
      });

      // Find and reset the preceding agent_work sibling so it can fix the issue
      this.resetPrecedingSibling(task);

      this.store.cascadeStatus(taskId);
      log.info('signal failed, retrying', {
        taskId,
        retryCount: task.retryCount + 1,
        maxRetries: task.maxRetries,
      });
    } else {
      this.store.update(taskId, { status: 'failed', artifacts });
      this.store.cascadeStatus(taskId);
      log.info('signal failed, retries exhausted', { taskId });
    }
  }

  /** Reset the most recent agent_work sibling before this task to pending. */
  private resetPrecedingSibling(task: { id: string; parentId: string | null }): void {
    if (!task.parentId) return;

    const siblings = this.store.getChildren(task.parentId);
    // Siblings are sorted by priority DESC — find the one just before this task
    let found = false;
    for (const sibling of siblings) {
      if (sibling.id === task.id) {
        found = true;
        continue;
      }
      // After finding our task in the list, look backwards. But since sorted by priority DESC,
      // the sibling before us has higher priority. So we need to find the last agent_work
      // sibling before our task in the ordered list.
    }

    // Walk the list: find the agent_work sibling that comes right before this task
    // (i.e., has higher priority = appears earlier in priority-sorted list)
    let precedingAgent: string | null = null;
    for (const sibling of siblings) {
      if (sibling.id === task.id) break;
      if (sibling.stageType === 'agent_work' || sibling.stageType === null) {
        precedingAgent = sibling.id;
      }
    }

    if (precedingAgent) {
      this.store.update(precedingAgent, { status: 'pending' });
      log.info('reset preceding sibling for retry', { taskId: task.id, siblingId: precedingAgent });
    }
  }
}

// --- Gate checker implementations ---

export async function checkGate(config: GateConfig): Promise<GateResult> {
  switch (config.type) {
    case 'gh_ci':
      return checkGhCi(config as GateConfig & { repo: string; pr: number | string });
    case 'gh_review':
      return checkGhReview(config as GateConfig & { repo: string; pr: number | string });
    case 'centaur_review':
      return checkCentaurReview(config as GateConfig & { pr_url: string });
    case 'compound':
      return checkCompound(config as GateConfig & { all: GateConfig[] });
    case 'human_approval':
      return { resolved: false, status: 'fail' }; // never auto-resolves
    default:
      log.warn('unknown gate type', { type: config.type });
      return { resolved: false, status: 'fail' };
  }
}

async function checkGhCi(config: { repo: string; pr: number | string }): Promise<GateResult> {
  try {
    const { stdout } = await execFileAsync('gh', [
      'pr', 'checks', String(config.pr),
      '--repo', config.repo,
      '--json', 'state,name',
    ]);
    const checks = JSON.parse(stdout) as Array<{ state: string; name: string }>;
    if (checks.length === 0) return { resolved: false, status: 'fail' };

    const allPassed = checks.every((c) => c.state === 'SUCCESS' || c.state === 'SKIPPED');
    const anyFailed = checks.some((c) => c.state === 'FAILURE' || c.state === 'ERROR');

    if (allPassed) {
      return { resolved: true, status: 'pass', artifacts: { checks } };
    }
    if (anyFailed) {
      const failed = checks.filter((c) => c.state === 'FAILURE' || c.state === 'ERROR');
      return { resolved: true, status: 'fail', artifacts: { failed_checks: failed.map((c) => c.name) } };
    }
    // Still pending
    return { resolved: false, status: 'fail' };
  } catch (err) {
    log.error('gh ci check failed', { error: (err as Error).message });
    return { resolved: false, status: 'fail' };
  }
}

async function checkGhReview(config: { repo: string; pr: number | string }): Promise<GateResult> {
  try {
    const { stdout } = await execFileAsync('gh', [
      'pr', 'view', String(config.pr),
      '--repo', config.repo,
      '--json', 'reviewDecision',
    ]);
    const data = JSON.parse(stdout) as { reviewDecision: string };

    if (data.reviewDecision === 'APPROVED') {
      return { resolved: true, status: 'pass', artifacts: { reviewDecision: 'APPROVED' } };
    }
    if (data.reviewDecision === 'CHANGES_REQUESTED') {
      return { resolved: true, status: 'fail', artifacts: { reviewDecision: 'CHANGES_REQUESTED' } };
    }
    // REVIEW_REQUIRED or empty — not resolved yet
    return { resolved: false, status: 'fail' };
  } catch (err) {
    log.error('gh review check failed', { error: (err as Error).message });
    return { resolved: false, status: 'fail' };
  }
}

async function checkCentaurReview(config: { pr_url: string }): Promise<GateResult> {
  try {
    const res = await fetch(
      `http://localhost:8642/api/reviews?pr=${encodeURIComponent(config.pr_url)}`,
    );
    if (!res.ok) return { resolved: false, status: 'fail' };
    const data = (await res.json()) as { status?: string; review?: unknown };

    if (data.status === 'approved') {
      return { resolved: true, status: 'pass', artifacts: { review: data.review } };
    }
    if (data.status === 'changes_requested') {
      return { resolved: true, status: 'fail', artifacts: { review: data.review } };
    }
    return { resolved: false, status: 'fail' };
  } catch {
    // Centaur might not be running — that's fine, just not resolved
    return { resolved: false, status: 'fail' };
  }
}

async function checkCompound(config: { all: GateConfig[] }): Promise<GateResult> {
  const results = await Promise.all(config.all.map((c) => checkGate(c)));
  const allResolved = results.every((r) => r.resolved);
  const anyFailed = results.some((r) => r.status === 'fail' && r.resolved);

  if (!allResolved) return { resolved: false, status: 'fail' };
  return {
    resolved: true,
    status: anyFailed ? 'fail' : 'pass',
    artifacts: { sub_results: results },
  };
}
