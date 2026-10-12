import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StagingPipelineStore } from '../../scripts/lib/staging-pipeline-store.mjs';
import { assessStagingResources } from '../../scripts/lib/staging-resource-budget.mjs';

const fixtures = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.stores.forEach((s) => s.close());
    rmSync(f.root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'staging-pipeline-')));
  const path = join(root, 'queue.db');
  let now = 1000;
  const stores = Array.from(
    { length: 11 },
    () => new StagingPipelineStore(path, { clock: () => now }),
  );
  fixtures.push({ root, stores });
  return {
    stores,
    advance: () => {
      now += 700000;
    },
  };
}
const request = (id = 'one') => ({
  id,
  taskId: 'session-1',
  pr: 123,
  acceptedCommit: 'a'.repeat(40),
  suite: 'http-readiness',
});
const featureRequest = (id = 'feature') => ({
  ...request(id),
  version: 2,
  suite: 'profile-tools-v1',
  profileId: 'personal-stage',
  enrollmentRevision: 'e'.repeat(64),
});
it('queues versioned profile features in the same singleton without account or model overrides', () => {
  const {
    stores: [s, t],
  } = fixture();
  s.enqueue(featureRequest());
  t.enqueue(request());
  const claim = s.claim('worker');
  expect(claim.request).toEqual(featureRequest());
  expect(t.claim('another')).toMatchObject({ granted: false, reason: 'staging-busy' });
  for (const change of [
    { model: 'gpt-6.1-sol' },
    { account: 'production' },
    { command: 'anything' },
    { version: 1 },
    { enrollmentRevision: 'unknown' },
    { profileId: '../other' },
  ])
    expect(() => s.enqueue({ ...featureRequest('bad'), ...change })).toThrow();
});
it('feature summaries preserve owner evidence references and refuse bare passing declarations', () => {
  const {
    stores: [s],
  } = fixture();
  s.enqueue(featureRequest());
  const claim = s.claim('worker');
  s.bindBaseline(claim.token, 'a'.repeat(40));
  s.bindFeaturePlan(claim.token, 'f'.repeat(64), 'owner');
  s.markDispatched(claim.token);
  const result = { outcome: 'passed', sourceCommit: 'a'.repeat(40), cleanupConfirmed: true };
  expect(() => s.finish(claim.token, result)).toThrow(/owner/);
  const featureReceipt = {
    version: 1,
    profileId: 'personal-stage',
    enrollmentRevision: 'e'.repeat(64),
    planSha256: 'f'.repeat(64),
    ownerInstance: 'owner',
    runId: 'run',
    ownerReceiptSha256: 'd'.repeat(64),
  };
  s.finish(claim.token, { ...result, featureReceipt });
  expect(s.receipt('feature')).toMatchObject({
    version: 1,
    suite: 'profile-tools-v1',
    profileId: 'personal-stage',
    enrollmentRevision: 'e'.repeat(64),
    result: { featureReceipt, liveFeatureValidation: 'requires-owner-verification' },
  });
});
it('deduplicates identical requests but refuses a changed request identity', () => {
  const {
    stores: [s],
  } = fixture();
  s.enqueue(request());
  s.enqueue(request());
  expect(s.status().requests).toHaveLength(1);
  expect(() => s.enqueue({ ...request(), acceptedCommit: 'b'.repeat(40) })).toThrow(/identity/);
});
it('eleven independent sessions share one durable deployment-and-test reservation', () => {
  const { stores } = fixture();
  stores.forEach((s, i) => s.enqueue(request('request-' + i)));
  const claims = stores.map((s, i) => s.claim('controller-' + i));
  expect(claims.filter((c) => c.granted)).toHaveLength(1);
  expect(claims[0].request.id).toBe('request-0');
  expect(stores[10].status().reservation.requestId).toBe('request-0');
});
it('expiry leaves the original reservation fenced instead of starting a replacement', () => {
  const {
    stores: [s, t],
    advance,
  } = fixture();
  s.enqueue(request());
  const c = s.claim('worker');
  advance();
  expect(t.claim('successor')).toMatchObject({ granted: false, reason: 'reconciliation-required' });
  expect(() =>
    s.finish(
      { ...c.token, epoch: c.token.epoch + 1 },
      { outcome: 'passed', sourceCommit: 'a'.repeat(40), cleanupConfirmed: true },
    ),
  ).toThrow(/reservation/);
});
it('only matching commit and confirmed cleanup can publish a passing result', () => {
  const {
    stores: [s],
  } = fixture();
  s.enqueue(request());
  const c = s.claim('worker');
  expect(() =>
    s.finish(c.token, { outcome: 'passed', sourceCommit: 'b'.repeat(40), cleanupConfirmed: true }),
  ).toThrow(/source/);
  expect(() =>
    s.finish(c.token, { outcome: 'passed', sourceCommit: 'a'.repeat(40), cleanupConfirmed: false }),
  ).toThrow(/cleanup/);
  s.finish(c.token, { outcome: 'passed', sourceCommit: 'a'.repeat(40), cleanupConfirmed: true });
  expect(s.status().requests[0].state).toBe('passed');
  expect(s.status().reservation.state).toBe('idle');
});
it('uncertain execution quarantines the resource and prevents later claims', () => {
  const {
    stores: [s],
  } = fixture();
  s.enqueue(request());
  const c = s.claim('worker');
  s.quarantine(c.token, 'test-cleanup-uncertain');
  s.enqueue(request('two'));
  expect(s.claim('worker')).toMatchObject({ granted: false, reason: 'environment-quarantined' });
});
it('pre-dispatch waiting returns the request to the queue without a test result', () => {
  const {
    stores: [s],
  } = fixture();
  s.enqueue(request());
  const c = s.claim('worker');
  s.defer(c.token, 'host-resources');
  expect(s.status().requests[0]).toMatchObject({ state: 'queued', reason: 'host-resources' });
});
it('cannot defer or cancel dispatched work and accidentally release its reservation', () => {
  const {
    stores: [s],
  } = fixture();
  s.enqueue(request());
  const c = s.claim('worker');
  s.markDispatched(c.token);
  expect(() => s.defer(c.token, 'host-resources')).toThrow(/dispatched/);
  expect(() => s.cancel('one')).toThrow(/active/);
});
it('cancellation does not disturb other queued requests', () => {
  const {
    stores: [s],
  } = fixture();
  s.enqueue(request());
  s.enqueue(request('two'));
  s.cancel('one');
  expect(s.claim('worker').request.id).toBe('two');
});
it('bounds pending work rather than allowing unlimited queue growth', () => {
  const {
    stores: [s],
  } = fixture();
  for (let i = 0; i < 100; i++) s.enqueue(request('r' + i));
  expect(() => s.enqueue(request('overflow'))).toThrow(/capacity/);
});
it('readiness-only requests cannot smuggle a model invocation or arbitrary command', () => {
  const {
    stores: [s],
  } = fixture();
  for (const changed of [
    { command: 'rm -rf /' },
    { model: 'gpt-6-sol' },
    { suite: 'unknown' },
    { acceptedCommit: 'main' },
    { account: 'production' },
  ])
    expect(() => s.enqueue({ ...request(), ...changed })).toThrow();
});
const resources = {
  memoryFreePercent: 45,
  pressureLevel: 1,
  swapUsedMiB: 0,
  diskFreeGiB: 60,
  stagingGiB: 20,
  vmMemoryMiB: 4096,
  vmCpus: 2,
};
it('holds admission under host pressure, disk shortage, oversized stage or unbounded VM', () => {
  expect(assessStagingResources(resources)).toMatchObject({ admitted: true });
  for (const changed of [
    { memoryFreePercent: 10 },
    { pressureLevel: 2 },
    { swapUsedMiB: 3000 },
    { diskFreeGiB: 10 },
    { stagingGiB: 40 },
    { vmMemoryMiB: 8192 },
    { vmCpus: 8 },
    { pressureLevel: null },
  ])
    expect(assessStagingResources({ ...resources, ...changed }).admitted).toBe(false);
});
it('a verified completed deployment can wait for resources without retaining dispatched work', () => {
  const {
    stores: [s],
  } = fixture();
  s.enqueue(request());
  const c = s.claim('worker');
  s.bindBaseline(c.token, 'a'.repeat(40));
  s.markDispatched(c.token);
  expect(() => s.settleDeployment(c.token, 'b'.repeat(40))).toThrow(/source/);
  s.settleDeployment(c.token, 'a'.repeat(40));
  s.defer(c.token, 'host-resources');
  expect(s.status().reservation.state).toBe('idle');
});
it('keeps queued work visible after more than 200 historical receipts', () => {
  const {
    stores: [s],
  } = fixture();
  for (let i = 0; i < 201; i++) {
    s.enqueue(request('old' + i));
    s.cancel('old' + i);
  }
  s.enqueue(request('current'));
  expect(s.status().requests.some((r) => r.id === 'current')).toBe(true);
});
it('looks up an exact old receipt with its accepted and actually tested sources', () => {
  const {
    stores: [s],
  } = fixture();
  s.enqueue(request('selected'));
  const c = s.claim('worker');
  const source = 'b'.repeat(40);
  s.bindBaseline(c.token, source);
  s.markDispatched(c.token);
  s.finish(c.token, { outcome: 'passed', sourceCommit: source, cleanupConfirmed: true });
  for (let i = 0; i < 201; i++) {
    s.enqueue(request('later' + i));
    s.cancel('later' + i);
  }
  expect(s.status().requests.some((r) => r.id === 'selected')).toBe(false);
  expect(s.receipt('selected')).toEqual({
    version: 1,
    requestId: 'selected',
    pr: 123,
    taskId: 'session-1',
    acceptedCommit: 'a'.repeat(40),
    suite: 'http-readiness',
    state: 'passed',
    reason: null,
    result: {
      acceptedCommit: 'a'.repeat(40),
      sourceCommit: source,
      suite: 'http-readiness',
      epoch: c.token.epoch,
      outcome: 'passed',
      cleanupConfirmed: true,
      completedAt: 1000,
    },
  });
});
it('reads pending and quarantined requests without inventing a result or changing custody', () => {
  const {
    stores: [s],
  } = fixture();
  expect(s.receipt('missing')).toEqual({ version: 1, requestId: 'missing', state: 'missing' });
  s.enqueue(request());
  expect(s.receipt('one')).toMatchObject({ state: 'queued', result: null });
  const c = s.claim('worker');
  expect(s.receipt('one')).toMatchObject({ state: 'active', result: null });
  s.quarantine(c.token, 'deployment-uncertain');
  const before = s.status();
  expect(s.receipt('one')).toMatchObject({
    state: 'quarantined',
    reason: 'deployment-uncertain',
    result: null,
  });
  expect(s.status()).toEqual(before);
});
