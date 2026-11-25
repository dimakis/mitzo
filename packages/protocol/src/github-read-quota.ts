import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
type State = {
  limit: number;
  remaining: number;
  resetAt: number;
  observedAt: number;
  retryAt: number;
  epochStart: number;
  allocation: number;
  spent: number;
  charged: number;
  probeAt: number | null;
};
type Request = {
  requestId: string;
  principalId: string;
  connectionId: string;
  background: boolean;
  cost: number;
  now: number;
  probe?: boolean;
};
type Metadata = { limit: number; remaining: number; resetAt: number; retryAt?: number };
/** REST resource budget shared by authenticated principal, never by rotating
 * connection/token. Outstanding reservations survive restart and are not refunded.
 * GraphQL requires a separately qualified points owner and is not admitted here. */
export class GitHubReadQuota {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS github_read_quota(principal_id TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS github_read_reservations(id TEXT PRIMARY KEY,principal_id TEXT NOT NULL,connection_id TEXT NOT NULL,fingerprint TEXT NOT NULL,cost INTEGER NOT NULL,at INTEGER NOT NULL,expires_at INTEGER NOT NULL,finished INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS github_read_reservation_window ON github_read_reservations(principal_id,at);`);
  }
  inspect(principalId: string): State {
    const row = this.db
      .prepare('SELECT data FROM github_read_quota WHERE principal_id=?')
      .get(principalId) as { data: string } | undefined;
    return row
      ? (JSON.parse(row.data) as State)
      : {
          limit: 0,
          remaining: 0,
          resetAt: 0,
          observedAt: 0,
          retryAt: 0,
          epochStart: 0,
          allocation: 0,
          spent: 0,
          charged: 0,
          probeAt: null,
        };
  }
  private save(principalId: string, state: State) {
    this.db
      .prepare(
        'INSERT INTO github_read_quota VALUES (?,?) ON CONFLICT(principal_id) DO UPDATE SET data=excluded.data',
      )
      .run(principalId, JSON.stringify(state));
  }
  observe(principalId: string, m: Metadata, now: number) {
    if (
      !principalId ||
      principalId.length > 200 ||
      ![m.limit, m.remaining, m.resetAt, now, m.retryAt ?? 0].every(Number.isSafeInteger) ||
      m.limit < 1 ||
      m.remaining < 0 ||
      m.remaining > m.limit ||
      m.resetAt <= now
    )
      throw Error('invalid_quota_metadata');
    this.db.transaction(() => {
      const s = this.inspect(principalId);
      if (s.resetAt === 0 || (now >= s.resetAt && m.resetAt > s.resetAt)) {
        s.limit = m.limit;
        s.remaining = m.remaining;
        s.resetAt = m.resetAt;
        s.epochStart = now;
        s.spent = 0;
        s.allocation = Math.max(0, Math.floor((m.remaining - Math.ceil(m.limit * 0.2)) / 2));
      } else {
        // Delayed responses and duplicated remaining headers cannot refill an epoch.
        if (m.resetAt !== s.resetAt) return;
        s.limit = Math.min(s.limit, m.limit);
        s.remaining = Math.min(s.remaining, m.remaining);
        s.allocation = Math.min(
          s.allocation,
          s.spent + Math.max(0, Math.floor((s.remaining - Math.ceil(s.limit * 0.2)) / 2)),
        );
      }
      s.observedAt = now;
      s.retryAt = Math.max(s.retryAt, m.retryAt ?? 0);
      this.save(principalId, s);
    })();
  }
  reserve(r: Request) {
    if (
      ![r.requestId, r.principalId, r.connectionId].every((v) => v && v.length <= 200) ||
      !Number.isSafeInteger(r.cost) ||
      r.cost < 1 ||
      r.cost > 120 ||
      !Number.isSafeInteger(r.now) ||
      r.now < 0
    )
      throw Error('invalid_quota_request');
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([r.principalId, r.connectionId, r.background, r.cost, r.probe === true]),
      )
      .digest('hex');
    return this.db.transaction(() => {
      const old = this.db
        .prepare('SELECT fingerprint,expires_at FROM github_read_reservations WHERE id=?')
        .get(r.requestId) as { fingerprint: string; expires_at: number } | undefined;
      if (old) {
        if (old.fingerprint !== fingerprint) throw Error('request_conflict');
        return { id: r.requestId, expiresAt: old.expires_at };
      }
      const s = this.inspect(r.principalId);
      const window = this.db
        .prepare(
          'SELECT count(*) requests,COALESCE(sum(cost),0) points,COALESCE(sum(finished=0 AND expires_at>?),0) active,COALESCE(sum(finished=0 AND expires_at>? AND connection_id=?),0) child FROM github_read_reservations WHERE principal_id=? AND at>?',
        )
        .get(r.now, r.now, r.connectionId, r.principalId, r.now - 60000) as {
        requests: number;
        points: number;
        active: number;
        child: number;
      };
      if (
        s.retryAt > r.now ||
        window.requests >= 60 ||
        window.points + r.cost > 120 ||
        window.active >= 4 ||
        window.child >= 2
      )
        throw Error('quota_delayed');
      const fresh = s.resetAt > r.now && s.observedAt >= r.now - 60000;
      if (!fresh) {
        if (
          !r.probe ||
          r.cost !== 1 ||
          window.active ||
          (s.probeAt !== null && r.now - s.probeAt < 60000)
        )
          throw Error('quota_delayed');
        s.probeAt = r.now;
      } else {
        if (s.remaining - r.cost < Math.ceil(s.limit * 0.2)) throw Error('quota_delayed');
        const paced = Math.min(
          s.allocation,
          16 +
            Math.floor(
              (s.allocation * Math.max(0, r.now - s.epochStart)) /
                Math.max(1, s.resetAt - s.epochStart),
            ),
        );
        if (r.background && s.spent + r.cost > paced) throw Error('quota_delayed');
        if (r.background) s.spent += r.cost;
        s.remaining -= r.cost;
      }
      s.charged++;
      this.save(r.principalId, s);
      const expiresAt = r.now + 20000;
      this.db
        .prepare('INSERT INTO github_read_reservations VALUES (?,?,?,?,?,?,?,0)')
        .run(r.requestId, r.principalId, r.connectionId, fingerprint, r.cost, r.now, expiresAt);
      return { id: r.requestId, expiresAt };
    })();
  }
  finish(id: string) {
    this.db.prepare('UPDATE github_read_reservations SET finished=1 WHERE id=?').run(id);
  }
}
