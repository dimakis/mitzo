/**
 * Session Overview — computes SessionActivity[] from server-side registries
 * and broadcasts via SSE with coalescing.
 *
 * State is derived lazily at broadcast time — no stored state, no timers for
 * timeout transitions. This avoids divergence across multiple clients.
 */

import type { SessionRegistry, ActiveSessionInfo } from '@mitzo/harness';
import type { SseRegistry } from '@mitzo/harness';
import { getPendingCountBySession } from '@mitzo/harness';
import type { LoopStatus } from './task-orchestrator.js';
import type { TaskStore } from './task-store.js';
import { createLogger } from './logger.js';

const log = createLogger('session-overview');

// ─── Types ────────────────────────────────────────────────────────────────────

export type SessionActivityState = 'init' | 'working' | 'waiting' | 'done' | 'idle' | 'paused';

export type WaitReason = 'permission' | 'review' | 'blocked';

export interface SessionActivity {
  sessionId: string;
  clientId: string;
  title: string;
  repo?: string;
  state: SessionActivityState;
  flags: SessionActivityState[];
  waitReason?: WaitReason;
  progress?: { done: number; total: number };
  lastEventAt: number;
  taskId?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Done → Idle after 5 minutes of inactivity. */
const DONE_TIMEOUT_MS = 5 * 60 * 1000;

/** Coalesce broadcasts within this window to avoid re-render storms. */
const COALESCE_MS = 200;

// ─── State priority for "highest wins" ────────────────────────────────────────

const STATE_PRIORITY: Record<SessionActivityState, number> = {
  idle: 0,
  init: 1,
  paused: 2,
  done: 3,
  working: 4,
  waiting: 5,
};

// ─── Dependencies ─────────────────────────────────────────────────────────────

export interface SessionOverviewDeps {
  registry: SessionRegistry;
  sseRegistry: SseRegistry;
  getLoopStatus: () => LoopStatus;
  taskStore: TaskStore;
  /** Resolve session title. Typically eventStore.getSession(id)?.summary */
  getSessionTitle: (sessionId: string) => string | undefined;
}

// ─── Emitter ──────────────────────────────────────────────────────────────────

export class SessionOverviewEmitter {
  private deps: SessionOverviewDeps;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Track last assistant event time per clientId for timeout derivation. */
  private lastEventTimes = new Map<string, number>();

  constructor(deps: SessionOverviewDeps) {
    this.deps = deps;
  }

  /**
   * Record an event time for a session (call on turn start/end, attach, etc.).
   * Used for Done → Idle timeout derivation.
   */
  touch(clientId: string): void {
    this.lastEventTimes.set(clientId, Date.now());
  }

  /**
   * Clean up tracking for a removed session.
   */
  forget(clientId: string): void {
    this.lastEventTimes.delete(clientId);
  }

