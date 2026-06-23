/**
 * Session Overview — computes SessionActivity[] from server-side registries
 * and broadcasts via SSE with coalescing.
 *
 * State is derived lazily at broadcast time. An idle-transition timer ensures
 * that "done" sessions are re-evaluated and broadcast as "idle" after
 * DONE_TIMEOUT_MS, even when no other events occur.
 */

import type { SessionRegistry, ActiveSessionInfo } from '@mitzo/harness';
import type { SseRegistry } from '@mitzo/harness';
import { getPendingCountBySession } from '@mitzo/harness';
import type {
  SessionActivity,
  SessionActivityState,
  SessionMeta,
  WaitReason,
} from '@mitzo/protocol';
import type { EventStore } from '@mitzo/protocol/event-store';
import type { LoopStatus } from './task-orchestrator.js';
import type { TaskStore } from './task-store.js';
import { hasUncommittedWorkAsync } from './worktree.js';
import { createLogger } from './logger.js';

export type { SessionActivity, SessionActivityState, WaitReason } from '@mitzo/protocol';

const log = createLogger('session-overview');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Done → Idle after 5 minutes of inactivity. */
const DONE_TIMEOUT_MS = 5 * 60 * 1000;

/** Coalesce broadcasts within this window to avoid re-render storms. */
const COALESCE_MS = 200;

/** Interval for background uncommitted work refresh (60 seconds). */
const UNCOMMITTED_REFRESH_INTERVAL_MS = 60 * 1000;

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
  eventStore: EventStore;
  /** Resolve session title. Typically eventStore.getSession(id)?.summary */
  getSessionTitle: (sessionId: string) => string | undefined;
}

// ─── Emitter ──────────────────────────────────────────────────────────────────

interface UncommittedCacheEntry {
  dirty: boolean;
  checkedAt: number;
}

