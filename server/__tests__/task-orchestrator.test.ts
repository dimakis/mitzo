import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { TaskStore } from '../task-store.js';
import { TaskOrchestrator } from '../task-orchestrator.js';
import type { OrchestratorDeps, LoopStatus } from '../task-orchestrator.js';

// Mock sendToChat
vi.mock('../chat.js', () => ({
  sendToChat: vi.fn(() => true),
}));

const TEST_DIR = join(tmpdir(), `mitzo-orchestrator-test-${process.pid}`);

let store: TaskStore;
let orchestrator: TaskOrchestrator;
let mockDeps: OrchestratorDeps;
let broadcastedStatuses: LoopStatus[];

function createTestDeps(store: TaskStore): OrchestratorDeps {
  broadcastedStatuses = [];
  return {
    store,
    getClientId: () => 'test-client',
    setTaskContext: vi.fn(),
    clearTaskContext: vi.fn(),
    broadcastStatus: (s) => broadcastedStatuses.push(s),
    broadcastTasks: vi.fn(),
  };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  store = new TaskStore(join(TEST_DIR, `tasks-${Date.now()}.db`));
  mockDeps = createTestDeps(store);
  orchestrator = new TaskOrchestrator(mockDeps);
});

afterEach(() => {
  store.close();
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('TaskOrchestrator', () => {
  it('starts in idle state', () => {
    const status = orchestrator.getStatus();
    expect(status.state).toBe('idle');
    expect(status.goalId).toBeNull();
  });

  it('start() transitions to running and assigns first task', () => {
    const goal = store.create({ title: 'Goal' });
    const child = store.create({ title: 'First task', parentId: goal.id });

    orchestrator.start(goal.id);

    const status = orchestrator.getStatus();
    expect(status.state).toBe('running');
    expect(status.goalId).toBe(goal.id);
    expect(status.activeTaskId).toBe(child.id);
    expect(store.get(child.id)!.status).toBe('active');
  });

  it('pause() transitions from running to paused', () => {
    const goal = store.create({ title: 'Goal' });
    store.create({ title: 'Task', parentId: goal.id });

    orchestrator.start(goal.id);
    orchestrator.pause();

    expect(orchestrator.getStatus().state).toBe('paused');
  });

  it('resume() transitions from paused to running', () => {
    const goal = store.create({ title: 'Goal' });
    store.create({ title: 'Task 1', parentId: goal.id });
    store.create({ title: 'Task 2', parentId: goal.id });

    orchestrator.start(goal.id);
    orchestrator.pause();
    orchestrator.resume();

    expect(orchestrator.getStatus().state).toBe('running');
  });

  it('stop() transitions to idle and clears state', () => {
    const goal = store.create({ title: 'Goal' });
    store.create({ title: 'Task', parentId: goal.id });

    orchestrator.start(goal.id);
    orchestrator.stop();

    const status = orchestrator.getStatus();
    expect(status.state).toBe('idle');
    expect(status.goalId).toBeNull();
    expect(status.activeTaskId).toBeNull();
    expect(mockDeps.clearTaskContext).toHaveBeenCalled();
  });

  it('tick assigns deepest-left pending leaf (DFS)', () => {
    const goal = store.create({ title: 'Goal' });
    const parent = store.create({ title: 'Parent', parentId: goal.id });
    const leaf = store.create({ title: 'Leaf', parentId: parent.id });
    store.create({ title: 'Sibling', parentId: goal.id });

    orchestrator.start(goal.id);

    expect(orchestrator.getStatus().activeTaskId).toBe(leaf.id);
    expect(store.get(leaf.id)!.status).toBe('active');
  });

  it('tick does nothing when paused', () => {
    const goal = store.create({ title: 'Goal' });
    store.create({ title: 'Task', parentId: goal.id });

    orchestrator.start(goal.id);
    orchestrator.pause();

    const activeId = orchestrator.getStatus().activeTaskId;
    // Manually call tick — should not change anything
    orchestrator.tick();
    expect(orchestrator.getStatus().activeTaskId).toBe(activeId);
  });

  it('tick transitions to idle when all tasks done', () => {
    const goal = store.create({ title: 'Goal' });
    const child = store.create({ title: 'Only task', parentId: goal.id });

    orchestrator.start(goal.id);

    // Simulate task completion
    store.update(child.id, { status: 'done' });
    store.cascadeStatus(child.id);
    orchestrator.onTaskCompleted(child.id);

    expect(orchestrator.getStatus().state).toBe('idle');
  });

  it('tick skips blocked tasks and finds next', () => {
    const goal = store.create({ title: 'Goal' });
    const c1 = store.create({ title: 'Blocked', parentId: goal.id });
    const c2 = store.create({ title: 'Available', parentId: goal.id });
    store.update(c1.id, { status: 'blocked' });

    orchestrator.start(goal.id);

    expect(orchestrator.getStatus().activeTaskId).toBe(c2.id);
  });

  it('onTaskCompleted triggers tick and assigns next', () => {
    const goal = store.create({ title: 'Goal' });
    const c1 = store.create({ title: 'Task 1', parentId: goal.id });
    const c2 = store.create({ title: 'Task 2', parentId: goal.id });

    orchestrator.start(goal.id);
    expect(orchestrator.getStatus().activeTaskId).toBe(c1.id);

    // Complete first task
    store.update(c1.id, { status: 'done' });
    store.cascadeStatus(c1.id);
    orchestrator.onTaskCompleted(c1.id);

    expect(orchestrator.getStatus().activeTaskId).toBe(c2.id);
  });

  it('onTaskBlocked triggers tick', () => {
    const goal = store.create({ title: 'Goal' });
    const c1 = store.create({ title: 'Task 1', parentId: goal.id });
    const c2 = store.create({ title: 'Task 2', parentId: goal.id });

    orchestrator.start(goal.id);

    store.update(c1.id, { status: 'blocked' });
    store.cascadeStatus(c1.id);
    orchestrator.onTaskBlocked(c1.id);

    expect(orchestrator.getStatus().activeTaskId).toBe(c2.id);
  });

  it('broadcasts status on state changes', () => {
    const goal = store.create({ title: 'Goal' });
    store.create({ title: 'Task', parentId: goal.id });

    orchestrator.start(goal.id);
    expect(broadcastedStatuses.length).toBeGreaterThan(0);
    expect(broadcastedStatuses[0].state).toBe('running');
  });

  it('sets task context on session when assigning', () => {
    const goal = store.create({ title: 'Goal' });
    const child = store.create({ title: 'Task', parentId: goal.id });

    orchestrator.start(goal.id);

    expect(mockDeps.setTaskContext).toHaveBeenCalledWith(child.id, goal.id);
  });

  it('computes progress correctly', () => {
    const goal = store.create({ title: 'Goal' });
    const c1 = store.create({ title: 'Task 1', parentId: goal.id });
    store.create({ title: 'Task 2', parentId: goal.id });
    store.create({ title: 'Task 3', parentId: goal.id });
    store.update(c1.id, { status: 'done' });

    orchestrator.start(goal.id);

    const status = orchestrator.getStatus();
    expect(status.progress).toEqual({ done: 1, total: 3 });
  });

  it('pauses when no executable tasks (all blocked)', () => {
    const goal = store.create({ title: 'Goal' });
    const c1 = store.create({ title: 'Task', parentId: goal.id });
    store.update(c1.id, { status: 'blocked' });

    orchestrator.start(goal.id);

    expect(orchestrator.getStatus().state).toBe('paused');
  });

  describe('spec mode', () => {
    it('start with specMode assigns goal directly', () => {
      const goal = store.create({ title: 'Goal' });
      const status = orchestrator.start(goal.id, { specMode: true });

      expect(status.state).toBe('running');
      expect(status.specMode).toBe(true);
      expect(status.activeTaskId).toBe(goal.id);
      expect(store.get(goal.id)!.status).toBe('active');
    });

    it('onSpecDecomposed pauses and sets awaitingApproval', () => {
      const goal = store.create({ title: 'Goal' });
      orchestrator.start(goal.id, { specMode: true });

      orchestrator.onSpecDecomposed();

      const status = orchestrator.getStatus();
      expect(status.state).toBe('paused');
      expect(status.awaitingApproval).toBe(true);
    });

    it('onSpecDecomposed is no-op when not in spec mode', () => {
      const goal = store.create({ title: 'Goal' });
      store.create({ title: 'Task', parentId: goal.id });
      orchestrator.start(goal.id);

      orchestrator.onSpecDecomposed();

      expect(orchestrator.getStatus().state).toBe('running');
      expect(orchestrator.getStatus().awaitingApproval).toBe(false);
    });

    it('approveSpec transitions to execution mode', () => {
      const goal = store.create({ title: 'Goal' });
      orchestrator.start(goal.id, { specMode: true });
      // Simulate agent creating children
      store.create({ title: 'Sub 1', parentId: goal.id });
      store.create({ title: 'Sub 2', parentId: goal.id });
      orchestrator.onSpecDecomposed();

      const status = orchestrator.approveSpec();

      expect(status.state).toBe('running');
      expect(status.specMode).toBe(false);
      expect(status.awaitingApproval).toBe(false);
    });

    it('rejectSpec deletes children and stops', () => {
      const goal = store.create({ title: 'Goal' });
      orchestrator.start(goal.id, { specMode: true });
      const c1 = store.create({ title: 'Sub 1', parentId: goal.id });
      const c2 = store.create({ title: 'Sub 2', parentId: goal.id });
      orchestrator.onSpecDecomposed();

      const status = orchestrator.rejectSpec();

      expect(status.state).toBe('idle');
      expect(store.get(c1.id)).toBeNull();
      expect(store.get(c2.id)).toBeNull();
      expect(store.get(goal.id)!.status).toBe('pending');
    });

    it('approveSpec is no-op when not awaiting approval', () => {
      const goal = store.create({ title: 'Goal' });
      store.create({ title: 'Task', parentId: goal.id });
      orchestrator.start(goal.id);

      const before = orchestrator.getStatus();
      orchestrator.approveSpec();
      const after = orchestrator.getStatus();

      expect(after.state).toBe(before.state);
    });

    it('rejectSpec is no-op when not awaiting approval', () => {
      const goal = store.create({ title: 'Goal' });
      store.create({ title: 'Task', parentId: goal.id });
      orchestrator.start(goal.id);

      const before = orchestrator.getStatus();
      orchestrator.rejectSpec();

      expect(orchestrator.getStatus().state).toBe(before.state);
    });
  });

  describe('orphan detection', () => {
    it('reclaims orphaned tasks during tick', () => {
      // Create deps with getActiveSessionIds
      const depsWithOrphan = createTestDeps(store);
      depsWithOrphan.getActiveSessionIds = () => new Set(['alive-session']);
      const orch = new TaskOrchestrator(depsWithOrphan);

      const goal = store.create({ title: 'Goal' });
      const c1 = store.create({ title: 'Orphan', parentId: goal.id });
      store.create({ title: 'Next', parentId: goal.id });

      // Simulate c1 assigned to dead session
      store.update(c1.id, { status: 'active' });
      store.setSessionId(c1.id, 'dead-session');

      orch.start(goal.id);

      // c1 should have been reclaimed to pending, then re-assigned
      // The tick should have picked c1 (first pending) since it was reclaimed
      expect(store.get(c1.id)!.status).toBe('active');
      expect(orch.getStatus().activeTaskId).toBe(c1.id);
    });

    it('does not reclaim tasks with alive sessions', () => {
      const depsWithOrphan = createTestDeps(store);
      depsWithOrphan.getActiveSessionIds = () => new Set(['alive-session']);
      const orch = new TaskOrchestrator(depsWithOrphan);

      const goal = store.create({ title: 'Goal' });
      const c1 = store.create({ title: 'Active', parentId: goal.id });
      const c2 = store.create({ title: 'Next', parentId: goal.id });

      store.update(c1.id, { status: 'active' });
      store.setSessionId(c1.id, 'alive-session');

      orch.start(goal.id);

      // c1 is alive, so tick should skip it and pick c2
      expect(orch.getStatus().activeTaskId).toBe(c2.id);
    });

    it('clientId namespace: orphan detection must use clientIds not sessionIds', () => {
      // Reproduces the root cause of the runaway spawn incident:
      // tasks store clientId (e.g. "headless:abc") but getActiveSessionIds
      // was returning SDK sessionIds (UUIDs). The IDs never matched, so every
      // spawned task was always classified as orphaned and re-spawned.
      const deps = createTestDeps(store);
      // Simulate a registry that has clientId "headless:abc-123" registered
      deps.getActiveSessionIds = () => new Set(['headless:abc-123']);
      const orch = new TaskOrchestrator(deps);

      const goal = store.create({ title: 'Goal' });
      const task = store.create({ title: 'Spawned task', parentId: goal.id });

      // Simulate what spawnSession does: set task active with clientId
      store.update(task.id, { status: 'active' });
      store.setSessionId(task.id, 'headless:abc-123');

      orch.start(goal.id);

      // Task should NOT be reclaimed — its clientId matches the active set
      expect(store.get(task.id)!.status).toBe('active');
      expect(store.get(task.id)!.sessionId).toBe('headless:abc-123');
    });

    it('clientId namespace: reclaims task when clientId is truly gone', () => {
      const deps = createTestDeps(store);
      // Registry has different clientIds — "headless:abc-123" is NOT here
      deps.getActiveSessionIds = () => new Set(['headless:other-session']);
      const orch = new TaskOrchestrator(deps);

      const goal = store.create({ title: 'Goal' });
      const task = store.create({ title: 'Dead task', parentId: goal.id });

      store.update(task.id, { status: 'active' });
      store.setSessionId(task.id, 'headless:abc-123');

      orch.start(goal.id);

      // Task SHOULD be reclaimed — its clientId is not in the active set
      // and it wasn't recently spawned (no grace period entry)
      expect(store.get(task.id)!.status).toBe('active'); // reclaimed then re-assigned
      expect(store.get(task.id)!.sessionId).toBeNull(); // sessionId cleared
      expect(orch.getStatus().activeTaskId).toBe(task.id);
    });
  });

  describe('spawn-orphan loop prevention', () => {
    it('spawned task is not reclaimed by orphan detection on next tick', async () => {
      // End-to-end reproduction of the runaway incident:
      // 1. Orchestrator spawns a session for a task
      // 2. spawnSession returns clientId, task gets session_id = clientId
      // 3. Next tick runs orphan detection
      // 4. Task must NOT be reclaimed (grace period protects it)
      const spawnedClientId = 'headless:spawn-test-001';
      const spawnSession = vi.fn().mockResolvedValue(spawnedClientId);
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      // Simulate registry that does NOT yet have the spawned session
      // (worst case: session hasn't registered yet)
      deps.getActiveSessionIds = () => new Set();
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      const task = store.create({
        title: 'Review PR',
        parentId: goal.id,
        sessionPolicy: 'spawn',
      });

      orch.start(goal.id);

      // Wait for spawn to complete
      await vi.waitFor(() => {
        expect(spawnSession).toHaveBeenCalledTimes(1);
      });

      // Wait for session_id to be set on the task
      await vi.waitFor(() => {
        expect(store.get(task.id)!.sessionId).toBe(spawnedClientId);
      });

      // Manually trigger another tick — orphan detection runs
      orch.onTaskCompleted('some-other-task');

      // Task must still be active with its session_id intact
      // Grace period prevents reclamation even though clientId is not in active set
      expect(store.get(task.id)!.status).toBe('active');
      expect(store.get(task.id)!.sessionId).toBe(spawnedClientId);

      // spawnSession must NOT have been called again for this task
      expect(spawnSession).toHaveBeenCalledTimes(1);
    });

    it('single task cannot spawn more than one session', async () => {
      // The incident spawned 50 sessions for 1 task. Even with all safety
      // layers disabled, one task should produce at most one spawn call.
      const spawnSession = vi.fn().mockResolvedValue('headless:single-001');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      deps.getActiveSessionIds = () => new Set();
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      store.create({
        title: 'Single task',
        parentId: goal.id,
        sessionPolicy: 'spawn',
      });

      orch.start(goal.id);

      await vi.waitFor(() => {
        expect(spawnSession).toHaveBeenCalledTimes(1);
      });

      // Trigger multiple ticks — none should re-spawn the same task
      for (let i = 0; i < 10; i++) {
        orch.onTaskCompleted('trigger-tick');
      }

      // Still exactly 1 spawn call
      expect(spawnSession).toHaveBeenCalledTimes(1);
    });

    it('grace period expires after SPAWN_GRACE_MS, allowing reclamation', async () => {
      vi.useFakeTimers();
      const baseTime = Date.now();

      const spawnSession = vi.fn().mockResolvedValue('headless:grace-001');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      deps.getActiveSessionIds = () => new Set(); // session never appears
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      const task = store.create({
        title: 'Will expire',
        parentId: goal.id,
        sessionPolicy: 'spawn',
      });

      orch.start(goal.id);

      // Flush microtasks so the spawn callback resolves
      await vi.advanceTimersByTimeAsync(0);
      expect(spawnSession).toHaveBeenCalledTimes(1);
      expect(store.get(task.id)!.sessionId).toBe('headless:grace-001');

      // Advance past the 60s grace period
      vi.setSystemTime(baseTime + 61_000);

      // Orchestrator paused after spawning (no more pending tasks).
      // Resume triggers tick → orphan detection should now reclaim.
      orch.resume();

      // Task should have been reclaimed — session_id cleared
      const updated = store.get(task.id)!;
      expect(updated.sessionId).not.toBe('headless:grace-001');

      vi.useRealTimers();
    });

    it('rate limiter blocks respawn even if task is reclaimed', async () => {
      // Saturate the rate limiter, then verify a reclaimed task
      // cannot trigger another spawn.
      const spawnSession = vi.fn().mockResolvedValue('headless:rate-limit');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      deps.getActiveSessionIds = () => new Set(); // everything looks orphaned
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      // Create 5 tasks to saturate the rate limiter
      for (let i = 0; i < 5; i++) {
        store.create({
          title: `Task ${i}`,
          parentId: goal.id,
          sessionPolicy: 'spawn',
        });
      }
      // Create the task that should be blocked
      const victim = store.create({
        title: 'Should be blocked',
        parentId: goal.id,
        sessionPolicy: 'spawn',
      });

      orch.start(goal.id);

      await vi.waitFor(() => {
        expect(spawnSession).toHaveBeenCalledTimes(5);
      });

      // The 6th task (victim) should NOT have been spawned
      expect(store.get(victim.id)!.status).toBe('pending');
      expect(store.get(victim.id)!.sessionId).toBeNull();

      // Trigger more ticks — still blocked by rate limiter
      orch.onTaskCompleted('trigger');
      expect(spawnSession).toHaveBeenCalledTimes(5);
    });

    it('rate limiter schedules retry after window expires', async () => {
      vi.useFakeTimers();

      const spawnSession = vi.fn().mockResolvedValue('headless:retry');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      // Create 6 tasks — 5 will spawn (depth-limited), 6th deferred
      for (let i = 0; i < 6; i++) {
        store.create({
          title: `Task ${i}`,
          parentId: goal.id,
          sessionPolicy: 'spawn',
        });
      }

      orch.start(goal.id);

      // Flush microtasks to let spawns resolve
      await vi.advanceTimersByTimeAsync(0);
      expect(spawnSession).toHaveBeenCalledTimes(5);

      // Trigger a new tick chain — depth resets but rate limiter blocks the 6th task
      // and schedules a retry timer
      orch.onTaskCompleted('trigger');
      expect(spawnSession).toHaveBeenCalledTimes(5); // still blocked

      // Advance past the rate limit window — retry timer should fire
      await vi.advanceTimersByTimeAsync(61_000);

      // The 6th task should now be spawned
      expect(spawnSession).toHaveBeenCalledTimes(6);

      vi.useRealTimers();
    });
  });

  describe('task approval', () => {
    it('approveTask moves pending_review to done', () => {
      const goal = store.create({ title: 'Goal' });
      const c1 = store.create({ title: 'Task 1', parentId: goal.id });
      store.create({ title: 'Task 2', parentId: goal.id });

      orchestrator.start(goal.id);
      store.update(c1.id, { status: 'pending_review' });

      const ok = orchestrator.approveTask(c1.id);

      expect(ok).toBe(true);
      expect(store.get(c1.id)!.status).toBe('done');
    });

    it('approveTask returns false for non-pending_review', () => {
      const goal = store.create({ title: 'Goal' });
      const c1 = store.create({ title: 'Task', parentId: goal.id });

      orchestrator.start(goal.id);

      expect(orchestrator.approveTask(c1.id)).toBe(false);
    });

    it('approveTask triggers tick when running', () => {
      const goal = store.create({ title: 'Goal' });
      const c1 = store.create({ title: 'Task 1', parentId: goal.id });
      const c2 = store.create({ title: 'Task 2', parentId: goal.id });

      orchestrator.start(goal.id);
      store.update(c1.id, { status: 'pending_review' });

      orchestrator.approveTask(c1.id);

      // After approval + tick, c2 should be active
      expect(orchestrator.getStatus().activeTaskId).toBe(c2.id);
    });

    it('rejectTask moves pending_review to active with feedback', () => {
      const goal = store.create({ title: 'Goal' });
      const c1 = store.create({ title: 'Task', parentId: goal.id });
      store.create({ title: 'Task 2', parentId: goal.id });

      orchestrator.start(goal.id);
      store.update(c1.id, { status: 'pending_review' });

      const ok = orchestrator.rejectTask(c1.id, 'needs more tests');

      expect(ok).toBe(true);
      const task = store.get(c1.id)!;
      expect(task.status).toBe('active');
      expect(task.annotations).toContain('review_feedback: needs more tests');
    });

    it('rejectTask returns false for non-pending_review', () => {
      const goal = store.create({ title: 'Goal' });
      const c1 = store.create({ title: 'Task', parentId: goal.id });

      orchestrator.start(goal.id);

      expect(orchestrator.rejectTask(c1.id, 'nope')).toBe(false);
    });
  });

  describe('stage type dispatch', () => {
    it('wait_for_signal tasks register with signal watcher instead of agent', () => {
      const watchSignal = vi.fn();
      const deps = createTestDeps(store);
      deps.watchSignal = watchSignal;
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      store.create({
        title: 'Wait for CI',
        parentId: goal.id,
        stageType: 'wait_for_signal',
        gateConfig: { type: 'gh_ci', repo: 'org/repo', pr: 42 },
      });

      orch.start(goal.id);

      const task = store.getChildren(goal.id)[0];
      expect(task.status).toBe('active');
      expect(watchSignal).toHaveBeenCalledWith(task.id, {
        type: 'gh_ci',
        repo: 'org/repo',
        pr: 42,
      });
      // Should NOT have set task context on session (no agent work)
      expect(deps.setTaskContext).not.toHaveBeenCalled();
    });

    it('human_review tasks go to pending_review immediately', () => {
      const deps = createTestDeps(store);
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      store.create({
        title: 'Review design',
        parentId: goal.id,
        stageType: 'human_review',
      });

      orch.start(goal.id);

      const task = store.getChildren(goal.id)[0];
      expect(task.status).toBe('pending_review');
      expect(deps.setTaskContext).not.toHaveBeenCalled();
    });

    it('agent_work tasks behave as before (assign to session)', () => {
      const deps = createTestDeps(store);
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      store.create({
        title: 'Do agent work',
        parentId: goal.id,
        stageType: 'agent_work',
      });

      orch.start(goal.id);

      const task = store.getChildren(goal.id)[0];
      expect(task.status).toBe('active');
      expect(deps.setTaskContext).toHaveBeenCalledWith(task.id, goal.id);
    });

    it('null stageType tasks behave as agent_work (backwards compat)', () => {
      const deps = createTestDeps(store);
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      store.create({ title: 'Legacy task', parentId: goal.id });

      orch.start(goal.id);

      const task = store.getChildren(goal.id)[0];
      expect(task.status).toBe('active');
      expect(deps.setTaskContext).toHaveBeenCalled();
    });

    it('mixed workflow: agent_work → wait_for_signal → human_review', () => {
      const watchSignal = vi.fn();
      const deps = createTestDeps(store);
      deps.watchSignal = watchSignal;
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Workflow Goal' });
      const agent = store.create({
        title: 'Agent step',
        parentId: goal.id,
        stageType: 'agent_work',
        priority: 3,
      });
      const signal = store.create({
        title: 'Signal step',
        parentId: goal.id,
        stageType: 'wait_for_signal',
        gateConfig: { type: 'gh_ci', repo: 'org/repo', pr: 1 },
        priority: 2,
      });
      const review = store.create({
        title: 'Review step',
        parentId: goal.id,
        stageType: 'human_review',
        priority: 1,
      });

      // Start: should pick agent_work (highest priority)
      orch.start(goal.id);
      expect(orch.getStatus().activeTaskId).toBe(agent.id);
      expect(store.get(agent.id)!.status).toBe('active');

      // Complete agent work → should pick wait_for_signal
      store.update(agent.id, { status: 'done' });
      store.cascadeStatus(agent.id);
      orch.onTaskCompleted(agent.id);
      expect(orch.getStatus().activeTaskId).toBe(signal.id);
      expect(store.get(signal.id)!.status).toBe('active');
      expect(watchSignal).toHaveBeenCalledWith(signal.id, {
        type: 'gh_ci',
        repo: 'org/repo',
        pr: 1,
      });

      // Simulate signal resolved → should pick human_review
      store.update(signal.id, { status: 'done' });
      store.cascadeStatus(signal.id);
      orch.onTaskCompleted(signal.id);
      expect(orch.getStatus().activeTaskId).toBe(review.id);
      expect(store.get(review.id)!.status).toBe('pending_review');

      // Approve human review → goal done
      orch.approveTask(review.id);
      expect(orch.getStatus().state).toBe('idle');
    });
  });

  describe('session_policy: spawn', () => {
    it('calls spawnSession for tasks with session_policy spawn', async () => {
      const spawnSession = vi.fn().mockResolvedValue('spawned-client-1');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      store.create({
        title: 'Spawn task',
        parentId: goal.id,
        sessionPolicy: 'spawn',
      });

      orch.start(goal.id);

      await vi.waitFor(() => {
        expect(spawnSession).toHaveBeenCalled();
      });

      const [, prompt, goalArg] = spawnSession.mock.calls[0];
      expect(goalArg).toBe(goal.id);
      expect(prompt).toContain('Spawn task');
    });

    it('does not set activeTaskId for spawned tasks', () => {
      const spawnSession = vi.fn().mockResolvedValue('spawned-client-1');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      store.create({
        title: 'Spawn task',
        parentId: goal.id,
        sessionPolicy: 'spawn',
      });

      orch.start(goal.id);

      expect(orch.getStatus().activeTaskId).toBeNull();
    });

    it('falls back to pinned session when spawnSession is not provided', () => {
      const deps = createTestDeps(store);
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      const task = store.create({
        title: 'Spawn task',
        parentId: goal.id,
        sessionPolicy: 'spawn',
      });

      orch.start(goal.id);

      expect(orch.getStatus().activeTaskId).toBe(task.id);
      expect(deps.setTaskContext).toHaveBeenCalledWith(task.id, goal.id);
    });

    it('marks task active before spawning', () => {
      const spawnSession = vi.fn().mockResolvedValue('spawned-client-1');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      const task = store.create({
        title: 'Spawn task',
        parentId: goal.id,
        sessionPolicy: 'spawn',
      });

      orch.start(goal.id);

      expect(store.get(task.id)!.status).toBe('active');
    });

    it('blocks task when spawnSession rejects', async () => {
      const spawnSession = vi.fn().mockRejectedValue(new Error('worktree failure'));
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      const task = store.create({
        title: 'Spawn task',
        parentId: goal.id,
        sessionPolicy: 'spawn',
      });

      orch.start(goal.id);

      await vi.waitFor(() => {
        expect(store.get(task.id)!.status).toBe('blocked');
      });

      const updated = store.get(task.id)!;
      expect(updated.annotations.some((a) => a.includes('spawn_error'))).toBe(true);
      expect(deps.broadcastTasks).toHaveBeenCalled();
    });

    it('falls back to pinned session when spawnSession returns null', async () => {
      const spawnSession = vi.fn().mockResolvedValue(null);
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      const task = store.create({
        title: 'Spawn task',
        parentId: goal.id,
        sessionPolicy: 'spawn',
      });

      orch.start(goal.id);

      await vi.waitFor(() => {
        expect(deps.setTaskContext).toHaveBeenCalledWith(task.id, goal.id);
      });

      expect(orch.getStatus().activeTaskId).toBe(task.id);
    });

    it('ignores spawn callback if stop() was called during spawn', async () => {
      let resolveSpawn: (v: string | null) => void;
      const spawnSession = vi.fn().mockImplementation(
        () =>
          new Promise<string | null>((r) => {
            resolveSpawn = r;
          }),
      );
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      store.create({
        title: 'Spawn task',
        parentId: goal.id,
        sessionPolicy: 'spawn',
      });

      orch.start(goal.id);
      orch.stop();

      // Resolve after stop — callback should be a no-op
      resolveSpawn!(null);
      await vi.waitFor(() => {
        expect(spawnSession).toHaveBeenCalled();
      });

      expect(orch.getStatus().state).toBe('idle');
      expect(deps.setTaskContext).not.toHaveBeenCalled();
    });

    it('ignores spawn callback if orchestrator restarted with different goal', async () => {
      let resolveSpawn: (v: string | null) => void;
      const spawnSession = vi.fn().mockImplementation(
        () =>
          new Promise<string | null>((r) => {
            resolveSpawn = r;
          }),
      );
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal1 = store.create({ title: 'Goal 1' });
      store.create({
        title: 'Spawn task',
        parentId: goal1.id,
        sessionPolicy: 'spawn',
      });

      const goal2 = store.create({ title: 'Goal 2' });
      const reuse = store.create({
        title: 'Reuse task',
        parentId: goal2.id,
        sessionPolicy: 'reuse',
      });

      // Start goal1 (spawns), stop, start goal2
      orch.start(goal1.id);
      orch.stop();
      orch.start(goal2.id);

      expect(orch.getStatus().goalId).toBe(goal2.id);
      expect(orch.getStatus().activeTaskId).toBe(reuse.id);

      // Resolve old spawn — should be ignored (goalId changed)
      resolveSpawn!(null);
      await vi.waitFor(() => {
        expect(spawnSession).toHaveBeenCalled();
      });

      // activeTaskId should still be the goal2 task, not clobbered
      expect(orch.getStatus().activeTaskId).toBe(reuse.id);
    });

    it('blocks spawn-failed task when pinned session is busy', async () => {
      const calls: Array<(v: string | null) => void> = [];
      const spawnSession = vi.fn().mockImplementation(
        () =>
          new Promise<string | null>((r) => {
            calls.push(r);
          }),
      );
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      store.create({
        title: 'Spawn task 1',
        parentId: goal.id,
        sessionPolicy: 'spawn',
      });
      store.create({
        title: 'Spawn task 2',
        parentId: goal.id,
        sessionPolicy: 'spawn',
      });

      orch.start(goal.id);

      await vi.waitFor(() => {
        expect(calls).toHaveLength(2);
      });

      // First spawn fails — claims pinned session
      calls[0](null);
      await vi.waitFor(() => {
        expect(orch.getStatus().activeTaskId).not.toBeNull();
      });

      // Second spawn also fails — pinned session busy, should block
      calls[1](null);
      await vi.waitFor(() => {
        const tasks = store.getChildren(goal.id);
        const blocked = tasks.filter((t) => t.status === 'blocked');
        expect(blocked).toHaveLength(1);
      });
    });

    it('dispatches multiple spawn tasks via queueMicrotask', async () => {
      const spawnSession = vi.fn().mockResolvedValue('spawned-client');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      store.create({
        title: 'Spawn task 1',
        parentId: goal.id,
        sessionPolicy: 'spawn',
      });
      store.create({
        title: 'Spawn task 2',
        parentId: goal.id,
        sessionPolicy: 'spawn',
      });

      orch.start(goal.id);

      await vi.waitFor(() => {
        expect(spawnSession).toHaveBeenCalledTimes(2);
      });
    });

    it('auto policy (store default) spawns instead of reusing', async () => {
      const spawnSession = vi.fn().mockResolvedValue('spawned-client-1');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      // No explicit sessionPolicy — store defaults to 'auto'
      const task = store.create({ title: 'Auto task', parentId: goal.id });

      orch.start(goal.id);
      await vi.waitFor(() => expect(spawnSession).toHaveBeenCalled());

      expect(spawnSession).toHaveBeenCalledWith(task.id, expect.any(String), goal.id);
      expect(store.get(task.id)?.status).toBe('active');
      expect(deps.setTaskContext).not.toHaveBeenCalled();
    });

    it('respects spawn depth limit of 5', async () => {
      const spawnSession = vi.fn().mockResolvedValue('spawned-client');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      // Create 10 spawn tasks — only 5 should fire per tick chain
      for (let i = 0; i < 10; i++) {
        store.create({
          title: `Spawn task ${i}`,
          parentId: goal.id,
          sessionPolicy: 'spawn',
        });
      }

      orch.start(goal.id);

      await vi.waitFor(() => {
        expect(spawnSession).toHaveBeenCalledTimes(5);
      });

      // Should NOT have spawned more than 5
      expect(spawnSession).toHaveBeenCalledTimes(5);
    });

    it('orphan detection skips recently-spawned tasks (grace period)', async () => {
      const spawnSession = vi.fn().mockResolvedValue('spawned-client-1');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      // Return empty active set — everything looks orphaned
      deps.getActiveSessionIds = () => new Set();
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      const task = store.create({
        title: 'Spawn task',
        parentId: goal.id,
        sessionPolicy: 'spawn',
      });

      orch.start(goal.id);

      await vi.waitFor(() => {
        expect(spawnSession).toHaveBeenCalledTimes(1);
      });

      // Manually trigger tick — orphan detection should skip this task
      // because it was spawned within the grace period
      orch.onTaskCompleted(task.id);

      // Should still only be 1 spawn call — the task wasn't reclaimed
      expect(spawnSession).toHaveBeenCalledTimes(1);
      // Task should still be active, not reset to pending
      expect(store.get(task.id)!.status).toBe('active');
    });

    it('rate limits spawns across tick chains', async () => {
      const spawnSession = vi.fn().mockResolvedValue('spawned-client');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      for (let i = 0; i < 10; i++) {
        store.create({
          title: `Task ${i}`,
          parentId: goal.id,
          sessionPolicy: 'spawn',
        });
      }

      orch.start(goal.id);

      // Wait for first tick chain to complete
      await vi.waitFor(() => {
        expect(spawnSession).toHaveBeenCalledTimes(5);
      });

      // Trigger another tick chain — rate limit should still block
      orch.onTaskCompleted('nonexistent');

      // Still only 5 — rate limit window hasn't expired
      expect(spawnSession).toHaveBeenCalledTimes(5);
    });

    it('reuse policy tasks use pinned session as before', () => {
      const spawnSession = vi.fn().mockResolvedValue('spawned-client-1');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      const task = store.create({
        title: 'Reuse task',
        parentId: goal.id,
        sessionPolicy: 'reuse',
      });

      orch.start(goal.id);

      expect(spawnSession).not.toHaveBeenCalled();
      expect(orch.getStatus().activeTaskId).toBe(task.id);
      expect(deps.setTaskContext).toHaveBeenCalledWith(task.id, goal.id);
    });
  });

  describe('spawn kill switch', () => {
    it('defaults to spawnEnabled=false', () => {
      expect(orchestrator.spawnEnabled).toBe(false);
      expect(orchestrator.getStatus().spawnEnabled).toBe(false);
    });

    it('setSpawnEnabled toggles the flag and broadcasts', () => {
      orchestrator.setSpawnEnabled(true);
      expect(orchestrator.spawnEnabled).toBe(true);
      expect(broadcastedStatuses.at(-1)?.spawnEnabled).toBe(true);

      orchestrator.setSpawnEnabled(false);
      expect(orchestrator.spawnEnabled).toBe(false);
      expect(broadcastedStatuses.at(-1)?.spawnEnabled).toBe(false);
    });

    it('forces reuse policy when spawning is disabled', () => {
      const spawnSession = vi.fn().mockResolvedValue('headless:test');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      const orch = new TaskOrchestrator(deps);

      // spawnEnabled defaults to false — spawn should NOT be called
      const goal = store.create({ title: 'Goal' });
      store.create({ title: 'Task', parentId: goal.id });

      orch.start(goal.id);

      expect(spawnSession).not.toHaveBeenCalled();
      // Task should be assigned to pinned session (reuse path)
      expect(orch.getStatus().activeTaskId).not.toBeNull();
      expect(deps.setTaskContext).toHaveBeenCalled();
    });

    it('allows spawning when enabled', async () => {
      const spawnSession = vi.fn().mockResolvedValue('headless:enabled');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      const orch = new TaskOrchestrator(deps);

      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      store.create({ title: 'Task', parentId: goal.id });

      orch.start(goal.id);

      // Spawn should be called when enabled
      await vi.waitFor(() => {
        expect(spawnSession).toHaveBeenCalled();
      });
    });

    it('can be toggled while loop is running', () => {
      const spawnSession = vi.fn().mockResolvedValue('headless:toggle');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      const orch = new TaskOrchestrator(deps);

      // Start with spawning disabled — task uses reuse path
      const goal = store.create({ title: 'Goal' });
      store.create({ title: 'Task 1', parentId: goal.id });
      store.create({ title: 'Task 2', parentId: goal.id });

      orch.start(goal.id);

      // With spawn disabled, task 1 should use pinned session (reuse)
      expect(spawnSession).not.toHaveBeenCalled();
      const task1Id = orch.getStatus().activeTaskId;
      expect(task1Id).not.toBeNull();

      // Enable spawning mid-loop, complete task 1
      orch.setSpawnEnabled(true);
      store.update(task1Id!, { status: 'done' });
      store.cascadeStatus(task1Id!);
      orch.onTaskCompleted(task1Id!);

      // Task 2 should now spawn (enabled)
      expect(spawnSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('spawn state cleanup', () => {
    it('stop() clears spawn tracking state', async () => {
      const spawnSession = vi.fn().mockResolvedValue('spawned-client-1');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      deps.getActiveSessionIds = vi.fn().mockReturnValue(new Set(['headless:spawned-client-1']));
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      store.create({ title: 'Task 1', parentId: goal.id, sessionPolicy: 'spawn' });
      orch.start(goal.id);

      // Wait for spawn
      await vi.waitFor(() => {
        expect(spawnSession).toHaveBeenCalledTimes(1);
      });

      // Stop should clear all spawn tracking
      orch.stop();

      // Start a new goal — should not be affected by previous spawn state
      spawnSession.mockClear();
      const goal2 = store.create({ title: 'Goal 2' });
      store.create({ title: 'Task 2', parentId: goal2.id, sessionPolicy: 'spawn' });
      orch.start(goal2.id);

      // Task 2 should spawn without rate-limit interference from goal 1
      await vi.waitFor(() => {
        expect(spawnSession).toHaveBeenCalledTimes(1);
      });
    });

    it('start() clears spawn tracking from previous paused goal', async () => {
      const spawnSession = vi.fn().mockResolvedValue('spawned-client-1');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      deps.getActiveSessionIds = vi.fn().mockReturnValue(new Set(['headless:spawned-client-1']));
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      store.create({ title: 'Task 1', parentId: goal.id, sessionPolicy: 'spawn' });
      orch.start(goal.id);

      await vi.waitFor(() => {
        expect(spawnSession).toHaveBeenCalledTimes(1);
      });

      // Pause, then start a new goal without stopping
      orch.pause();
      spawnSession.mockClear();

      const goal2 = store.create({ title: 'Goal 2' });
      store.create({ title: 'Task 2', parentId: goal2.id, sessionPolicy: 'spawn' });
      orch.start(goal2.id);

      // Should spawn cleanly — no stale rate-limit data from goal 1
      await vi.waitFor(() => {
        expect(spawnSession).toHaveBeenCalledTimes(1);
      });
    });

    it('disabling spawn mid-loop stops new spawns but keeps in-flight tasks', async () => {
      const spawnSession = vi.fn().mockResolvedValue('spawned-client-1');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      deps.getActiveSessionIds = vi.fn().mockReturnValue(new Set(['headless:spawned-client-1']));
      const orch = new TaskOrchestrator(deps);
      orch.setSpawnEnabled(true);

      const goal = store.create({ title: 'Goal' });
      const task1 = store.create({ title: 'Task 1', parentId: goal.id, sessionPolicy: 'spawn' });

      orch.start(goal.id);

      // Task 1 spawns
      await vi.waitFor(() => {
        expect(spawnSession).toHaveBeenCalledTimes(1);
      });

      // Disable spawning while task 1 is in-flight, then add task 2
      orch.setSpawnEnabled(false);
      store.create({ title: 'Task 2', parentId: goal.id, sessionPolicy: 'spawn' });

      // Complete task 1 — task 2 should use reuse path, not spawn
      store.update(task1.id, { status: 'done' });
      store.cascadeStatus(task1.id);
      orch.onTaskCompleted(task1.id);

      // No additional spawn — task 2 falls back to reuse policy
      expect(spawnSession).toHaveBeenCalledTimes(1);
    });
  });
});