  /**
   * Schedule a coalesced broadcast. Multiple calls within COALESCE_MS
   * collapse into a single broadcast.
   */
  scheduleBroadcast(): void {
    if (this.coalesceTimer) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      this.broadcast();
    }, COALESCE_MS);
  }

  /**
   * Compute the current snapshot and broadcast immediately.
   * Used for hydration (new SSE client).
   */
  getSnapshot(): SessionActivity[] {
    return this.compute();
  }

  /**
   * Broadcast the current snapshot to all SSE clients.
   */
  private broadcast(): void {
    const activities = this.compute();
    this.deps.sseRegistry.broadcast('session_activity', activities);
    log.debug('broadcast session_activity', { count: activities.length });
  }

  /**
   * Compute SessionActivity[] from all active sessions.
   * State is derived purely from current data — no stored state.
   */
  private compute(): SessionActivity[] {
    const now = Date.now();
    const activeSessions = this.deps.registry.getActiveSessions();
    const loopStatus = this.deps.getLoopStatus();

    return activeSessions
      .filter((s) => s.sessionId) // Skip sessions without SDK IDs
      .map((s) => this.deriveActivity(s, loopStatus, now));
  }

  private deriveActivity(
    session: ActiveSessionInfo,
    loopStatus: LoopStatus,
    now: number,
  ): SessionActivity {
    const sessionId = session.sessionId!;
    const lastEventAt = this.lastEventTimes.get(session.clientId) ?? now;
    const elapsed = now - lastEventAt;

    // Collect all applicable states
    const states: SessionActivityState[] = [];
    let waitReason: WaitReason | undefined;
    let progress: { done: number; total: number } | undefined;
    let taskId: string | undefined;

    // 1. Permission check — "Waiting" for permission
    const pendingCount = getPendingCountBySession(sessionId);
    if (pendingCount > 0) {
      states.push('waiting');
      waitReason = 'permission';
    }

    // 2. Task board — check for blocked/pending_review tasks linked to this session
    if (session.taskContext) {
      taskId = session.taskContext.goalId;
      const taskWait = this.checkTaskWaitState(session.taskContext.goalId);
      if (taskWait) {
        states.push('waiting');
        if (!waitReason) waitReason = taskWait;
      }
    }

    // 3. ATB loop — check if this session is running the loop
    if (loopStatus.state === 'running' && loopStatus.goalId) {
      // Check if this session is the loop's pinned session
      if (session.taskContext?.goalId === loopStatus.goalId) {
        states.push('working');
        if (loopStatus.progress) {
          progress = loopStatus.progress;
        }
        if (loopStatus.awaitingApproval) {
          states.push('waiting');
          if (!waitReason) waitReason = 'review';
        }
      }
    }

    if (loopStatus.state === 'paused' && session.taskContext?.goalId === loopStatus.goalId) {
      states.push('paused');
    }

    // 4. Transport/streaming state
    if (session.attached) {
      if (session.hasSnapshot) {
        // Currently streaming a response
        states.push('working');
      } else if (states.length === 0) {
        // Attached but not streaming — either just finished or init
        if (elapsed < DONE_TIMEOUT_MS) {
          states.push('done');
        } else {
          states.push('idle');
        }
      }
    } else {
      // Detached
      if (elapsed < DONE_TIMEOUT_MS) {
        states.push('done');
      } else {
        states.push('idle');
      }
    }

    // Fallback: if no states collected, it's init
    if (states.length === 0) {
      states.push('init');
    }

    // Highest-priority state wins as primary
    const primaryState = states.reduce((best, s) =>
      STATE_PRIORITY[s] > STATE_PRIORITY[best] ? s : best,
    );

    // Secondary flags = all other states (excluding primary, deduplicated)
    const flags = [...new Set(states.filter((s) => s !== primaryState))];

    // Derive title
    const title = this.deps.getSessionTitle(sessionId) || sessionId.slice(-8);

    // Derive repo from cwd
    const repo = session.cwd ? extractRepoName(session.cwd) : undefined;

    return {
      sessionId,
      clientId: session.clientId,
      title,
      repo,
      state: primaryState,
      flags,
      waitReason: primaryState === 'waiting' ? waitReason : undefined,
      progress,
      lastEventAt,
      taskId,
    };
  }

  /**
   * Check if any child task of a goal is blocked or pending_review.
   */
  private checkTaskWaitState(goalId: string): WaitReason | null {
    const tree = this.deps.taskStore.getTree();
    const goal = tree.find((t) => t.id === goalId);
    if (!goal) return null;

    // Check the goal and its children (flat tree — children follow parent)
    for (const task of tree) {
      if (task.id === goalId || task.parentId === goalId) {
        if (task.status === 'pending_review') return 'review';
        if (task.status === 'blocked') return 'blocked';
      }
    }
    return null;
  }

  destroy(): void {
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    this.lastEventTimes.clear();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract a short repo name from a cwd path.
 * e.g. "/Users/foo/tools/mitzo" → "mitzo"
 *      "/Users/foo/redhat/mgmt/.claude/worktrees/abc123" → "mgmt"
 */
function extractRepoName(cwd: string): string {
  // Strip worktree suffix: .claude/worktrees/<id> or .cursor/worktrees/<id>
  const worktreeMatch = cwd.match(/^(.+?)\/\.(claude|cursor)\/worktrees\//);
  const base = worktreeMatch ? worktreeMatch[1] : cwd;
  const parts = base.split('/').filter(Boolean);
  return parts[parts.length - 1] || 'unknown';
}
