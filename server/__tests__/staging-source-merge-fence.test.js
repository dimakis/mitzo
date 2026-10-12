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
  expect(a.claimSourceMerge({ pr: 123, head })).toMatchObject({ granted: false });
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
