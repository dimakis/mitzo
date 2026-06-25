import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { TaskStore } from '../task-store.js';
import { SignalProcessor } from '../signal-processor.js';

const TEST_DIR = join(tmpdir(), `mitzo-signal-test-${process.pid}`);

let store: TaskStore;
let processor: SignalProcessor;
let onResolved: ReturnType<typeof vi.fn<(taskId: string) => void>>;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  store = new TaskStore(join(TEST_DIR, `tasks-${Date.now()}.db`));
  onResolved = vi.fn<(taskId: string) => void>();
  processor = new SignalProcessor(store, onResolved);
});

afterEach(() => {
  processor.unwatchAll();
  store.close();
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('SignalProcessor', () => {
  it('watches and resolves a signal manually', () => {
    const goal = store.create({ title: 'Goal' });
    const task = store.create({
      title: 'Wait for CI',
      parentId: goal.id,
      stageType: 'wait_for_signal',
      gateConfig: { type: 'gh_ci', repo: 'org/repo', pr: 1 },
    });
    store.update(task.id, { status: 'active' });

    processor.watch(task.id, task.gateConfig!);
    expect(processor.isWatching(task.id)).toBe(true);

    processor.resolveSignal(task.id, { status: 'pass', artifacts: { ci: 'green' } });

    const updated = store.get(task.id);
    expect(updated!.status).toBe('done');
    expect(updated!.artifacts).toEqual({ ci: 'green' });
    expect(onResolved).toHaveBeenCalledWith(task.id);
    expect(processor.isWatching(task.id)).toBe(false);
  });

  it('resolves a signal with failure and no retries → failed', () => {
    const goal = store.create({ title: 'Goal' });
    const task = store.create({
      title: 'CI check',
      parentId: goal.id,
      stageType: 'wait_for_signal',
      gateConfig: { type: 'gh_ci', repo: 'org/repo', pr: 1 },
      maxRetries: 0,
    });
    store.update(task.id, { status: 'active' });

    processor.watch(task.id, task.gateConfig!);
    processor.resolveSignal(task.id, { status: 'fail' });

    const updated = store.get(task.id);
    expect(updated!.status).toBe('failed');
    expect(onResolved).toHaveBeenCalledWith(task.id);
  });

  it('retries when max_retries > retry_count and resets preceding sibling', () => {
    const goal = store.create({ title: 'Goal' });
    const agentTask = store.create({
      title: 'Fix code',
      parentId: goal.id,
      stageType: 'agent_work',
      priority: 2,
    });
    store.update(agentTask.id, { status: 'done', summary: 'Fixed things' });

    const signalTask = store.create({
      title: 'Wait for CI',
      parentId: goal.id,
      stageType: 'wait_for_signal',
      gateConfig: { type: 'gh_ci', repo: 'org/repo', pr: 1 },
      maxRetries: 3,
      priority: 1,
    });
    store.update(signalTask.id, { status: 'active' });

    processor.watch(signalTask.id, signalTask.gateConfig!);
    processor.resolveSignal(signalTask.id, {
      status: 'fail',
      artifacts: { error: 'tests failed' },
    });

    const updatedSignal = store.get(signalTask.id);
    expect(updatedSignal!.status).toBe('pending');
    expect(updatedSignal!.retryCount).toBe(1);

    // Preceding agent_work sibling should be reset to pending
    const updatedAgent = store.get(agentTask.id);
    expect(updatedAgent!.status).toBe('pending');

    expect(onResolved).toHaveBeenCalledWith(signalTask.id);
  });

  it('fails after exhausting retries', () => {
    const goal = store.create({ title: 'Goal' });
    const task = store.create({
      title: 'CI check',
      parentId: goal.id,
      stageType: 'wait_for_signal',
      gateConfig: { type: 'gh_ci', repo: 'org/repo', pr: 1 },
      maxRetries: 2,
    });
    // Simulate already retried twice
    store.update(task.id, { status: 'active', retryCount: 2 });

    processor.watch(task.id, task.gateConfig!);
    processor.resolveSignal(task.id, { status: 'fail' });

    const updated = store.get(task.id);
    expect(updated!.status).toBe('failed');
  });

  it('unwatches a signal', () => {
    const goal = store.create({ title: 'Goal' });
    const task = store.create({
      title: 'Wait',
      parentId: goal.id,
      stageType: 'wait_for_signal',
      gateConfig: { type: 'human_approval' },
    });
    store.update(task.id, { status: 'active' });

    processor.watch(task.id, task.gateConfig!);
    expect(processor.isWatching(task.id)).toBe(true);

    processor.unwatch(task.id);
    expect(processor.isWatching(task.id)).toBe(false);
  });

  it('unwatchAll clears everything', () => {
    const goal = store.create({ title: 'Goal' });
    const t1 = store.create({
      title: 'W1',
      parentId: goal.id,
      stageType: 'wait_for_signal',
      gateConfig: { type: 'human_approval' },
    });
    const t2 = store.create({
      title: 'W2',
      parentId: goal.id,
      stageType: 'wait_for_signal',
      gateConfig: { type: 'human_approval' },
    });
    store.update(t1.id, { status: 'active' });
    store.update(t2.id, { status: 'active' });

    processor.watch(t1.id, t1.gateConfig!);
    processor.watch(t2.id, t2.gateConfig!);
    expect(processor.isWatching(t1.id)).toBe(true);
    expect(processor.isWatching(t2.id)).toBe(true);

    processor.unwatchAll();
    expect(processor.isWatching(t1.id)).toBe(false);
    expect(processor.isWatching(t2.id)).toBe(false);
  });

  describe('findActiveSignalTasks', () => {
    it('finds active wait_for_signal tasks by gate type', () => {
      const goal = store.create({ title: 'Goal' });
      const t1 = store.create({
        title: 'Centaur review',
        parentId: goal.id,
        stageType: 'wait_for_signal',
        gateConfig: { type: 'centaur_review', repo: 'dimakis/mitzo', pr: 360 },
      });
      store.update(t1.id, { status: 'active' });

      const t2 = store.create({
        title: 'CI check',
        parentId: goal.id,
        stageType: 'wait_for_signal',
        gateConfig: { type: 'gh_ci', repo: 'dimakis/mitzo', pr: 360 },
      });
      store.update(t2.id, { status: 'active' });

      const centaurTasks = store.findActiveSignalTasks('centaur_review');
      expect(centaurTasks).toHaveLength(1);
      expect(centaurTasks[0].id).toBe(t1.id);

      const ciTasks = store.findActiveSignalTasks('gh_ci');
      expect(ciTasks).toHaveLength(1);
      expect(ciTasks[0].id).toBe(t2.id);
    });

    it('ignores non-active or non-signal tasks', () => {
      const goal = store.create({ title: 'Goal' });
      store.create({
        title: 'Pending signal',
        parentId: goal.id,
        stageType: 'wait_for_signal',
        gateConfig: { type: 'centaur_review', repo: 'dimakis/mitzo', pr: 1 },
      });

      const t2 = store.create({
        title: 'Agent task',
        parentId: goal.id,
        stageType: 'agent_work',
      });
      store.update(t2.id, { status: 'active' });

      const results = store.findActiveSignalTasks('centaur_review');
      expect(results).toHaveLength(0);
    });

    it('finds human_approval tasks', () => {
      const goal = store.create({ title: 'Goal' });
      const t1 = store.create({
        title: 'Human approval gate',
        parentId: goal.id,
        stageType: 'wait_for_signal',
        gateConfig: { type: 'human_approval' },
      });
      store.update(t1.id, { status: 'active' });

      const results = store.findActiveSignalTasks('human_approval');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(t1.id);
    });

    it('does not cross-match gate types', () => {
      const goal = store.create({ title: 'Goal' });
      store.create({
        title: 'CI gate',
        parentId: goal.id,
        stageType: 'wait_for_signal',
        gateConfig: { type: 'gh_ci', repo: 'org/repo', pr: 1 },
      });

      const results = store.findActiveSignalTasks('human_approval');
      expect(results).toHaveLength(0);
    });
  });

  describe('gate matching (mirrors /api/signals/resolve logic)', () => {
    it('centaur_review matches by pr_url', () => {
      const goal = store.create({ title: 'Goal' });
      const t1 = store.create({
        title: 'Centaur review',
        parentId: goal.id,
        stageType: 'wait_for_signal',
        gateConfig: {
          type: 'centaur_review',
          pr_url: 'https://github.com/dimakis/mitzo/pull/360',
        },
      });
      store.update(t1.id, { status: 'active' });

      const candidates = store.findActiveSignalTasks('centaur_review');
      expect(candidates).toHaveLength(1);

      // Simulate the matching logic from the endpoint
      const gc = candidates[0].gateConfig as Record<string, unknown>;
      const incomingPrUrl = 'https://github.com/dimakis/mitzo/pull/360';
      expect(gc.pr_url).toBe(incomingPrUrl);
    });

    it('centaur_review matches by repo + pr number', () => {
      const goal = store.create({ title: 'Goal' });
      const t1 = store.create({
        title: 'Centaur review',
        parentId: goal.id,
        stageType: 'wait_for_signal',
        gateConfig: { type: 'centaur_review', repo: 'dimakis/mitzo', pr: 360 },
      });
      store.update(t1.id, { status: 'active' });

      const candidates = store.findActiveSignalTasks('centaur_review');
      const gc = candidates[0].gateConfig as Record<string, unknown>;
      expect(gc.repo).toBe('dimakis/mitzo');
      expect(gc.pr).toBe(360);
    });

    it('gh_ci matches by repo + pr', () => {
      const goal = store.create({ title: 'Goal' });
      const t1 = store.create({
        title: 'CI check',
        parentId: goal.id,
        stageType: 'wait_for_signal',
        gateConfig: { type: 'gh_ci', repo: 'dimakis/mitzo', pr: 377 },
      });
      store.update(t1.id, { status: 'active' });

      const candidates = store.findActiveSignalTasks('gh_ci');
      expect(candidates).toHaveLength(1);
      const gc = candidates[0].gateConfig as Record<string, unknown>;
      expect(gc.repo).toBe('dimakis/mitzo');
      expect(gc.pr).toBe(377);
    });

    it('human_approval matches any active task of that type', () => {
      const goal = store.create({ title: 'Goal' });
      const t1 = store.create({
        title: 'Approval gate',
        parentId: goal.id,
        stageType: 'wait_for_signal',
        gateConfig: { type: 'human_approval' },
      });
      store.update(t1.id, { status: 'active' });

      const candidates = store.findActiveSignalTasks('human_approval');
      expect(candidates).toHaveLength(1);
      // human_approval: isMatch = true for any candidate (no repo/pr filtering)
    });

    it('does not match across gate types', () => {
      const goal = store.create({ title: 'Goal' });
      const t1 = store.create({
        title: 'CI check',
        parentId: goal.id,
        stageType: 'wait_for_signal',
        gateConfig: { type: 'gh_ci', repo: 'org/repo', pr: 1 },
      });
      store.update(t1.id, { status: 'active' });

      expect(store.findActiveSignalTasks('centaur_review')).toHaveLength(0);
      expect(store.findActiveSignalTasks('human_approval')).toHaveLength(0);
    });

    it('matches multiple tasks of same gate type', () => {
      const goal = store.create({ title: 'Goal' });
      const t1 = store.create({
        title: 'Review 1',
        parentId: goal.id,
        stageType: 'wait_for_signal',
        gateConfig: { type: 'centaur_review', repo: 'dimakis/mitzo', pr: 360 },
      });
      const t2 = store.create({
        title: 'Review 2',
        parentId: goal.id,
        stageType: 'wait_for_signal',
        gateConfig: { type: 'centaur_review', repo: 'dimakis/mitzo', pr: 361 },
      });
      store.update(t1.id, { status: 'active' });
      store.update(t2.id, { status: 'active' });

      const candidates = store.findActiveSignalTasks('centaur_review');
      expect(candidates).toHaveLength(2);
    });

    it('resolves matching task via processor', () => {
      const goal = store.create({ title: 'Goal' });
      const t1 = store.create({
        title: 'CI gate',
        parentId: goal.id,
        stageType: 'wait_for_signal',
        gateConfig: { type: 'gh_ci', repo: 'dimakis/mitzo', pr: 377 },
      });
      store.update(t1.id, { status: 'active' });
      processor.watch(t1.id, t1.gateConfig!);

      // Simulate what the endpoint does: find + match + resolve
      const candidates = store.findActiveSignalTasks('gh_ci');
      for (const task of candidates) {
        const gc = task.gateConfig as Record<string, unknown>;
        if (gc.repo === 'dimakis/mitzo' && gc.pr === 377) {
          processor.resolveSignal(task.id, { status: 'pass', artifacts: { ci: 'green' } });
        }
      }

      const updated = store.get(t1.id);
      expect(updated!.status).toBe('done');
      expect(updated!.artifacts).toEqual({ ci: 'green' });
      expect(onResolved).toHaveBeenCalledWith(t1.id);
    });
  });

  describe('centaur callback registration', () => {
    it('registers callback with Centaur on watch for centaur_review', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const goal = store.create({ title: 'Goal' });
      const task = store.create({
        title: 'Wait for Centaur review',
        parentId: goal.id,
        stageType: 'wait_for_signal',
        gateConfig: { type: 'centaur_review', pr_url: 'https://github.com/org/repo/pull/1' },
      });
      store.update(task.id, { status: 'active' });

      processor.watch(task.id, task.gateConfig!);

      // Allow async registration to complete
      await vi.waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          'http://localhost:8642/api/signals/register',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining(task.id),
          }),
        );
      });

      fetchSpy.mockRestore();
    });

    it('deregisters callback on unwatch for centaur_review', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const goal = store.create({ title: 'Goal' });
      const task = store.create({
        title: 'Wait for Centaur review',
        parentId: goal.id,
        stageType: 'wait_for_signal',
        gateConfig: { type: 'centaur_review', pr_url: 'https://github.com/org/repo/pull/1' },
      });
      store.update(task.id, { status: 'active' });

      processor.watch(task.id, task.gateConfig!);
      processor.unwatch(task.id);

      await vi.waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          `http://localhost:8642/api/signals/${task.id}`,
          expect.objectContaining({ method: 'DELETE' }),
        );
      });

      fetchSpy.mockRestore();
    });

    it('does not register callback for non-centaur gate types', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const goal = store.create({ title: 'Goal' });
      const task = store.create({
        title: 'Wait for CI',
        parentId: goal.id,
        stageType: 'wait_for_signal',
        gateConfig: { type: 'gh_ci', repo: 'org/repo', pr: 1 },
      });
      store.update(task.id, { status: 'active' });

      processor.watch(task.id, task.gateConfig!);

      // fetch should not have been called for registration (only polling uses execFile, not fetch)
      const registerCalls = fetchSpy.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('/api/signals/'),
      );
      expect(registerCalls).toHaveLength(0);

      fetchSpy.mockRestore();
    });

    it('handles Centaur being unavailable gracefully', () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

      const goal = store.create({ title: 'Goal' });
      const task = store.create({
        title: 'Wait for Centaur review',
        parentId: goal.id,
        stageType: 'wait_for_signal',
        gateConfig: { type: 'centaur_review', pr_url: 'https://github.com/org/repo/pull/1' },
      });
      store.update(task.id, { status: 'active' });

      // Should not throw — fire-and-forget registration
      expect(() => processor.watch(task.id, task.gateConfig!)).not.toThrow();
      // Polling interval should still be set
      expect(processor.isWatching(task.id)).toBe(true);

      vi.restoreAllMocks();
    });
  });

  it('stores failure artifacts in annotations on retry', () => {
    const goal = store.create({ title: 'Goal' });
    const agent = store.create({
      title: 'Agent work',
      parentId: goal.id,
      stageType: 'agent_work',
      priority: 2,
    });
    store.update(agent.id, { status: 'done', summary: 'Done' });

    const signal = store.create({
      title: 'CI',
      parentId: goal.id,
      stageType: 'wait_for_signal',
      gateConfig: { type: 'gh_ci', repo: 'org/repo', pr: 1 },
      maxRetries: 3,
      priority: 1,
    });
    store.update(signal.id, { status: 'active' });

    processor.watch(signal.id, signal.gateConfig!);
    processor.resolveSignal(signal.id, {
      status: 'fail',
      artifacts: { failed_checks: ['lint', 'test'] },
    });

    const updated = store.get(signal.id);
    expect(updated!.annotations).toHaveLength(1);
    expect(updated!.annotations[0]).toContain('retry_0');
    expect(updated!.annotations[0]).toContain('lint');
  });
});
