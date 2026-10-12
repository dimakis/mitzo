import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StagingPipelineStore } from '../../scripts/lib/staging-pipeline-store.mjs';
import {
  assertStagingPipelineMutation,
  assertStagingPipelineFeatureDispatch,
} from '../../scripts/lib/staging-pipeline-mutation-guard.mjs';
const fixtures = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    f.store?.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeline-guard-')));
  const store = new StagingPipelineStore(join(root, 'queue.db'));
  fixtures.push({ root, store });
  return { root, store };
}
const sha = 'a'.repeat(40),
  r = { id: 'r', taskId: 's', pr: 1, acceptedCommit: sha, suite: 'http-readiness' };
it('legacy mutation remains available only when no pipeline has been enrolled', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeline-unenrolled-')));
  fixtures.push({ root });
  expect(() => assertStagingPipelineMutation({ target: sha, apply: true }, { root })).not.toThrow();
});
it('direct deploy cannot replace an enrolled baseline outside its reservation', () => {
  const { root, store } = fixture();
  store.enqueue(r);
  expect(() => assertStagingPipelineMutation({ target: sha, apply: true }, { root })).toThrow(
    /reservation/,
  );
  const c = store.claim('worker');
  store.bindBaseline(c.token, sha);
  expect(() =>
    assertStagingPipelineMutation(
      { target: sha, apply: false, proof: JSON.stringify(c.token) },
      { root },
    ),
  ).not.toThrow();
  expect(() =>
    assertStagingPipelineMutation(
      { target: sha, apply: true, proof: JSON.stringify(c.token) },
      { root },
    ),
  ).toThrow(/dispatch/);
  store.markDispatched(c.token);
  expect(() =>
    assertStagingPipelineMutation(
      { target: sha, apply: true, proof: JSON.stringify(c.token) },
      { root },
    ),
  ).not.toThrow();
  for (const changed of [
    { target: 'b'.repeat(40) },
    { proof: JSON.stringify({ ...c.token, epoch: 2 }) },
  ])
    expect(() =>
      assertStagingPipelineMutation(
        { target: sha, apply: true, proof: JSON.stringify(c.token), ...changed },
        { root },
      ),
    ).toThrow();
});
it('stale and quarantined capabilities cannot be used to deploy', () => {
  const { root, store } = fixture();
  store.enqueue(r);
  const c = store.claim('worker');
  store.bindBaseline(c.token, sha);
  store.markDispatched(c.token);
  store.quarantine(c.token, 'controller-lost');
  expect(() =>
    assertStagingPipelineMutation(
      { target: sha, apply: true, proof: JSON.stringify(c.token) },
      { root },
    ),
  ).toThrow();
});
it('feature dispatch requires an exact enrolled profile, announced plan and original stage owner', () => {
  const { root, store } = fixture();
  store.enqueue({
    ...r,
    version: 2,
    suite: 'profile-tools-v1',
    profileId: 'stage-profile',
    enrollmentRevision: 'e'.repeat(64),
  });
  const c = store.claim('worker');
  store.bindBaseline(c.token, sha);
  const plan = {
    requestId: 'r',
    sourceCommit: sha,
    profileId: 'stage-profile',
    enrollmentRevision: 'e'.repeat(64),
    ownerInstance: 'owner',
  };
  const input = { sourceCommit: sha, token: c.token, planSha256: 'f'.repeat(64), plan };
  expect(() => assertStagingPipelineFeatureDispatch(input, { root })).toThrow();
  store.bindFeaturePlan(c.token, input.planSha256, 'owner');
  expect(() => assertStagingPipelineFeatureDispatch(input, { root })).toThrow();
  store.markDispatched(c.token);
  expect(() => assertStagingPipelineFeatureDispatch(input, { root })).not.toThrow();
  for (const change of [
    { planSha256: 'd'.repeat(64) },
    { sourceCommit: 'b'.repeat(40) },
    { token: { ...c.token, nonce: 'other' } },
    { plan: { ...plan, ownerInstance: 'successor' } },
    { plan: { ...plan, profileId: 'other' } },
    { plan: { ...plan, enrollmentRevision: 'c'.repeat(64) } },
  ])
    expect(() => assertStagingPipelineFeatureDispatch({ ...input, ...change }, { root })).toThrow();
  const { deadline } = store.db.prepare('SELECT deadline FROM reservation WHERE singleton=1').get();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(deadline - 1);
  expect(() => assertStagingPipelineFeatureDispatch(input, { root })).not.toThrow();
  clock.mockReturnValue(deadline);
  expect(() => assertStagingPipelineFeatureDispatch(input, { root })).toThrow(/reservation/);
  clock.mockRestore();
  store.quarantine(c.token, 'test-cleanup-uncertain');
  expect(() => assertStagingPipelineFeatureDispatch(input, { root })).toThrow();
});
it('feature dispatch never inherits legacy unenrolled mutation authority', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'feature-unenrolled-')));
  fixtures.push({ root });
  expect(() => assertStagingPipelineFeatureDispatch({}, { root })).toThrow();
});

it('physical mutation refuses the exact deadline, matching the original queue expiry', () => {
  const { root, store } = fixture();
  store.enqueue(r);
  const c = store.claim('worker');
  store.bindBaseline(c.token, sha);
  store.markDispatched(c.token);
  const { deadline } = store.db.prepare('SELECT deadline FROM reservation WHERE singleton=1').get();
  vi.spyOn(Date, 'now').mockReturnValue(deadline);
  expect(() =>
    assertStagingPipelineMutation(
      { target: sha, apply: true, proof: JSON.stringify(c.token) },
      { root },
    ),
  ).toThrow(/reservation/);
});
