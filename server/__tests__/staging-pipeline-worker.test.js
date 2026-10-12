import { expect, it, vi } from 'vitest';
import { runStagingPipelineRequest } from '../../scripts/lib/staging-pipeline-worker.mjs';

const request = {
  id: 'r',
  taskId: 's',
  pr: 1,
  acceptedCommit: 'a'.repeat(40),
  suite: 'http-readiness',
};
const token = { requestId: 'r', epoch: 1, owner: 'worker', nonce: 'n' };
function fixture() {
  const events = [];
  const store = Object.fromEntries(
    ['claim', 'defer', 'markDispatched', 'finish', 'quarantine', 'bindBaseline'].map((n) => [
      n,
      vi.fn(() => {
        events.push(n);
        return n === 'claim' ? { granted: true, request, token } : undefined;
      }),
    ]),
  );
  const effects = {
    resources: vi.fn(async () => ({ admitted: true })),
    baseline: vi.fn(async () => request.acceptedCommit),
    check: vi.fn(async () => ({ safe: true, expected: request.acceptedCommit })),
    prepare: vi.fn(async () => {
      events.push('prepare');
    }),
    plan: vi.fn(async () => {
      events.push('plan');
    }),
    deploy: vi.fn(async () => {
      events.push('deploy');
    }),
    test: vi.fn(async () => {
      events.push('test');
      return { outcome: 'passed', cleanupConfirmed: true };
    }),
  };
  return { store, effects, events };
}
it('holds one reservation across prepare, plan, apply, test and final source verification', async () => {
  const f = fixture();
  f.effects.check.mockResolvedValueOnce({ safe: true, expected: 'b'.repeat(40) });
  await runStagingPipelineRequest(f.store, f.effects, 'worker');
  expect(f.events).toEqual([
    'claim',
    'bindBaseline',
    'prepare',
    'plan',
    'markDispatched',
    'deploy',
    'test',
    'finish',
  ]);
  expect(f.store.finish).toHaveBeenCalledWith(token, {
    outcome: 'passed',
    sourceCommit: request.acceptedCommit,
    cleanupConfirmed: true,
  });
  expect(f.effects.check).toHaveBeenCalledTimes(3);
});
it('resource pressure leaves work queued without deploying or starting a test', async () => {
  const f = fixture();
  f.effects.resources.mockResolvedValue({ admitted: false, reasons: ['host-memory-pressure'] });
  await runStagingPipelineRequest(f.store, f.effects, 'worker');
  expect(f.store.defer).toHaveBeenCalledWith(token, 'host-resources');
  expect(f.effects.prepare).not.toHaveBeenCalled();
  expect(f.effects.test).not.toHaveBeenCalled();
});
it('unavailable staging releases only the undispatched queue reservation', async () => {
  const f = fixture();
  f.effects.check.mockRejectedValue(Error('custody uncertain'));
  await runStagingPipelineRequest(f.store, f.effects, 'worker');
  expect(f.store.defer).toHaveBeenCalledWith(token, 'stage-unavailable');
  expect(f.store.markDispatched).not.toHaveBeenCalled();
});
it('uncertain deployment fences later work instead of retrying or rolling back', async () => {
  const f = fixture();
  f.effects.check.mockResolvedValueOnce({ safe: true, expected: 'b'.repeat(40) });
  f.effects.deploy.mockRejectedValue(Error('drain uncertain'));
  await runStagingPipelineRequest(f.store, f.effects, 'worker');
  expect(f.store.quarantine).toHaveBeenCalledWith(token, 'deployment-uncertain');
  expect(f.effects.deploy).toHaveBeenCalledTimes(1);
  expect(f.effects.test).not.toHaveBeenCalled();
});
it('staging drift or uncertain test cleanup cannot become a passing receipt', async () => {
  for (const mode of ['drift', 'cleanup']) {
    const f = fixture();
    if (mode === 'drift')
      f.effects.check
        .mockResolvedValueOnce({ safe: true, expected: request.acceptedCommit })
        .mockResolvedValueOnce({ safe: true, expected: request.acceptedCommit })
        .mockResolvedValueOnce({ safe: true, expected: 'b'.repeat(40) });
    else f.effects.test.mockResolvedValue({ outcome: 'passed', cleanupConfirmed: false });
    await runStagingPipelineRequest(f.store, f.effects, 'worker');
    expect(f.store.finish).not.toHaveBeenCalled();
    expect(f.store.quarantine).toHaveBeenCalled();
  }
});
it('a normal test failure with confirmed cleanup releases staging', async () => {
  const f = fixture();
  f.effects.test.mockResolvedValue({ outcome: 'failed', cleanupConfirmed: true });
  await runStagingPipelineRequest(f.store, f.effects, 'worker');
  expect(f.store.finish).toHaveBeenCalledWith(token, {
    outcome: 'failed',
    sourceCommit: request.acceptedCommit,
    cleanupConfirmed: true,
  });
});
it('rechecks resource pressure after preparation before applying a deployment', async () => {
  const f = fixture();
  f.effects.check.mockResolvedValueOnce({ safe: true, expected: 'b'.repeat(40) });
  f.effects.resources
    .mockResolvedValueOnce({ admitted: true })
    .mockResolvedValueOnce({ admitted: false });
  await runStagingPipelineRequest(f.store, f.effects, 'worker');
  expect(f.effects.deploy).not.toHaveBeenCalled();
  expect(f.store.defer).toHaveBeenCalledWith(token, 'host-resources');
});
it('a later accepted baseline binds results to the actual tested source', async () => {
  const f = fixture();
  const source = 'c'.repeat(40);
  f.effects.baseline.mockResolvedValue(source);
  f.effects.check.mockResolvedValue({ safe: true, expected: source });
  await runStagingPipelineRequest(f.store, f.effects, 'worker');
  expect(f.store.bindBaseline).toHaveBeenCalledWith(token, source);
  expect(f.store.finish).toHaveBeenCalledWith(token, {
    outcome: 'passed',
    sourceCommit: source,
    cleanupConfirmed: true,
  });
});
it('confirmed deployment plus host pressure waits without creating a custody incident', async () => {
  const f = fixture();
  f.store.settleDeployment = vi.fn();
  f.effects.check.mockResolvedValueOnce({ safe: true, expected: 'b'.repeat(40) });
  f.effects.resources
    .mockResolvedValueOnce({ admitted: true })
    .mockResolvedValueOnce({ admitted: true })
    .mockResolvedValueOnce({ admitted: true })
    .mockResolvedValueOnce({ admitted: false });
  await runStagingPipelineRequest(f.store, f.effects, 'worker');
  expect(f.store.settleDeployment).toHaveBeenCalledWith(token, request.acceptedCommit);
  expect(f.store.defer).toHaveBeenCalledWith(token, 'host-resources');
  expect(f.store.quarantine).not.toHaveBeenCalled();
  expect(f.effects.test).not.toHaveBeenCalled();
});
it('a terminal pure-preparation refusal leaves work queued without quarantining native custody', async () => {
  const f = fixture();
  f.effects.check.mockResolvedValueOnce({ safe: true, expected: 'b'.repeat(40) });
  f.effects.prepare.mockRejectedValue(
    Object.assign(Error('main advanced before preparation'), { safePreparationRefusal: true }),
  );
  await runStagingPipelineRequest(f.store, f.effects, 'worker');
  expect(f.store.defer).toHaveBeenCalledWith(token, 'stage-unavailable');
  expect(f.store.quarantine).not.toHaveBeenCalled();
  expect(f.effects.deploy).not.toHaveBeenCalled();
});