export class SessionOverviewEmitter {
  private deps: SessionOverviewDeps;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Track last assistant event time per clientId for timeout derivation. */
  private lastEventTimes = new Map<string, number>();
  /** Cached uncommitted work results per session cwd (populated by background refresh). */
  private uncommittedCache = new Map<string, UncommittedCacheEntry>();
  /** Cached lastSpeakerAt + lastSpeaker per sessionId — avoids per-broadcast SQLite lookups. */
  private speakerCache = new Map<
    string,
    { speaker: 'user' | 'assistant' | null; at: number | null }
  >();
  /** Background refresh interval for uncommitted work checks. */
  private uncommittedRefreshTimer: ReturnType<typeof setInterval> | null = null;
  /** Guard against overlapping refresh runs. */
  private refreshInFlight = false;
  /** Timer that fires when the next "done" session should transition to "idle". */
  private idleTransitionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: SessionOverviewDeps) {
    this.deps = deps;
    this.startUncommittedRefresh();
  }

  /**
   * Record an event time for a session (call on turn start/end, attach, etc.).
   * Used for Done → Idle timeout derivation.
   * Also schedules a future broadcast so that done → idle fires on time.
   */
  touch(clientId: string): void {
    this.lastEventTimes.set(clientId, Date.now());
    this.scheduleIdleTransition();
  }

  /**
   * Schedule a broadcast when the earliest tracked session should transition
   * from "done" to "idle". Picks the minimum remaining time across all
   * tracked sessions so that staggered touches don't delay earlier transitions.
   */
  private scheduleIdleTransition(): void {
    if (this.idleTransitionTimer) clearTimeout(this.idleTransitionTimer);

    const now = Date.now();
    let earliest = DONE_TIMEOUT_MS;
    for (const touchedAt of this.lastEventTimes.values()) {
      const remaining = DONE_TIMEOUT_MS - (now - touchedAt);
      if (remaining < earliest) earliest = remaining;
    }
    // Clamp to at least 0 (session already past timeout)
    const delay = Math.max(0, earliest);

    this.idleTransitionTimer = setTimeout(() => {
      this.idleTransitionTimer = null;
      this.scheduleBroadcast();
      // Re-schedule if there are still sessions that haven't timed out yet
      if (this.lastEventTimes.size > 0) {
        this.scheduleIdleTransition();
      }
    }, delay);
  }

  /**
   * Clean up tracking for a removed session.
   */
  forget(clientId: string, sessionId?: string): void {
    this.lastEventTimes.delete(clientId);
    if (sessionId) {
      this.speakerCache.delete(sessionId);
    }
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
   * Compute SessionActivity[] from all active sessions + persistent attention sessions.
   * State is derived purely from current data — no stored state.
   */
  private compute(): SessionActivity[] {
    const now = Date.now();
    const activeSessions = this.deps.registry.getActiveSessions();
    const loopStatus = this.deps.getLoopStatus();

    const liveActivities = activeSessions
      .filter((s) => s.sessionId) // Skip sessions without SDK IDs
      .map((s) => this.deriveActivity(s, loopStatus, now));

    // Merge persistent attention sessions (awaiting user reply)
    const liveIds = new Set(liveActivities.map((a) => a.sessionId));
    const persistentSessions = this.deps.eventStore.getAttentionSessions();
    for (const meta of persistentSessions) {
      if (liveIds.has(meta.sessionId)) continue;
      liveActivities.push(this.persistentToActivity(meta, now));
    }

    return liveActivities;
  }

  private deriveActivity(
    session: ActiveSessionInfo,
    loopStatus: LoopStatus,
    now: number,
  ): SessionActivity {
    const sessionId = session.sessionId ?? '';
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

    // Check uncommitted work for live sessions (from background cache)
    const uncommittedWork = session.cwd ? this.checkUncommittedCached(session.cwd) : false;

    // Check if awaiting user reply (assistant spoke last, not streaming, not waiting for input)
    // Exclude 'waiting' state — sessions needing permission/review should sort as waiting, not awaiting reply
    const speaker = this.getCachedSpeaker(sessionId);
    const awaitingReply =
      speaker.speaker === 'assistant' && !session.hasSnapshot && primaryState !== 'waiting';
    const speakerAt = speaker.at ?? lastEventAt;
    const idleMinutes = Math.max(0, Math.round((now - speakerAt) / 60_000));

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
      uncommittedWork,
      awaitingReply,
      idleMinutes,
    };
  }

  /**
   * Convert a persistent SessionMeta (from EventStore) to a SessionActivity.
   * These are sessions not currently live but awaiting user reply.
   * Applies the same DONE_TIMEOUT_MS check as live sessions — persistent
   * sessions older than the timeout are returned as "idle" so they disappear
   * from the active list.
   */
  private persistentToActivity(meta: SessionMeta, now: number): SessionActivity {
    const title = meta.summary || meta.sessionId.slice(-8);
    const repo = meta.cwd ? extractRepoName(meta.cwd) : undefined;
    const lastEventAt = meta.lastSpeakerAt ?? meta.updatedAt;
    const elapsed = now - lastEventAt;
    const idleMinutes = Math.max(0, Math.round(elapsed / 60_000));

    // Check for uncommitted work (from background cache)
    const uncommittedWork = meta.cwd ? this.checkUncommittedCached(meta.cwd) : false;

    const state: SessionActivityState = elapsed < DONE_TIMEOUT_MS ? 'done' : 'idle';

    return {
      sessionId: meta.sessionId,
      clientId: meta.sessionId, // No live clientId — use sessionId
      title,
      repo,
      state,
      flags: [],
      lastEventAt,
      taskId: meta.goalId ?? undefined,
      uncommittedWork,
      awaitingReply: state === 'done', // Only meaningful while still active
      idleMinutes,
    };
  }

  /**
   * Get cached speaker info for a session. Lazily populated from EventStore
   * on first access, then kept up-to-date via updateSpeaker().
   */
  private getCachedSpeaker(sessionId: string): {
    speaker: 'user' | 'assistant' | null;
    at: number | null;
  } {
    const cached = this.speakerCache.get(sessionId);
    if (cached) return cached;
    const meta = this.deps.eventStore.getSession(sessionId);
    const speaker = meta?.lastSpeaker as 'user' | 'assistant' | undefined;
    const entry = { speaker: speaker ?? null, at: meta?.lastSpeakerAt ?? null };
    this.speakerCache.set(sessionId, entry);
    return entry;
  }

  /**
   * Update the cached speaker state for a session.
   * Call this from the turn_end / user_message event handlers.
   */
  updateSpeaker(sessionId: string, speaker: 'user' | 'assistant'): void {
    this.speakerCache.set(sessionId, { speaker, at: Date.now() });
  }

  /**
   * Pure cache read — returns cached dirty state, or false if not yet checked.
   * Cache is populated asynchronously by the background refresh loop.
   */
  private checkUncommittedCached(cwd: string): boolean {
    return this.uncommittedCache.get(cwd)?.dirty ?? false;
  }

  /**
   * Start the background loop that refreshes uncommitted work state
   * for all known session cwds. Runs async git status checks without
   * blocking the event loop.
   */
  private startUncommittedRefresh(): void {
    // Fire immediately (async, non-blocking) then repeat on interval
    void this.refreshUncommittedCache();
    this.uncommittedRefreshTimer = setInterval(() => {
      void this.refreshUncommittedCache();
    }, UNCOMMITTED_REFRESH_INTERVAL_MS);
  }

  /**
   * Collect all cwds from live + persistent sessions, run async git status
   * for each, and update the cache. Skips if a previous run is still in flight.
   */
  private async refreshUncommittedCache(): Promise<void> {
    if (this.refreshInFlight) return;
    this.refreshInFlight = true;
    try {
      const cwds = this.collectSessionCwds();
      if (cwds.size === 0) return;

      const now = Date.now();
      await Promise.all(
        [...cwds].map(async (cwd) => {
          const result = await hasUncommittedWorkAsync(cwd);
          const dirty = result !== null && !result.startsWith('[');
          this.uncommittedCache.set(cwd, { dirty, checkedAt: now });
        }),
      );

      // Broadcast after cache update so clients see fresh uncommitted state
      this.scheduleBroadcast();
    } catch (err) {
      log.warn('uncommitted work refresh failed', {
        error: err instanceof Error ? err.message : 'unknown',
      });
    } finally {
      this.refreshInFlight = false;
    }
  }

  /**
   * Gather all unique cwds from live registry sessions + persistent attention sessions.
   */
  private collectSessionCwds(): Set<string> {
    const cwds = new Set<string>();
    for (const s of this.deps.registry.getActiveSessions()) {
      if (s.cwd) cwds.add(s.cwd);
    }
    for (const meta of this.deps.eventStore.getAttentionSessions()) {
      if (meta.cwd) cwds.add(meta.cwd);
    }
    return cwds;
  }

  /**
   * Check if any child task of a goal is blocked or pending_review.
   */
  private checkTaskWaitState(goalId: string): WaitReason | null {
    const tree = this.deps.taskStore.getTree();
    const goal = tree.find((t) => t.id === goalId);
    if (!goal) return null;

    // Check the goal and direct children only (single-level task decomposition)
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
    if (this.idleTransitionTimer) {
      clearTimeout(this.idleTransitionTimer);
      this.idleTransitionTimer = null;
    }
    if (this.uncommittedRefreshTimer) {
      clearInterval(this.uncommittedRefreshTimer);
      this.uncommittedRefreshTimer = null;
    }
    this.lastEventTimes.clear();
    this.uncommittedCache.clear();
    this.speakerCache.clear();
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
  const worktreeMatch = cwd.match(/^(.+)\/\.(claude|cursor)\/worktrees\//);
  const base = worktreeMatch ? worktreeMatch[1] : cwd;
  const parts = base.split('/').filter(Boolean);
  return parts[parts.length - 1] || 'unknown';
}
