import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionOverviewEmitter, type SessionOverviewDeps } from '../session-overview.js';
import type { ActiveSessionInfo } from '@mitzo/harness';
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SessionOverviewEmitter', () => {
  let emitter: SessionOverviewEmitter;
  let deps: SessionOverviewDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    mockGetPending.mockReturnValue(0);
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
});
