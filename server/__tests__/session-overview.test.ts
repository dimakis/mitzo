import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SessionOverviewEmitter,
  type SessionOverviewDeps,
  type SessionActivity,
} from '../session-overview.js';
import type { ActiveSessionInfo } from '@mitzo/harness';
import type { SessionMeta } from '@mitzo/protocol';
import type { LoopStatus } from '../task-orchestrator.js';

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function makeActiveSession(overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo {
  return {
    clientId: 'client-1',
    sessionId: 'session-1',
    mode: 'auto',
    cwd: '/Users/test/tools/mitzo',
    attached: true,
    cumulativeSessionTokens: 0,
    cumulativeCostUsd: 0,
    hasSnapshot: false,
    taskContext: null,
    observerCount: 0,
    ...overrides,
  };
}

function idleLoopStatus(): LoopStatus {
  return {
    state: 'idle',
    goalId: null,
    activeTaskId: null,
    progress: null,
    specMode: false,
    awaitingApproval: false,
  };
}

function makeDeps(overrides: Partial<SessionOverviewDeps> = {}): SessionOverviewDeps {
  return {
    registry: {
      getActiveSessions: vi.fn(() => []),
    } as unknown as SessionOverviewDeps['registry'],
    sseRegistry: {
      broadcast: vi.fn(),
      sendTo: vi.fn(),
    } as unknown as SessionOverviewDeps['sseRegistry'],
    getLoopStatus: vi.fn(() => idleLoopStatus()),
    taskStore: {
      getTree: vi.fn(() => []),
    } as unknown as SessionOverviewDeps['taskStore'],
    eventStore: {
      getSession: vi.fn(() => null),
      getAttentionSessions: vi.fn(() => []),
    } as unknown as SessionOverviewDeps['eventStore'],
    getSessionTitle: vi.fn(() => undefined),
    ...overrides,
  };
}

// ─── Mock the permissions module ──────────────────────────────────────────────

vi.mock('@mitzo/harness', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getPendingCountBySession: vi.fn(() => 0),
  };
});

import { getPendingCountBySession } from '@mitzo/harness';
const mockGetPending = getPendingCountBySession as ReturnType<typeof vi.fn>;

// ─── Mock worktree module ────────────────────────────────────────────────────

vi.mock('../worktree.js', () => ({
  hasUncommittedWork: vi.fn(() => null),
  hasUncommittedWorkAsync: vi.fn(async () => null), // default: clean worktree
}));

