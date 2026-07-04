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
      // getActiveSessionIds returns clientIds (not SDK sessionIds)
      // to match what setSessionId stores on tasks
      const depsWithOrphan = createTestDeps(store);
      depsWithOrphan.getActiveSessionIds = () => new Set(['alive-client']);
      const orch = new TaskOrchestrator(depsWithOrphan);

      const goal = store.create({ title: 'Goal' });
      const c1 = store.create({ title: 'Orphan', parentId: goal.id });
      store.create({ title: 'Next', parentId: goal.id });

      // Simulate c1 assigned to dead session (clientId not in active set)
      store.update(c1.id, { status: 'active' });
      store.setSessionId(c1.id, 'dead-client');

      orch.start(goal.id);

      // c1 should have been reclaimed to pending, then re-assigned
      // The tick should have picked c1 (first pending) since it was reclaimed
      expect(store.get(c1.id)!.status).toBe('active');
      expect(orch.getStatus().activeTaskId).toBe(c1.id);
    });

    it('does not reclaim tasks with alive sessions', () => {
      const depsWithOrphan = createTestDeps(store);
      depsWithOrphan.getActiveSessionIds = () => new Set(['alive-client']);
      const orch = new TaskOrchestrator(depsWithOrphan);

      const goal = store.create({ title: 'Goal' });
      const c1 = store.create({ title: 'Active', parentId: goal.id });
      const c2 = store.create({ title: 'Next', parentId: goal.id });

      store.update(c1.id, { status: 'active' });
      store.setSessionId(c1.id, 'alive-client');

      orch.start(goal.id);

      // c1 is alive, so tick should skip it and pick c2
      expect(orch.getStatus().activeTaskId).toBe(c2.id);
    });

    it('reclaims spawned task sessions using clientId matching', () => {
      // Simulates the real scenario: task.session_id stores clientId
      // (e.g. 'task:abc123'), active set contains clientIds from registry
      const depsWithOrphan = createTestDeps(store);
      depsWithOrphan.getActiveSessionIds = () => new Set(['task:alive-wt']);
      const orch = new TaskOrchestrator(depsWithOrphan);

      const goal = store.create({ title: 'Goal' });
      const orphan = store.create({ title: 'Dead spawn', parentId: goal.id });
      const alive = store.create({ title: 'Alive spawn', parentId: goal.id });
      store.create({ title: 'Pending', parentId: goal.id });

      // Orphan: session ended, clientId no longer in registry
      store.update(orphan.id, { status: 'active' });
      store.setSessionId(orphan.id, 'task:dead-wt');

      // Alive: session still running
      store.update(alive.id, { status: 'active' });
      store.setSessionId(alive.id, 'task:alive-wt');

      orch.start(goal.id);

      // Orphan should be reclaimed and re-dispatched
      expect(store.get(orphan.id)!.sessionId).toBeNull();
      // Alive should NOT be reclaimed
      expect(store.get(alive.id)!.sessionId).toBe('task:alive-wt');
      expect(store.get(alive.id)!.status).toBe('active');
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

      const goal = store.create({ title: 'Goal' });
      // No explicit sessionPolicy — store defaults to 'auto'
      const task = store.create({ title: 'Auto task', parentId: goal.id });

      orch.start(goal.id);
      await vi.waitFor(() => expect(spawnSession).toHaveBeenCalled());

      expect(spawnSession).toHaveBeenCalledWith(task.id, expect.any(String), goal.id);
      expect(store.get(task.id)?.status).toBe('active');
      expect(deps.setTaskContext).not.toHaveBeenCalled();
    });

    it('does not call setTaskContext (pinned) for spawned sessions', async () => {
      const spawnSession = vi.fn().mockResolvedValue('spawned-client-1');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      const orch = new TaskOrchestrator(deps);

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

      // Spawned sessions get taskContext via startChat options, not setTaskContext
      expect(deps.setTaskContext).not.toHaveBeenCalled();
    });

    it('falls back to setTaskContext (pinned) when spawn returns null', async () => {
      const spawnSession = vi.fn().mockResolvedValue(null);
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      const orch = new TaskOrchestrator(deps);

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
    });

    it('tick after spawn session completes advances workflow', async () => {
      const spawnSession = vi.fn().mockResolvedValue('task:spawned-1');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      let activeClients = new Set(['task:spawned-1']);
      deps.getActiveSessionIds = () => activeClients;
      const orch = new TaskOrchestrator(deps);

      const goal = store.create({ title: 'Goal' });
      const t1 = store.create({ title: 'Spawn task', parentId: goal.id });
      const t2 = store.create({ title: 'Next task', parentId: goal.id, sessionPolicy: 'reuse' });

      orch.start(goal.id);

      await vi.waitFor(() => {
        expect(spawnSession).toHaveBeenCalled();
      });

      // Agent completed the task during the session
      store.update(t1.id, { status: 'done' });
      store.cascadeStatus(t1.id);

      // .finally() fires: session removed from registry, tick() called directly
      activeClients = new Set();
      orch.tick();

      // t2 should now be active (workflow advanced)
      expect(store.get(t2.id)!.status).toBe('active');
      expect(orch.getStatus().activeTaskId).toBe(t2.id);
    });

    it('resume after spawn session dies reclaims unfinished task', async () => {
      // Primary scenario for .finally(): session crashes without calling
      // TaskComplete. The task stays active but the session is gone.
      // After all tasks are spawned, the orchestrator pauses (no pending left).
      // .finally() calls resume() → tick() → orphan reclaim → re-dispatch.
      const spawnSession = vi.fn().mockResolvedValue('task:spawned-1');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      let activeClients = new Set(['task:spawned-1']);
      deps.getActiveSessionIds = () => activeClients;
      const orch = new TaskOrchestrator(deps);

      const goal = store.create({ title: 'Goal' });
      store.create({ title: 'Spawn task', parentId: goal.id });

      orch.start(goal.id);

      await vi.waitFor(() => {
        expect(spawnSession).toHaveBeenCalledTimes(1);
      });

      // Orchestrator should be paused (all tasks active, none pending)
      expect(orch.getStatus().state).toBe('paused');

      // .finally() fires: session removed from registry, resume() called
      activeClients = new Set();
      orch.resume();

      // Orphan reclaim detected the dead session and re-dispatched the task
      await vi.waitFor(() => {
        expect(spawnSession).toHaveBeenCalledTimes(2);
      });
    });

    it('tick is a no-op when orchestrator is stopped before session ends', async () => {
      // Edge case: orchestrator stopped (idle) while a spawned session is
      // still in-flight. .finally() fires → tick() → returns early (guarded
      // by state !== 'running'). No crash, no side effects.
      const spawnSession = vi.fn().mockResolvedValue('task:spawned-1');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      // Return spawned clientId while session is alive
      let activeClients = new Set(['task:spawned-1']);
      deps.getActiveSessionIds = () => activeClients;
      const orch = new TaskOrchestrator(deps);

      const goal = store.create({ title: 'Goal' });
      const t1 = store.create({ title: 'Spawn task', parentId: goal.id });

      orch.start(goal.id);

      await vi.waitFor(() => {
        expect(spawnSession).toHaveBeenCalledTimes(1);
      });

      // User stops the orchestrator while session is still running
      orch.stop();
      expect(orch.getStatus().state).toBe('idle');

      // .finally() fires after session ends — tick is a no-op in idle state
      activeClients = new Set();
      orch.tick();

      expect(orch.getStatus().state).toBe('idle');
      expect(store.get(t1.id)?.status).toBe('active'); // unchanged
      expect(spawnSession).toHaveBeenCalledTimes(1); // no re-dispatch
    });

    it('reuse policy tasks use pinned session as before', () => {
      const spawnSession = vi.fn().mockResolvedValue('spawned-client-1');
      const deps = createTestDeps(store);
      deps.spawnSession = spawnSession;
      const orch = new TaskOrchestrator(deps);

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
});
