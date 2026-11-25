// Focused fallback: node --experimental-transform-types --test --test-concurrency=1 scripts/verify-github-quota.offline.mts
// This does not replace the better-sqlite3 EventStore/controller/consent suites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubReadQuota } from '../packages/protocol/src/github-read-quota.ts';
import { GitHubReadAdmission } from '../server/github-read-admission.ts';
import { parseGitHubReadResponse } from '../server/github-read-response.ts';

function fixture(path = ':memory:') {
  const db = new DatabaseSync(path);
  // The production owner uses better-sqlite3's synchronous transaction API.
  // This fallback exercises identical SQL against Node's SQLite, without
  // claiming qualification of better-sqlite3 or the controller suites.
  db.transaction = (fn) => () => {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const q = new GitHubReadQuota(db);
  return { db, q, a: new GitHubReadAdmission(q) };
}
const req = (q, now = Date.now(), overrides = {}) => ({
  requestId: q.requestId(now),
  principalId: 'github:42',
  connectionId: 'a',
  cost: 1,
  background: false,
  now,
  ...overrides,
});
const scope = (principalId, connectionId = 'a') => ({
  principalId,
  connectionId,
  background: false,
  signal: new AbortController().signal,
  assertCurrent: () => undefined,
});
const response = (overrides = {}) => ({
  status: 200,
  headers: {
    'x-ratelimit-resource': 'core',
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4999',
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
  },
  data: { id: 42, login: 'owner' },
  ...overrides,
});
const seed = (q, now = 1000) =>
  q.observe('github:42', { limit: 5000, remaining: 5000, resetAt: now + 3600000 }, now);

test('three foreground requests share the authenticated principal with background reads', async () => {
  const { db, q, a } = fixture();
  try {
    await a.read('/user', scope(undefined), async () => response());
    await a.read('/repos/o/r/pulls/1', scope('github:42'), async () => response());
    await a.read('/repos/o/r/pulls/1', scope('github:42', 'b'), async () => response());
    assert.equal(q.inspect('github:42').charged, 3);
    await a.read('/repos/o/r', { ...scope('github:42', 'b'), background: true }, async () =>
      response(),
    );
    assert.equal(q.inspect('github:42').charged, 4);
    assert.equal(q.inspect('github:42').spent, 1);
  } finally {
    db.close();
  }
});
test('global four and per-connection two in-flight caps span connections and principals', () => {
  const { db, q } = fixture();
  try {
    seed(q);
    q.observe('github:43', { limit: 5000, remaining: 5000, resetAt: 3601000 }, 1000);
    q.reserve(req(q, 1000));
    q.reserve(req(q, 1000));
    assert.throws(() => q.reserve(req(q, 1000)), /quota_delayed/);
    q.reserve(req(q, 1000, { connectionId: 'b' }));
    q.reserve(req(q, 1000, { connectionId: 'c', principalId: 'github:43' }));
    assert.throws(() => q.reserve(req(q, 1000, { connectionId: 'd' })), /quota_delayed/);
  } finally {
    db.close();
  }
});
test('minute requests and points are charged even for finished reads', () => {
  const { db, q } = fixture();
  try {
    seed(q);
    for (let i = 0; i < 60; i++) {
      const r = q.reserve(req(q, 1000, { cost: 2 }));
      q.start(r.id, 1000);
      q.finish(r.id);
    }
    assert.equal(q.inspect('github:42').charged, 60);
    assert.throws(() => q.reserve(req(q, 1000)), /quota_delayed/);
  } finally {
    db.close();
  }
});
test('headroom and half allocation survive foreground contention and duplicated headers', () => {
  const { db, q } = fixture();
  try {
    q.observe('github:42', { limit: 10, remaining: 10, resetAt: 10000 }, 1000);
    for (let i = 0; i < 4; i++) {
      const r = q.reserve(req(q, 1000, { background: true }));
      q.finish(r.id);
      q.observe('github:42', { limit: 10, remaining: 10, resetAt: 10000 }, 1000);
    }
    assert.throws(
      () => q.reserve(req(q, 1000, { background: true, connectionId: 'b' })),
      /quota_delayed/,
    );
    for (let i = 0; i < 4; i++) {
      const r = q.reserve(req(q, 1000));
      q.finish(r.id);
    }
    assert.throws(() => q.reserve(req(q, 1000)), /quota_delayed/);
  } finally {
    db.close();
  }
});
test('paced background burst admits sixteen and no seventeenth request', () => {
  const { db, q } = fixture();
  try {
    seed(q);
    for (let i = 0; i < 16; i++) {
      q.finish(q.reserve(req(q, 1000, { background: true })).id);
    }
    assert.throws(() => q.reserve(req(q, 1000, { background: true })), /quota_delayed/);
  } finally {
    db.close();
  }
});
test('restart retains unfinished charges, exact expiry and one-use dispatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-offline-'));
  const path = join(dir, 'events.db');
  let f = fixture(path);
  try {
    seed(f.q);
    const input = req(f.q, 1000);
    const receipt = f.q.reserve(input);
    f.q.start(receipt.id, 1000);
    f.db.close();
    f = fixture(path);
    assert.deepEqual(f.q.reserve(input), receipt);
    assert.throws(() => f.q.start(receipt.id, 1000), /reservation_consumed/);
    assert.throws(() => f.q.start(receipt.id, 21000), /reservation_expired/);
    assert.throws(() => f.q.reserve({ ...input, cost: 2 }), /request_conflict/);
    const remaining = f.q.inspect('github:42').remaining;
    f.q.reserve(req(f.q, 22000));
    assert.equal(f.q.inspect('github:42').remaining, remaining - 1);
  } finally {
    f.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('compaction bounds rows and logical bytes and rejects old epoch IDs', () => {
  const { db, q } = fixture();
  try {
    let first;
    for (let i = 0; i < 4200; i++) {
      const now = 1000 + i * 61000;
      q.observe('github:42', { limit: 5000, remaining: 5000, resetAt: now + 60000 }, now);
      const r = req(q, now);
      first ??= r;
      const receipt = q.reserve(r);
      q.start(receipt.id, now);
      q.finish(receipt.id);
    }
    const stats = db
      .prepare(
        'SELECT count(*) n,sum(length(id)+length(fingerprint)+length(principal_id)+length(connection_id)+40) bytes FROM github_read_reservations',
      )
      .get();
    assert.ok(stats.n <= 4096);
    assert.ok(stats.bytes <= 4194304);
    assert.throws(() => q.reserve({ ...first, now: 300000000 }), /reservation_epoch_expired/);
    assert.equal(q.inspect('github:42').charged, 4200);
  } finally {
    db.close();
  }
});
test('full recent ledger blocks rather than erasing active quota windows', () => {
  const { db, q } = fixture();
  try {
    const insert = db.prepare('INSERT INTO github_read_reservations VALUES (?,?,?,?,?,?,?,0,1)');
    for (let i = 0; i < 4096; i++)
      insert.run('q1:1:' + i, 'github:42', 'a', 'hash', 1, 1000, 21000);
    assert.throws(() => q.requestId(2000), /quota_retention_limit/);
    assert.equal(db.prepare('SELECT count(*) n FROM github_read_reservations').get().n, 4096);
  } finally {
    db.close();
  }
});
test('SQL reservation failure rolls back charges and subsequent retry succeeds once', () => {
  const { db, q } = fixture();
  try {
    const input = req(q, 1000, { probe: true });
    db.exec(
      "CREATE TRIGGER reject_reservation BEFORE INSERT ON github_read_reservations BEGIN SELECT RAISE(ABORT,'offline failure'); END",
    );
    assert.throws(() => q.reserve(input), /offline failure/);
    assert.equal(q.inspect('github:42').charged, 0);
    db.exec('DROP TRIGGER reject_reservation');
    q.reserve(input);
    assert.equal(q.inspect('github:42').charged, 1);
  } finally {
    db.close();
  }
});
test('failed bootstrap debt remains charged on later trusted attestation', async () => {
  const { db, q, a } = fixture();
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    await assert.rejects(
      a.read('/user', scope(undefined), async () => {
        throw Error('offline failure');
      }),
      /offline failure/,
    );
    await assert.rejects(
      a.read('/user', scope(undefined, 'b'), async () => response()),
      /quota_delayed/,
    );
    now += 61000;
    await a.read('/user', scope(undefined, 'b'), async () => response());
    assert.equal(q.inspect('github:42').charged, 2);
  } finally {
    Date.now = realNow;
    db.close();
  }
});
test('transport failures and cancellation stay charged', async () => {
  const { db, q, a } = fixture();
  try {
    await a.read('/user', scope(undefined), async () => response());
    await assert.rejects(
      a.read('/repos/o/r', scope('github:42'), async () => {
        throw Error('failed');
      }),
      /failed/,
    );
    const c = new AbortController();
    await assert.rejects(
      a.read('/repos/o/r', { ...scope('github:42'), signal: c.signal }, async () => {
        c.abort();
        return response();
      }),
    );
    assert.equal(q.inspect('github:42').charged, 3);
  } finally {
    db.close();
  }
});
test('revoked scope and changed accounts cannot return data but real reads remain charged', async () => {
  const { db, q, a } = fixture();
  let current = true;
  try {
    await assert.rejects(
      a.read(
        '/user',
        {
          ...scope(undefined),
          assertCurrent: () => {
            if (!current) throw Error('revoked');
          },
        },
        async () => {
          current = false;
          return response();
        },
      ),
      /revoked/,
    );
    assert.equal(q.inspect('github:42').charged, 1);
    await assert.rejects(
      a.read('/user', scope('github:42', 'b'), async () => response({ data: { id: 43 } })),
      /connection_unavailable/,
    );
    assert.equal(q.inspect('github:43').charged, 1);
    assert.equal(q.inspect('github:42').charged, 2);
  } finally {
    db.close();
  }
});
test('untrusted caller principal cannot select identity accounting', async () => {
  const { db, q, a } = fixture();
  try {
    await assert.rejects(
      a.read('/user', scope('github:999'), async () => response()),
      /connection_unavailable/,
    );
    assert.equal(q.inspect('github:999').charged, 0);
    assert.equal(q.inspect('github:42').charged, 1);
  } finally {
    db.close();
  }
});
test('Retry-After survives missing metadata and blocks transport of the next request', async () => {
  const { db, q, a } = fixture();
  let calls = 0;
  try {
    await a.read('/user', scope(undefined), async () => response());
    const transport = async () => {
      calls++;
      return response({ status: 429, headers: {}, retryAfterMs: 120000 });
    };
    await assert.rejects(a.read('/repos/o/r', scope('github:42'), transport), /quota_delayed/);
    assert.ok(q.inspect('github:42').retryAt >= Date.now() + 119000);
    await assert.rejects(a.read('/repos/o/r', scope('github:42', 'b'), transport), /quota_delayed/);
    assert.equal(calls, 1);
  } finally {
    db.close();
  }
});
test('stale metadata cannot replenish budget or discard Retry-After', () => {
  const { db, q } = fixture();
  try {
    seed(q);
    q.reserve(req(q, 1000));
    const before = q.inspect('github:42');
    q.observe(
      'github:42',
      { limit: 5000, remaining: 5000, resetAt: 3600000, retryAt: 50000 },
      1000,
    );
    assert.equal(q.inspect('github:42').remaining, before.remaining);
    assert.equal(q.inspect('github:42').retryAt, 50000);
  } finally {
    db.close();
  }
});
test('HTTP-date retry headers are bounded; duplicate metadata is rejected', () => {
  const date = new Date(Date.now() + 120000).toUTCString();
  const result = parseGitHubReadResponse(`HTTP/2.0 429 Limited\r\nRetry-After: ${date}\r\n\r\n{}`);
  assert.ok(result.retryAfterMs >= 118000 && result.retryAfterMs <= 120000);
  assert.throws(
    () =>
      parseGitHubReadResponse(
        'HTTP/2.0 200 OK\r\nX-RateLimit-Remaining: 1\r\nx-ratelimit-remaining: 2\r\n\r\n{}',
      ),
    /github_response_invalid/,
  );
});
test('bootstrap Retry-After survives restart before a numeric principal exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-bootstrap-'));
  const path = join(dir, 'events.db');
  let f = fixture(path);
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    await f.a.read('/user', scope(undefined), async () =>
      response({ status: 429, headers: {}, retryAfterMs: 120000, data: null }),
    );
    f.db.close();
    f = fixture(path);
    now += 61000;
    await assert.rejects(
      f.a.read('/user', scope(undefined), async () => response()),
      /quota_delayed/,
    );
    now += 61000;
    await f.a.read('/user', scope(undefined), async () => response());
    assert.equal(f.q.inspect('github:42').charged, 2);
  } finally {
    Date.now = realNow;
    f.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('unstarted expired reservations cannot dispatch and principal retention is bounded', () => {
  const { db, q } = fixture();
  try {
    seed(q);
    const r = q.reserve(req(q, 1000));
    assert.throws(() => q.start(r.id, 21000), /reservation_expired/);
    for (let i = 100; i < 227; i++)
      q.observe('github:' + i, { limit: 5000, remaining: 5000, resetAt: 10000 }, 1000);
    assert.throws(
      () => q.observe('github:999', { limit: 5000, remaining: 5000, resetAt: 10000 }, 1000),
      /quota_retention_limit/,
    );
    assert.equal(db.prepare('SELECT count(*) n FROM github_read_quota').get().n, 128);
  } finally {
    db.close();
  }
});
test('point bound is independent of request count and input bytes are bounded', () => {
  const { db, q } = fixture();
  try {
    seed(q);
    q.finish(q.reserve(req(q, 1000, { cost: 120 })).id);
    assert.throws(() => q.reserve(req(q, 1000)), /quota_delayed/);
    assert.equal(q.inspect('github:42').charged, 1);
    assert.throws(
      () => q.reserve(req(q, 1000, { connectionId: '🦊'.repeat(100) })),
      /invalid_quota_request/,
    );
  } finally {
    db.close();
  }
});