it('terminal read-only plan refusal waits before any deployment dispatch', async () => {
  const f = fixture();
  f.effects.check.mockResolvedValueOnce({ safe: true, expected: 'b'.repeat(40) });
  f.effects.plan.mockRejectedValue(
    Object.assign(Error('main advanced'), { terminalRefusal: true }),
  );
  await runStagingPipelineRequest(f.store, f.effects, 'worker');
  expect(f.store.defer).toHaveBeenCalledWith(token, 'stage-unavailable');
  expect(f.store.markDispatched).not.toHaveBeenCalled();
  expect(f.store.quarantine).not.toHaveBeenCalled();
});
it('resource waiting after successful preparation can retry and settle the same request', async () => {
  const f = fixture();
  f.effects.check.mockResolvedValueOnce({ safe: true, expected: 'b'.repeat(40) });
  f.effects.resources
    .mockResolvedValueOnce({ admitted: true })
    .mockResolvedValueOnce({ admitted: true })
    .mockResolvedValueOnce({ admitted: false });
  expect((await runStagingPipelineRequest(f.store, f.effects, 'worker')).state).toBe('queued');
  f.effects.check.mockResolvedValueOnce({ safe: true, expected: 'b'.repeat(40) });
  expect((await runStagingPipelineRequest(f.store, f.effects, 'worker')).state).toBe('passed');
  expect(f.effects.prepare).toHaveBeenCalledTimes(2);
  expect(f.effects.deploy).toHaveBeenCalledTimes(1);
});
