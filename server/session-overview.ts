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
import { getPendingCountBySession, onPermissionLifecycle } from '@mitzo/harness';
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
import { readSessionModelSelection, sessionModelIdentity } from './session-list-metadata.js';
import { SessionActivityEvents } from './session-activity-events.js';

export type { SessionActivity, SessionActivityState, WaitReason } from '@mitzo/protocol';

export type SessionChangeEvent =
  'start' | 'end' | 'turn_start' | 'turn_end' | 'user_message' | 'detach';

const log = createLogger('session-overview');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Done → Idle after 5 minutes of inactivity. */
const DONE_TIMEOUT_MS = 5 * 60 * 1000;

/** Coalesce broadcasts within this window to avoid re-render storms. */
const COALESCE_MS = 200;

/** Interval for background uncommitted work refresh (60 seconds). */
const UNCOMMITTED_REFRESH_INTERVAL_MS = 60 * 1000;

/** Keep background Git children bounded independently of the number of sessions. */
const MAX_CONCURRENT_UNCOMMITTED_CHECKS = 4;

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
  /** Read persisted visibility independently of the speaker cache. */
  isSessionHidden: (sessionId: string) => boolean;
}

// ─── Emitter ──────────────────────────────────────────────────────────────────

interface UncommittedCacheEntry {
  dirty: boolean;
  checkedAt: number;
}

