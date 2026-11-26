import { afterEach, expect, it } from 'vitest';
import { EventStore } from '../src/event-store.js';
const stores: EventStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
const fixture = () => {
  const s = new EventStore(':memory:');
  stores.push(s);
  return s.githubReadQuota;
};
const request = (id: string, connectionId = 'connection', background = true) => ({
  requestId: id,
  principalId: 'github:user:42',
  connectionId,
  background,
  cost: 1,
  now: 1000,
});
it('requires quota metadata, admits one discovery probe and retains every charged reservation', () => {
  const q = fixture();
  expect(() => q.reserve(request('no-metadata'))).toThrow('quota_delayed');
  q.reserve({ ...request('probe'), probe: true });
  expect(() => q.reserve({ ...request('next'), probe: true })).toThrow('quota_delayed');
  q.observe('github:user:42', { limit: 5000, remaining: 4999, resetAt: 3600000 }, 1000);
  q.finish('probe');
  const r = q.reserve(request('read'));
  expect(q.reserve(request('read'))).toEqual(r);
  expect(() => q.reserve({ ...request('read'), connectionId: 'other' })).toThrow(
    'request_conflict',
  );
  expect(q.inspect('github:user:42').charged).toBe(2);
});
it('shares a principal across connections, protects headroom and cannot refill background allocation from responses', () => {
  const q = fixture();
  q.observe('github:user:42', { limit: 10, remaining: 10, resetAt: 2000 }, 1000);
  for (let i = 0; i < 4; i++) {
    q.reserve(request(String(i), String(i)));
    q.finish(String(i));
    q.observe('github:user:42', { limit: 10, remaining: 10 - i, resetAt: 2000 }, 1000);
  }
  expect(() => q.reserve(request('rotation', 'another'))).toThrow('quota_delayed');
  for (let i = 4; i < 8; i++) {
    q.reserve(request(String(i), 'foreground', false));
    q.finish(String(i));
  }
  expect(() => q.reserve(request('protected', 'foreground', false))).toThrow('quota_delayed');
});
it('honors Retry-After, external depletion, stale reset evidence and in-flight concurrency', () => {
  const q = fixture();
  q.observe('github:user:42', { limit: 1000, remaining: 1000, resetAt: 60000 }, 1000);
  q.reserve(request('a'));
  q.reserve(request('b'));
  expect(() => q.reserve(request('c'))).toThrow('quota_delayed');
  q.finish('a');
  q.finish('b');
  q.observe(
    'github:user:42',
    { limit: 1000, remaining: 10, resetAt: 60000, retryAt: 100000 },
    1000,
  );
  expect(() => q.reserve(request('limited'))).toThrow('quota_delayed');
  expect(() => q.reserve({ ...request('stale'), now: 100001 })).toThrow('quota_delayed');
});
it('unknown costs and expired reservations never create optimistic budget refunds', () => {
  const q = fixture();
  q.observe('github:user:42', { limit: 100, remaining: 100, resetAt: 30000 }, 1000);
  expect(() => q.reserve({ ...request('cost'), cost: 0 })).toThrow('invalid_quota_request');
  q.reserve(request('lost'));
  const before = q.inspect('github:user:42');
  q.reserve({ ...request('next'), now: 22000 });
  expect(q.inspect('github:user:42').remaining).toBe(before.remaining - 1);
});
