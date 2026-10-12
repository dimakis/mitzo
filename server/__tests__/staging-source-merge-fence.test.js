import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StagingPipelineStore } from '../../scripts/lib/staging-pipeline-store.mjs';
const fixtures = [];
afterEach(() => {
  for (const { root, stores } of fixtures.splice(0)) {
    for (const s of stores) s.close();
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'source-merge-fence-'))),
    path = join(root, 'queue.db'),
    stores = [new StagingPipelineStore(path), new StagingPipelineStore(path)];
  fixtures.push({ root, stores });
  return stores;
}
const head = 'a'.repeat(40),
  accepted = 'b'.repeat(40);
const request = {
  id: 'readiness',
  pr: 123,
  taskId: 'pr-dimakis-mitzo-123',
  acceptedCommit: accepted,
  suite: 'http-readiness',
};
it('the same transaction boundary makes a source merge and staging claim mutually exclusive', () => {
  const [a, b] = fixture();
  a.enqueue(request);
  const merge = a.claimSourceMerge({ pr: 123, head });
  expect(merge.granted).toBe(true);
  expect(b.claim('worker')).toMatchObject({ granted: false, reason: 'source-merge-busy' });
  expect(b.claimSourceMerge({ pr: 124, head })).toMatchObject({ granted: false });
  a.releaseSourceMerge(merge.token);
  const staging = b.claim('worker');
  b.markDispatched(staging.token);
  expect(a.claimSourceMerge({ pr: 123, head })).toMatchObject({
    granted: false,
    reason: 'staging-busy',
  });
  b.quarantine(staging.token, 'controller-lost');
  expect(a.claimSourceMerge({ pr: 123, head })).toMatchObject({ granted: true });
});
it('uncertain dispatched merges retain capacity indefinitely and cannot retry or benign-release', () => {
  const [a, b] = fixture(),
    merge = a.claimSourceMerge({ pr: 123, head });
  a.markSourceMergeDispatched(merge.token);
  expect(() => a.markSourceMergeDispatched(merge.token)).toThrow();
  expect(() => a.releaseSourceMerge(merge.token)).toThrow();
  expect(b.claimSourceMerge({ pr: 123, head })).toMatchObject({
    granted: false,
    reason: 'merge-reconciliation-required',
  });
  expect(b.sourceMergeStatus()).toMatchObject({ state: 'dispatched', pr: 123, head });
});
it('accepted merge readiness is retained atomically before the source fence is released', () => {
  const [a, b] = fixture(),
    merge = a.claimSourceMerge({ pr: 123, head });
  a.markSourceMergeDispatched(merge.token);
  expect(() => a.completeSourceMerge(merge.token, { ...request, pr: 124 })).toThrow();
  expect(b.claim('worker')).toMatchObject({ granted: false, reason: 'source-merge-busy' });
  a.completeSourceMerge(merge.token, request);
  expect(b.sourceMergeStatus()).toEqual({ state: 'idle' });
  expect(b.claim('worker')).toMatchObject({ granted: true, request });
});
it('a failed enqueue preserves merge capacity and a stale token cannot release another admission', () => {
  const [a, b] = fixture();
  a.enqueue({ ...request, acceptedCommit: head });
  const merge = a.claimSourceMerge({ pr: 123, head });
  a.markSourceMergeDispatched(merge.token);
  expect(() => a.completeSourceMerge(merge.token, request)).toThrow();
  expect(b.sourceMergeStatus().state).toBe('dispatched');
  expect(() => b.releaseSourceMerge({ ...merge.token, nonce: 'wrong' })).toThrow();
});

it('reviewed repair acceptance preserves the complete quarantined operation and cannot grant staging', () => {
  const [a, b] = fixture();
  a.enqueue({ ...request, id: 'old-stage', pr: 122, taskId: 'old-stage' });
  const stage = a.claim('original-worker');
  a.bindBaseline(stage.token, accepted);
  a.markDispatched(stage.token);
  a.quarantine(stage.token, 'deployment-uncertain');
  const before = a.db.prepare('SELECT * FROM reservation').get();
  const oldRequest = a.receipt('old-stage');
  const merge = b.claimSourceMerge({ pr: 123, head });
  expect(merge.granted).toBe(true);
  b.markSourceMergeDispatched(merge.token);
  b.completeSourceMerge(merge.token, request);
  expect(a.db.prepare('SELECT * FROM reservation').get()).toEqual(before);
  expect(a.receipt('old-stage')).toEqual(oldRequest);
  expect(a.receipt(request.id).state).toBe('queued');
  expect(a.claim('replacement')).toMatchObject({
    granted: false,
    reason: 'environment-quarantined',
  });
  for (const use of [
    () => a.markDispatched(stage.token),
    () => a.bindBaseline(stage.token, head),
    () => a.settleDeployment(stage.token, accepted),
    () => a.defer(stage.token, 'stage-unavailable'),
    () =>
      a.finish(stage.token, { outcome: 'passed', sourceCommit: accepted, cleanupConfirmed: true }),
    () => a.cancel('old-stage'),
  ])
    expect(use).toThrow();
  expect(a.db.prepare('SELECT * FROM reservation').get()).toEqual(before);
});
it.each(['admission', 'dispatch', 'reconciliation'])(
  'retains the repair fence when the original quarantine changes during %s',
  (phase) => {
    const [a, b] = fixture();
    a.enqueue({ ...request, id: 'old-stage' });
    const stage = a.claim('original-worker');
    a.quarantine(stage.token, 'controller-lost');
    const merge = b.claimSourceMerge({ pr: 123, head });
    expect(merge.granted).toBe(true);
    if (phase === 'reconciliation') b.markSourceMergeDispatched(merge.token);
    a.db.prepare('UPDATE reservation SET source_commit=?').run(head);
    const operation =
      phase === 'admission'
        ? () => b.releaseSourceMerge(merge.token)
        : phase === 'dispatch'
          ? () => b.markSourceMergeDispatched(merge.token)
          : () => b.completeSourceMerge(merge.token, request);
    expect(operation).toThrow(/staging fence/i);
    expect(b.sourceMergeStatus().state).not.toBe('idle');
    expect(a.receipt(request.id).state).toBe('missing');
  },
);
it('an expired active operation remains active and cannot admit a source repair', () => {
  const [a, b] = fixture();
  a.enqueue(request);
  a.claim('worker');
  a.db.prepare('UPDATE reservation SET deadline=0').run();
  expect(b.claimSourceMerge({ pr: 123, head })).toMatchObject({
    granted: false,
    reason: 'staging-busy',
  });
});