export class SessionOverviewEmitter {
  private unsubscribePermissions: () => void;
  private activityEvents = new SessionActivityEvents();
  private deps: SessionOverviewDeps;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Track last assistant event time per clientId for timeout derivation. */
  private lastEventTimes = new Map<string, number>();
  /** Cached uncommitted work results per session cwd (populated by background refresh). */
  private uncommittedCache = new Map<string, UncommittedCacheEntry>();
  /** Cached lastSpeakerAt + lastSpeaker per sessionId — avoids per-broadcast SQLite lookups. */
  private speakerCache = new Map<
    string,
    { speaker: 'user' | 'assistant' | null; at: number | null; lastUserMessageAt?: number }
  >();
  /** Background refresh interval for uncommitted work checks. */
  private uncommittedRefreshTimer: ReturnType<typeof setInterval> | null = null;
  /** Guard against overlapping refresh runs. */
  private refreshInFlight = false;
  /** Timer that fires when the next "done" session should transition to "idle". */
  private idleTransitionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: SessionOverviewDeps) {
    this.deps = deps;
    this.unsubscribePermissions = onPermissionLifecycle(() => this.scheduleBroadcast());
    this.startUncommittedRefresh();
  }

  /**
   * Record an execution event time for a session, independent of viewer attachment.
   * Used for Done → Idle timeout derivation.
   * Also schedules a future broadcast so that done → idle fires on time.
   */
  touch(clientId: string): void {
    this.lastEventTimes.set(clientId, Date.now());
    this.scheduleIdleTransition();
  }

  setTurnRunning(clientId: string, running: boolean): void {
    const session = this.deps.registry.get(clientId);
    if (!session || session.turnInProgress === running) return;
    session.turnInProgress = running;
    if (running) this.activityEvents.start(clientId);
    else this.activityEvents.finish(clientId);
    this.touch(clientId);
    this.scheduleBroadcast();
  }

  observeEvent(clientId: string, event: Readonly<Record<string, unknown>>): void {
    const session = this.deps.registry.get(clientId);
    if (!session?.turnInProgress || session.sessionId !== event.sessionId) return;
    if (this.activityEvents.observe(clientId, event)) this.scheduleBroadcast();
  }

  /** Registration and retained input do not establish provider execution. */
  sessionChanged(clientId: string, event: SessionChangeEvent, sessionId?: string): void {
    if (event === 'turn_start') {
      this.setTurnRunning(clientId, true);
    } else if (event === 'end') {
      this.forget(clientId, sessionId);
    } else if (event === 'user_message') {
      this.activityEvents.message(clientId);
      const session = this.deps.registry.get(clientId);
      if (session?.sessionId) this.updateSpeaker(session.sessionId, 'user');
    } else if (event === 'turn_end') {
      this.setTurnRunning(clientId, false);
      const session = this.deps.registry.get(clientId);
      if (session?.sessionId) {
        this.deps.eventStore.updateLastSpeaker(session.sessionId, 'assistant');
        this.updateSpeaker(session.sessionId, 'assistant');
      }
    }
    this.scheduleBroadcast();
  }

  /**
   * Schedule a broadcast when the earliest tracked session should transition
   * from "done" to "idle". Picks the minimum remaining time across all
   * tracked sessions so that staggered touches don't delay earlier transitions.
   */
  private scheduleIdleTransition(): void {
    if (this.idleTransitionTimer) clearTimeout(this.idleTransitionTimer);
    this.idleTransitionTimer = null;

    const now = Date.now();
    let nextDeadline: number | undefined;
    for (const touchedAt of this.lastEventTimes.values()) {
      const deadline = touchedAt + DONE_TIMEOUT_MS;
      // Keep expired timestamps for state derivation, but never rearm them.
      // A zero-delay loop would repeatedly scan attention sessions after idle.
      if (deadline <= now) continue;
      if (nextDeadline === undefined || deadline < nextDeadline) nextDeadline = deadline;
    }
    if (nextDeadline === undefined) return;

    this.idleTransitionTimer = setTimeout(() => {
      this.idleTransitionTimer = null;
      this.scheduleBroadcast();
      this.scheduleIdleTransition();
    }, nextDeadline - now);
  }

  /**
   * Clean up tracking for a removed session.
   */
  forget(clientId: string, sessionId?: string): void {
    this.activityEvents.forget(clientId);
    if (this.lastEventTimes.delete(clientId)) this.scheduleIdleTransition();
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
    let taskTree: ReturnType<TaskStore['getTree']> | undefined;
    const taskWaits = new Map<string, WaitReason | null>();
    const taskWait = (goalId: string): WaitReason | null => {
      if (!taskWaits.has(goalId)) {
        taskTree ??= this.deps.taskStore.getTree();
        taskWaits.set(goalId, this.checkTaskWaitState(goalId, taskTree));
      }
      return taskWaits.get(goalId) ?? null;
    };

    const liveActivities = activeSessions
      .filter((s) => s.sessionId) // Skip sessions without SDK IDs
      .map((s) => this.deriveActivity(s, loopStatus, now, taskWait));

    // Merge persistent attention sessions (awaiting user reply)
    const liveIds = new Set(liveActivities.map((a) => a.sessionId));
    const persistentSessions = this.deps.eventStore.getAttentionSessions();
    for (const meta of persistentSessions) {
      if (liveIds.has(meta.sessionId)) continue;
      liveActivities.push(this.persistentToActivity(meta, now));
    }

    const navigation = new Map(
      (this.deps.eventStore.collaborationConversation?.navigation() ?? []).map((r) => [
        r.sessionId,
        r.sourceConversationId,
      ]),
    );
    return liveActivities
      .filter((activity) => !this.deps.isSessionHidden(activity.sessionId))
      .map((activity) => {
        const source = navigation.get(activity.sessionId);
        return source
          ? {
              ...activity,
              presentationConversation: {
                id: source,
                title: this.deps.getSessionTitle(source) || 'Untitled conversation',
              },
            }
          : activity;
      });
  }

  private deriveActivity(
    session: ActiveSessionInfo,
    loopStatus: LoopStatus,
    now: number,
    taskWaitForGoal: (goalId: string) => WaitReason | null,
  ): SessionActivity {
    const sessionId = session.sessionId ?? '';
    const speaker = this.getCachedSpeaker(sessionId);
    const lastEventAt = this.lastEventTimes.get(session.clientId) ?? speaker.at ?? now;
    if (!this.lastEventTimes.has(session.clientId)) {
      this.lastEventTimes.set(session.clientId, lastEventAt);
      this.scheduleIdleTransition();
    }
    const elapsed = now - lastEventAt;
    const turnRunning = session.turnInProgress ?? session.hasSnapshot;

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
      const taskWait = taskWaitForGoal(session.taskContext.goalId);
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
      }
    }

    if (loopStatus.state === 'paused' && session.taskContext?.goalId === loopStatus.goalId) {
      states.push('paused');
    }

    if (
      (loopStatus.state === 'running' || loopStatus.state === 'paused') &&
      loopStatus.awaitingApproval &&
      session.taskContext?.goalId === loopStatus.goalId
    ) {
      states.push('waiting');
      if (waitReason !== 'permission') waitReason = 'review';
    }

    // A provider turn can keep running between messages or without an attached viewer.
    if (turnRunning) states.push('working');
    else if (states.length === 0) states.push(elapsed < DONE_TIMEOUT_MS ? 'done' : 'idle');

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
    const awaitingReply =
      speaker.speaker === 'assistant' && !turnRunning && primaryState !== 'waiting';
    const speakerAt = speaker.at ?? lastEventAt;
    const idleMinutes = Math.max(0, Math.round((now - speakerAt) / 60_000));

    return {
      sessionId,
      clientId: session.clientId,
      title,
      ...sessionModelIdentity(
        { selectedModel: session.model },
        undefined,
        readSessionModelSelection(this.deps.eventStore, sessionId),
      ),
      accountLabel: session.accountLabel,
      repo,
      state: primaryState,
      flags,
      waitReason: primaryState === 'waiting' ? waitReason : undefined,
      progress,
      lastEventAt,
      lastUserMessageAt: speaker.lastUserMessageAt,
      ...this.activityEvents.get(session.clientId),
      lastMessageAt:
        Math.max(speaker.at ?? 0, this.activityEvents.get(session.clientId).lastMessageAt ?? 0) ||
        undefined,
      stateChangedAt: this.activityEvents.state(
        session.clientId,
        `${primaryState}:${waitReason ?? ''}`,
      ),
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
      ...sessionModelIdentity(
        meta,
        undefined,
        readSessionModelSelection(this.deps.eventStore, meta.sessionId),
      ),
      repo,
      state,
      flags: [],
      lastEventAt,
      lastMessageAt: meta.lastSpeakerAt ?? undefined,
      completedAt: meta.lastSpeaker === 'assistant' ? (meta.lastSpeakerAt ?? undefined) : undefined,
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
    lastUserMessageAt?: number;
  } {
    const cached = this.speakerCache.get(sessionId);
    if (cached) return cached;
    const meta = this.deps.eventStore.getSession(sessionId);
    const speaker = meta?.lastSpeaker as 'user' | 'assistant' | undefined;
    const entry = {
      speaker: speaker ?? null,
      at: meta?.lastSpeakerAt ?? null,
      lastUserMessageAt: speaker === 'user' ? (meta?.lastSpeakerAt ?? undefined) : undefined,
    };
    this.speakerCache.set(sessionId, entry);
    return entry;
  }

  /**
   * Update the cached speaker state for a session.
   * Call this from the turn_end / user_message event handlers.
   */
  updateSpeaker(sessionId: string, speaker: 'user' | 'assistant'): void {
    const at = Date.now();
    this.speakerCache.set(sessionId, {
      speaker,
      at,
      lastUserMessageAt:
        speaker === 'user' ? at : this.speakerCache.get(sessionId)?.lastUserMessageAt,
    });
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
      const remaining = cwds.values();
      // Keep the round owned until every worker settles, including unexpected
      // helper rejection, so an interval cannot overlap surviving Git children.
      const workers = await Promise.allSettled(
        Array.from({ length: Math.min(cwds.size, MAX_CONCURRENT_UNCOMMITTED_CHECKS) }, async () => {
          for (const cwd of remaining) {
            const result = await hasUncommittedWorkAsync(cwd);
            const dirty = result !== null && !result.startsWith('[');
            this.uncommittedCache.set(cwd, { dirty, checkedAt: now });
          }
        }),
      );

      const failed = workers.find((worker) => worker.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;

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
    const add = (cwd: string | null | undefined, sessionId: string | undefined) => {
      if (!cwd) return;
      try {
        if (
          sessionId &&
          this.deps.eventStore.getSessionRuntimeBinding?.(sessionId)?.execution.location ===
            'openshell'
        )
          return;
      } catch {
        // An unreadable runtime binding cannot select a host filesystem probe.
        return;
      }
      cwds.add(cwd);
    };
    for (const s of this.deps.registry.getActiveSessions()) {
      add(s.cwd, s.sessionId);
    }
    for (const meta of this.deps.eventStore.getAttentionSessions()) {
      add(meta.cwd, meta.sessionId);
    }
    return cwds;
  }

  /**
   * Keep explicit review requests visible independently of aggregate task status.
   */
  private checkTaskWaitState(
    goalId: string,
    taskTree: ReturnType<TaskStore['getTree']>,
  ): WaitReason | null {
    const pending = [...taskTree];
    let goal;
    while (pending.length) {
      const task = pending.pop()!;
      if (task.id === goalId) {
        goal = task;
        break;
      }
      pending.push(...task.children);
    }
    if (!goal) return null;

    pending.length = 0;
    pending.push(goal);
    let blocked = false;
    while (pending.length) {
      const task = pending.pop()!;
      if (task.status === 'pending_review') return 'review';
      if (task.status === 'blocked') blocked = true;
      pending.push(...task.children);
    }
    return blocked ? 'blocked' : null;
  }

  destroy(): void {
    this.unsubscribePermissions();
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
    this.activityEvents.clear();
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