import { hasUncommittedWorkAsync } from '../worktree.js';
const mockHasUncommittedWorkAsync = hasUncommittedWorkAsync as ReturnType<typeof vi.fn>;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SessionOverviewEmitter', () => {
  let emitter: SessionOverviewEmitter;
  let deps: SessionOverviewDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    mockGetPending.mockReturnValue(0);
    mockHasUncommittedWorkAsync.mockImplementation(async () => null);
  });

  afterEach(() => {
    emitter?.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── getSnapshot ──────────────────────────────────────────────────────────

  it('returns empty array when no active sessions', () => {
    deps = makeDeps();
    emitter = new SessionOverviewEmitter(deps);

    expect(emitter.getSnapshot()).toEqual([]);
  });

  it('skips sessions without sessionId', () => {
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession({ sessionId: undefined })]),
      } as unknown as SessionOverviewDeps['registry'],
    });
    emitter = new SessionOverviewEmitter(deps);

    expect(emitter.getSnapshot()).toEqual([]);
  });

  it('derives "working" state when session has snapshot', () => {
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession({ hasSnapshot: true })]),
      } as unknown as SessionOverviewDeps['registry'],
    });
    emitter = new SessionOverviewEmitter(deps);

    const activities = emitter.getSnapshot();
    expect(activities).toHaveLength(1);
    expect(activities[0].state).toBe('working');
  });

  it('derives "done" state when session just finished', () => {
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession({ hasSnapshot: false, attached: true })]),
      } as unknown as SessionOverviewDeps['registry'],
    });
    emitter = new SessionOverviewEmitter(deps);

    // Touch with recent timestamp
    emitter.touch('client-1');

    const activities = emitter.getSnapshot();
    expect(activities).toHaveLength(1);
    expect(activities[0].state).toBe('done');
  });

  it('derives "idle" state when done timeout expired', () => {
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession({ hasSnapshot: false, attached: true })]),
      } as unknown as SessionOverviewDeps['registry'],
    });
    emitter = new SessionOverviewEmitter(deps);

    // Touch, then advance time past DONE_TIMEOUT_MS (5 min)
    emitter.touch('client-1');
    vi.advanceTimersByTime(6 * 60 * 1000);

    const activities = emitter.getSnapshot();
    expect(activities).toHaveLength(1);
    expect(activities[0].state).toBe('idle');
  });

  it('derives "waiting" state with permission reason', () => {
    mockGetPending.mockReturnValue(1);

    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession({ hasSnapshot: true })]),
      } as unknown as SessionOverviewDeps['registry'],
    });
    emitter = new SessionOverviewEmitter(deps);

    const activities = emitter.getSnapshot();
    expect(activities).toHaveLength(1);
    expect(activities[0].state).toBe('waiting');
    expect(activities[0].waitReason).toBe('permission');
    // "working" should be in flags since snapshot is true
    expect(activities[0].flags).toContain('working');
  });

  it('derives "paused" state from ATB loop', () => {
    const goalId = 'goal-1';
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [
          makeActiveSession({ taskContext: { currentTaskId: 'task-1', goalId } }),
        ]),
      } as unknown as SessionOverviewDeps['registry'],
      getLoopStatus: vi.fn(() => ({
        ...idleLoopStatus(),
        state: 'paused' as const,
        goalId,
      })),
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    const activities = emitter.getSnapshot();
    expect(activities[0].state).toBe('paused');
  });

  it('includes ATB progress when loop is running', () => {
    const goalId = 'goal-1';
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [
          makeActiveSession({ taskContext: { currentTaskId: 'task-1', goalId } }),
        ]),
      } as unknown as SessionOverviewDeps['registry'],
      getLoopStatus: vi.fn(() => ({
        ...idleLoopStatus(),
        state: 'running' as const,
        goalId,
        progress: { done: 2, total: 5 },
      })),
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    const activities = emitter.getSnapshot();
    expect(activities[0].state).toBe('working');
    expect(activities[0].progress).toEqual({ done: 2, total: 5 });
  });

  it('derives "waiting" with review reason from ATB awaiting approval', () => {
    const goalId = 'goal-1';
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [
          makeActiveSession({ taskContext: { currentTaskId: 'task-1', goalId } }),
        ]),
      } as unknown as SessionOverviewDeps['registry'],
      getLoopStatus: vi.fn(() => ({
        ...idleLoopStatus(),
        state: 'running' as const,
        goalId,
        awaitingApproval: true,
      })),
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    const activities = emitter.getSnapshot();
    expect(activities[0].state).toBe('waiting');
    expect(activities[0].waitReason).toBe('review');
  });

  it('derives repo name from cwd', () => {
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession({ cwd: '/Users/test/tools/mitzo' })]),
      } as unknown as SessionOverviewDeps['registry'],
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    const activities = emitter.getSnapshot();
    expect(activities[0].repo).toBe('mitzo');
  });

  it('strips worktree suffix from repo name', () => {
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [
          makeActiveSession({
            cwd: '/Users/test/redhat/mgmt/.claude/worktrees/abc123',
          }),
        ]),
      } as unknown as SessionOverviewDeps['registry'],
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    const activities = emitter.getSnapshot();
    expect(activities[0].repo).toBe('mgmt');
  });

  it('uses session title from eventStore', () => {
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession()]),
      } as unknown as SessionOverviewDeps['registry'],
      getSessionTitle: vi.fn(() => 'Fix auth bug'),
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    const activities = emitter.getSnapshot();
    expect(activities[0].title).toBe('Fix auth bug');
  });

  it('falls back to session ID suffix when no title', () => {
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession({ sessionId: 'abcdef12-3456-7890' })]),
      } as unknown as SessionOverviewDeps['registry'],
      getSessionTitle: vi.fn(() => undefined),
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    const activities = emitter.getSnapshot();
    expect(activities[0].title).toBe('456-7890');
  });

  // ─── Coalescing ───────────────────────────────────────────────────────────

  it('coalesces multiple scheduleBroadcast calls within 200ms', () => {
    deps = makeDeps();
    emitter = new SessionOverviewEmitter(deps);
    const broadcast = deps.sseRegistry.broadcast as ReturnType<typeof vi.fn>;

    emitter.scheduleBroadcast();
    emitter.scheduleBroadcast();
    emitter.scheduleBroadcast();

    expect(broadcast).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('session_activity', []);
  });

  it('broadcasts again after coalesce window', () => {
    deps = makeDeps();
    emitter = new SessionOverviewEmitter(deps);
    const broadcast = deps.sseRegistry.broadcast as ReturnType<typeof vi.fn>;

    emitter.scheduleBroadcast();
    vi.advanceTimersByTime(200);
    expect(broadcast).toHaveBeenCalledTimes(1);

    emitter.scheduleBroadcast();
    vi.advanceTimersByTime(200);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  // ─── touch / forget ───────────────────────────────────────────────────────

  it('forget removes tracked session', () => {
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession()]),
      } as unknown as SessionOverviewDeps['registry'],
    });
    emitter = new SessionOverviewEmitter(deps);

    emitter.touch('client-1');
    emitter.forget('client-1');

    // After forget, lastEventAt defaults to now → state depends on current time
    const activities = emitter.getSnapshot();
    expect(activities).toHaveLength(1);
    // Session still shows (from registry), just with fresh timestamp
  });

  // ─── Task wait state ──────────────────────────────────────────────────────

  it('derives "waiting" with blocked reason from task store', () => {
    const goalId = 'goal-1';
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [
          makeActiveSession({ taskContext: { currentTaskId: 'task-1', goalId } }),
        ]),
      } as unknown as SessionOverviewDeps['registry'],
      taskStore: {
        getTree: vi.fn(() => [
          { id: goalId, parentId: null, status: 'active' },
          { id: 'child-1', parentId: goalId, status: 'blocked' },
        ]),
      } as unknown as SessionOverviewDeps['taskStore'],
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    const activities = emitter.getSnapshot();
    expect(activities[0].state).toBe('waiting');
    expect(activities[0].waitReason).toBe('blocked');
  });

  it('derives "waiting" with review reason from pending_review task', () => {
    const goalId = 'goal-1';
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [
          makeActiveSession({ taskContext: { currentTaskId: 'task-1', goalId } }),
        ]),
      } as unknown as SessionOverviewDeps['registry'],
      taskStore: {
        getTree: vi.fn(() => [
          { id: goalId, parentId: null, status: 'active' },
          { id: 'child-1', parentId: goalId, status: 'pending_review' },
        ]),
      } as unknown as SessionOverviewDeps['taskStore'],
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    const activities = emitter.getSnapshot();
    expect(activities[0].state).toBe('waiting');
    expect(activities[0].waitReason).toBe('review');
  });

  // ─── Detached sessions ────────────────────────────────────────────────────

  it('derives "done" for recently detached session', () => {
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [
          makeActiveSession({ attached: false, hasSnapshot: false }),
        ]),
      } as unknown as SessionOverviewDeps['registry'],
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    const activities = emitter.getSnapshot();
    expect(activities[0].state).toBe('done');
  });

  it('derives "idle" for detached session past timeout', () => {
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [
          makeActiveSession({ attached: false, hasSnapshot: false }),
        ]),
      } as unknown as SessionOverviewDeps['registry'],
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');
    vi.advanceTimersByTime(6 * 60 * 1000);

    const activities = emitter.getSnapshot();
    expect(activities[0].state).toBe('idle');
  });

  // ─── Awaiting reply ───────────────────────────────────────────────────────

  it('sets awaitingReply when lastSpeaker is assistant and not streaming', () => {
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession({ hasSnapshot: false })]),
      } as unknown as SessionOverviewDeps['registry'],
      eventStore: {
        getSession: vi.fn(() => ({ lastSpeaker: 'assistant', lastSpeakerAt: Date.now() })),
        getAttentionSessions: vi.fn(() => []),
      } as unknown as SessionOverviewDeps['eventStore'],
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    const activities = emitter.getSnapshot();
    expect(activities[0].awaitingReply).toBe(true);
  });

  it('does not set awaitingReply when lastSpeaker is user', () => {
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession({ hasSnapshot: false })]),
      } as unknown as SessionOverviewDeps['registry'],
      eventStore: {
        getSession: vi.fn(() => ({ lastSpeaker: 'user', lastSpeakerAt: Date.now() })),
        getAttentionSessions: vi.fn(() => []),
      } as unknown as SessionOverviewDeps['eventStore'],
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    const activities = emitter.getSnapshot();
    expect(activities[0].awaitingReply).toBe(false);
  });

  it('does not set awaitingReply when session is streaming', () => {
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession({ hasSnapshot: true })]),
      } as unknown as SessionOverviewDeps['registry'],
      eventStore: {
        getSession: vi.fn(() => ({ lastSpeaker: 'assistant', lastSpeakerAt: Date.now() })),
        getAttentionSessions: vi.fn(() => []),
      } as unknown as SessionOverviewDeps['eventStore'],
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    const activities = emitter.getSnapshot();
    expect(activities[0].awaitingReply).toBe(false);
  });

  it('does not set awaitingReply when session is in waiting state', () => {
    mockGetPending.mockReturnValue(1);
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession({ hasSnapshot: false })]),
      } as unknown as SessionOverviewDeps['registry'],
      eventStore: {
        getSession: vi.fn(() => ({ lastSpeaker: 'assistant', lastSpeakerAt: Date.now() })),
        getAttentionSessions: vi.fn(() => []),
      } as unknown as SessionOverviewDeps['eventStore'],
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    const activities = emitter.getSnapshot();
    expect(activities[0].state).toBe('waiting');
    expect(activities[0].awaitingReply).toBe(false);
  });

  // ─── Uncommitted work ─────────────────────────────────────────────────────

  it('sets uncommittedWork when worktree is dirty', async () => {
    mockHasUncommittedWorkAsync.mockImplementation(async () => 'M some-file.ts');
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession({ cwd: '/Users/test/project' })]),
      } as unknown as SessionOverviewDeps['registry'],
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    // Flush the initial background refresh
    await vi.advanceTimersByTimeAsync(0);

    const activities = emitter.getSnapshot();
    expect(activities[0].uncommittedWork).toBe(true);
  });

  it('does not set uncommittedWork when worktree is clean', async () => {
    mockHasUncommittedWorkAsync.mockImplementation(async () => null);
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession({ cwd: '/Users/test/project' })]),
      } as unknown as SessionOverviewDeps['registry'],
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    await vi.advanceTimersByTimeAsync(0);

    const activities = emitter.getSnapshot();
    expect(activities[0].uncommittedWork).toBe(false);
  });

  // ─── Persistent attention sessions ────────────────────────────────────────

  it('includes recent persistent sessions as done', () => {
    const now = Date.now();
    const persistentMeta = {
      sessionId: 'persistent-1',
      summary: 'Fix auth bug',
      cwd: '/Users/test/tools/mitzo',
      lastSpeaker: 'assistant',
      lastSpeakerAt: now - 60_000, // 1 minute ago — within timeout
      updatedAt: now - 60_000,
      goalId: null,
    } as SessionMeta;

    deps = makeDeps({
      eventStore: {
        getSession: vi.fn(() => null),
        getAttentionSessions: vi.fn(() => [persistentMeta]),
      } as unknown as SessionOverviewDeps['eventStore'],
    });
    emitter = new SessionOverviewEmitter(deps);

    const activities = emitter.getSnapshot();
    expect(activities).toHaveLength(1);
    expect(activities[0].sessionId).toBe('persistent-1');
    expect(activities[0].title).toBe('Fix auth bug');
    expect(activities[0].state).toBe('done');
    expect(activities[0].awaitingReply).toBe(true);
  });

  it('transitions persistent sessions to idle after timeout', () => {
    const now = Date.now();
    const persistentMeta = {
      sessionId: 'persistent-old',
      summary: 'Stale session',
      cwd: '/Users/test/tools/mitzo',
      lastSpeaker: 'assistant',
      lastSpeakerAt: now - 10 * 60 * 1000, // 10 minutes ago — past timeout
      updatedAt: now - 10 * 60 * 1000,
      goalId: null,
    } as SessionMeta;

    deps = makeDeps({
      eventStore: {
        getSession: vi.fn(() => null),
        getAttentionSessions: vi.fn(() => [persistentMeta]),
      } as unknown as SessionOverviewDeps['eventStore'],
    });
    emitter = new SessionOverviewEmitter(deps);

    const activities = emitter.getSnapshot();
    expect(activities).toHaveLength(1);
    expect(activities[0].state).toBe('idle');
    expect(activities[0].awaitingReply).toBe(false);
  });

  it('does not duplicate persistent sessions that are also live', () => {
    const persistentMeta = {
      sessionId: 'session-1',
      summary: 'Fix auth bug',
      lastSpeaker: 'assistant',
      lastSpeakerAt: Date.now(),
      updatedAt: Date.now(),
      goalId: null,
    } as SessionMeta;

    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession({ sessionId: 'session-1' })]),
      } as unknown as SessionOverviewDeps['registry'],
      eventStore: {
        getSession: vi.fn(() => ({ lastSpeaker: 'assistant', lastSpeakerAt: Date.now() })),
        getAttentionSessions: vi.fn(() => [persistentMeta]),
      } as unknown as SessionOverviewDeps['eventStore'],
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    const activities = emitter.getSnapshot();
    expect(activities).toHaveLength(1);
    expect(activities[0].sessionId).toBe('session-1');
  });

  // ─── Background uncommitted work refresh ────────────────────────────────

  it('does not call git synchronously during compute', async () => {
    mockHasUncommittedWorkAsync.mockClear();
    mockHasUncommittedWorkAsync.mockImplementation(async () => 'M dirty.ts');
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession({ cwd: '/Users/test/project' })]),
      } as unknown as SessionOverviewDeps['registry'],
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    // Before background refresh resolves, cache returns false (safe default)
    const before = emitter.getSnapshot();
    expect(before[0].uncommittedWork).toBe(false);

    // After background refresh
    await vi.advanceTimersByTimeAsync(0);
    const after = emitter.getSnapshot();
    expect(after[0].uncommittedWork).toBe(true);
  });

  it('refreshes cache on interval', async () => {
    mockHasUncommittedWorkAsync.mockClear();
    mockHasUncommittedWorkAsync.mockImplementation(async () => 'M dirty.ts');
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession({ cwd: '/Users/test/project' })]),
      } as unknown as SessionOverviewDeps['registry'],
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    // Initial refresh
    await vi.advanceTimersByTimeAsync(0);
    expect(mockHasUncommittedWorkAsync).toHaveBeenCalledTimes(1);

    // Advance past refresh interval (60s)
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockHasUncommittedWorkAsync).toHaveBeenCalledTimes(2);
  });

  it('treats git error sentinels as clean (not dirty)', async () => {
    mockHasUncommittedWorkAsync.mockImplementation(async () => '[git status failed: timeout]');
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession({ cwd: '/Users/test/project' })]),
      } as unknown as SessionOverviewDeps['registry'],
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    await vi.advanceTimersByTimeAsync(0);

    const activities = emitter.getSnapshot();
    expect(activities[0].uncommittedWork).toBe(false);
  });

  // ─── Speaker caching ─────────────────────────────────────────────────────

  it('caches speaker lookups and avoids repeated eventStore.getSession calls', () => {
    const getSessionMock = vi.fn(() => ({ lastSpeaker: 'assistant', lastSpeakerAt: Date.now() }));
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession()]),
      } as unknown as SessionOverviewDeps['registry'],
      eventStore: {
        getAttentionSessions: vi.fn(() => []),
        getSession: getSessionMock,
      } as unknown as SessionOverviewDeps['eventStore'],
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    // First snapshot — should call getSession to populate cache
    emitter.getSnapshot();
    expect(getSessionMock).toHaveBeenCalledTimes(1);

    // Second snapshot — should use cached value
    emitter.getSnapshot();
    expect(getSessionMock).toHaveBeenCalledTimes(1);
  });

  it('updateSpeaker bypasses eventStore lookup', () => {
    const getSessionMock = vi.fn(() => null);
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession()]),
      } as unknown as SessionOverviewDeps['registry'],
      eventStore: {
        getAttentionSessions: vi.fn(() => []),
        getSession: getSessionMock,
      } as unknown as SessionOverviewDeps['eventStore'],
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    // Pre-populate cache
    emitter.updateSpeaker('session-1', 'assistant');

    const activities = emitter.getSnapshot();
    // Should NOT call getSession since cache was pre-populated
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(activities[0].awaitingReply).toBe(true);
  });

  it('updateSpeaker with user clears awaitingReply', () => {
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession()]),
      } as unknown as SessionOverviewDeps['registry'],
      eventStore: {
        getAttentionSessions: vi.fn(() => []),
        getSession: vi.fn(() => null),
      } as unknown as SessionOverviewDeps['eventStore'],
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    // Simulate assistant spoke last → awaitingReply
    emitter.updateSpeaker('session-1', 'assistant');
    expect(emitter.getSnapshot()[0].awaitingReply).toBe(true);

    // Simulate user sends a message → no longer awaiting reply
    emitter.updateSpeaker('session-1', 'user');
    expect(emitter.getSnapshot()[0].awaitingReply).toBe(false);
  });

  it('forget clears speakerCache when sessionId is provided', () => {
    const getSessionMock = vi.fn(() => null);
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession()]),
      } as unknown as SessionOverviewDeps['registry'],
      eventStore: {
        getAttentionSessions: vi.fn(() => []),
        getSession: getSessionMock,
      } as unknown as SessionOverviewDeps['eventStore'],
    });
    emitter = new SessionOverviewEmitter(deps);
    emitter.touch('client-1');

    // Pre-populate speaker cache
    emitter.updateSpeaker('session-1', 'assistant');
    emitter.getSnapshot(); // uses cached value
    expect(getSessionMock).not.toHaveBeenCalled();

    // Forget with sessionId should clear cache
    emitter.forget('client-1', 'session-1');

    // Re-add and snapshot — should fall through to eventStore
    emitter.touch('client-1');
    emitter.getSnapshot();
    expect(getSessionMock).toHaveBeenCalled();
  });

  // ─── Idle transition timer ──────────────────────────────────────────────

  it('broadcasts idle transition after DONE_TIMEOUT_MS', () => {
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession({ hasSnapshot: false, attached: true })]),
      } as unknown as SessionOverviewDeps['registry'],
    });
    emitter = new SessionOverviewEmitter(deps);
    const broadcast = deps.sseRegistry.broadcast as ReturnType<typeof vi.fn>;

    emitter.touch('client-1');
    broadcast.mockClear();

    // Advance past the 5-minute idle transition timer
    vi.advanceTimersByTime(5 * 60 * 1000);
    // Coalesce timer (200ms) fires after the idle transition schedules it
    vi.advanceTimersByTime(200);

    // Should have broadcast with the session now in "idle" state
    expect(broadcast).toHaveBeenCalled();
    const lastCall = broadcast.mock.calls[broadcast.mock.calls.length - 1];
    const activities = lastCall[1] as SessionActivity[];
    expect(activities[0].state).toBe('idle');
  });

  it('resets idle transition timer on subsequent touch', () => {
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [makeActiveSession({ hasSnapshot: false, attached: true })]),
      } as unknown as SessionOverviewDeps['registry'],
    });
    emitter = new SessionOverviewEmitter(deps);
    const broadcast = deps.sseRegistry.broadcast as ReturnType<typeof vi.fn>;

    emitter.touch('client-1');
    broadcast.mockClear();

    // Advance 4 minutes, then touch again (resets timer)
    vi.advanceTimersByTime(4 * 60 * 1000);
    emitter.touch('client-1');
    broadcast.mockClear();

    // Advance 4 more minutes — should still be "done" (only 4 min since last touch)
    vi.advanceTimersByTime(4 * 60 * 1000);
    const snapshot = emitter.getSnapshot();
    expect(snapshot[0].state).toBe('done');
  });

  it('transitions staggered sessions on their own schedule', () => {
    deps = makeDeps({
      registry: {
        getActiveSessions: vi.fn(() => [
          makeActiveSession({
            clientId: 'client-a',
            sessionId: 'sess-a',
            hasSnapshot: false,
            attached: true,
          }),
          makeActiveSession({
            clientId: 'client-b',
            sessionId: 'sess-b',
            hasSnapshot: false,
            attached: true,
          }),
        ]),
      } as unknown as SessionOverviewDeps['registry'],
    });
    emitter = new SessionOverviewEmitter(deps);
    const broadcast = deps.sseRegistry.broadcast as ReturnType<typeof vi.fn>;

    // Session A touched at T=0
    emitter.touch('client-a');
    // Session B touched at T=3min
    vi.advanceTimersByTime(3 * 60 * 1000);
    emitter.touch('client-b');
    broadcast.mockClear();

    // At T=5min (2min after B touch), session A should be idle
    vi.advanceTimersByTime(2 * 60 * 1000);
    vi.advanceTimersByTime(200); // coalesce
    expect(broadcast).toHaveBeenCalled();
    const firstBroadcast = broadcast.mock.calls[broadcast.mock.calls.length - 1];
    const activities = firstBroadcast[1] as SessionActivity[];
    const sessA = activities.find((a) => a.sessionId === 'sess-a');
    const sessB = activities.find((a) => a.sessionId === 'sess-b');
    expect(sessA?.state).toBe('idle');
    expect(sessB?.state).toBe('done');
  });

  it('transitions persistent sessions to idle via timer', () => {
    const now = Date.now();
    const persistentMeta = {
      sessionId: 'persistent-timed',
      summary: 'Awaiting reply',
      cwd: '/Users/test/tools/mitzo',
      lastSpeaker: 'assistant',
      lastSpeakerAt: now - 60_000, // 1 minute ago
      updatedAt: now - 60_000,
      goalId: null,
    } as SessionMeta;

    deps = makeDeps({
      eventStore: {
        getSession: vi.fn(() => null),
        getAttentionSessions: vi.fn(() => [persistentMeta]),
      } as unknown as SessionOverviewDeps['eventStore'],
    });
    emitter = new SessionOverviewEmitter(deps);
    const broadcast = deps.sseRegistry.broadcast as ReturnType<typeof vi.fn>;

    // Touch to start the idle transition timer — timer fires at
    // DONE_TIMEOUT_MS from this touch, at which point the persistent
    // session's lastSpeakerAt will be 6 min ago (past the 5 min threshold).
    emitter.touch('persistent-timed');
    broadcast.mockClear();

    // Advance past DONE_TIMEOUT_MS from the touch
    vi.advanceTimersByTime(5 * 60 * 1000);
    vi.advanceTimersByTime(200); // coalesce

    expect(broadcast).toHaveBeenCalled();
    const lastCall = broadcast.mock.calls[broadcast.mock.calls.length - 1];
    const activities = lastCall[1] as SessionActivity[];
    const persistent = activities.find((a) => a.sessionId === 'persistent-timed');
    expect(persistent?.state).toBe('idle');
  });
});
