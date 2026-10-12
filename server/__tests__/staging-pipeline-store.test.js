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
