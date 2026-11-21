import { afterEach, expect, it } from 'vitest';
import { EventStore } from '../src/event-store.js';
import Database from 'better-sqlite3';
import { GitHubReadQuota } from '../src/github-read-quota.js';
const stores: EventStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
const fixture = () => {
  const s = new EventStore(':memory:');
  stores.push(s);
  return s.githubReadQuota;
};
const request = (id: string, connectionId = 'connection', background = true) => ({
  requestId: `q1:1:${id}`,
  principalId: 'github:42',
  connectionId,
  background,
  cost: 1,
  now: 1000,
});
it('retains exact receipts but dispatches them only once, including after expiry and restart', () => {
  const db = new Database(':memory:');
  try {
    let q = new GitHubReadQuota(db);
    const r = { ...request('once'), probe: true };
    const receipt = q.reserve(r);
    q.start(receipt.id, r.now);
    q = new GitHubReadQuota(db);
    expect(q.reserve(r)).toEqual(receipt);
    expect(() => q.start(receipt.id, r.now)).toThrow('reservation_consumed');
    expect(() => q.start(receipt.id, r.now + 20001)).toThrow('reservation_expired');
    expect(q.inspect(r.principalId).charged).toBe(1);
  } finally { db.close(); }
});
it('compacts bounded receipts under an epoch fence without admitting forgotten IDs', () => {
  const db = new Database(':memory:');
  try {
    const q = new GitHubReadQuota(db);
    let first = '';
    for (let i = 0; i < 4200; i++) {
      const now = 1000 + i * 61000;
      q.observe('github:42', { limit: 5000, remaining: 5000, resetAt: now + 60000 }, now);
      const requestId = q.requestId(now);
      if (!i) first = requestId;
      const receipt = q.reserve({ ...request('unused'), requestId, now });
      q.start(receipt.id, now);
      q.finish(receipt.id);
    }
    expect(db.prepare('SELECT count(*) n FROM github_read_reservations').get()).toMatchObject({ n: expect.any(Number) });
    const rows = db.prepare('SELECT count(*) n, sum(length(id)+length(fingerprint)+length(principal_id)+length(connection_id)+40) bytes FROM github_read_reservations').get() as {n:number;bytes:number};
    expect(rows.n).toBeLessThanOrEqual(4096);
    expect(rows.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(() => q.reserve({ ...request('unused'), requestId: first, now: 300000000 })).toThrow('reservation_epoch_expired');
    expect(q.inspect('github:42').charged).toBe(4200);
  } finally { db.close(); }
});
it('rolls back quota charges and dispatch claims when SQLite rejects the reservation transaction', () => {
  const db = new Database(':memory:');
  try {
    const q = new GitHubReadQuota(db);
    db.exec("CREATE TRIGGER reject_reservation BEFORE INSERT ON github_read_reservations BEGIN SELECT RAISE(ABORT, 'offline disk failure'); END");
    expect(() => q.reserve({ ...request('failed'), probe:true })).toThrow('offline disk failure');
    expect(q.inspect('github:42').charged).toBe(0);
    db.exec('DROP TRIGGER reject_reservation');
    q.reserve({ ...request('failed'), probe:true });
    expect(q.inspect('github:42').charged).toBe(1);
  } finally { db.close(); }
});
it('requires quota metadata, admits one discovery probe and retains every charged reservation', () => {
  const q = fixture();
  expect(() => q.reserve(request('no-metadata'))).toThrow('quota_delayed');
  q.reserve({ ...request('probe'), probe: true });
  expect(() => q.reserve({ ...request('next'), probe: true })).toThrow('quota_delayed');
  q.observe('github:42', { limit: 5000, remaining: 4999, resetAt: 3600000 }, 1000);
  q.finish(request('probe').requestId);
  const r = q.reserve(request('read'));
  expect(q.reserve(request('read'))).toEqual(r);
  expect(() => q.reserve({ ...request('read'), connectionId: 'other' })).toThrow(
    'request_conflict',
  );
  expect(q.inspect('github:42').charged).toBe(2);
});
it('shares a principal across connections, protects headroom and cannot refill background allocation from responses', () => {
  const q = fixture();
  q.observe('github:42', { limit: 10, remaining: 10, resetAt: 2000 }, 1000);
  for (let i = 0; i < 4; i++) {
    q.reserve(request(String(i), String(i)));
    q.finish(request(String(i)).requestId);
    q.observe('github:42', { limit: 10, remaining: 10 - i, resetAt: 2000 }, 1000);
  }
  expect(() => q.reserve(request('rotation', 'another'))).toThrow('quota_delayed');
  for (let i = 4; i < 8; i++) {
    q.reserve(request(String(i), 'foreground', false));
    q.finish(request(String(i)).requestId);
  }
  expect(() => q.reserve(request('protected', 'foreground', false))).toThrow('quota_delayed');
});
it('honors Retry-After, external depletion, stale reset evidence and in-flight concurrency', () => {
  const q = fixture();
  q.observe('github:42', { limit: 1000, remaining: 1000, resetAt: 60000 }, 1000);
  q.reserve(request('a'));
  q.reserve(request('b'));
  expect(() => q.reserve(request('c'))).toThrow('quota_delayed');
  q.finish(request('a').requestId);
  q.finish(request('b').requestId);
  q.observe(
    'github:42',
    { limit: 1000, remaining: 10, resetAt: 60000, retryAt: 100000 },
    1000,
  );
  expect(() => q.reserve(request('limited'))).toThrow('quota_delayed');
  expect(() => q.reserve({ ...request('stale'), now: 100001 })).toThrow('quota_delayed');
});
it('unknown costs and expired reservations never create optimistic budget refunds', () => {
  const q = fixture();
  q.observe('github:42', { limit: 100, remaining: 100, resetAt: 30000 }, 1000);
  expect(() => q.reserve({ ...request('cost'), cost: 0 })).toThrow('invalid_quota_request');
  q.reserve(request('lost'));
  const before = q.inspect('github:42');
  q.reserve({ ...request('next'), now: 22000 });
  expect(q.inspect('github:42').remaining).toBe(before.remaining - 1);
});
