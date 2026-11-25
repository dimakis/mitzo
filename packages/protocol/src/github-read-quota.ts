import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
export const GITHUB_QUOTA_RESERVATIONS = 4096;
const MAX_PRINCIPALS = 128;
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
   CREATE INDEX IF NOT EXISTS github_read_reservation_window ON github_read_reservations(principal_id,at);
   CREATE TABLE IF NOT EXISTS github_read_quota_control(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL,principal_id TEXT,probe_at INTEGER,unbound_charges INTEGER NOT NULL);
   INSERT OR IGNORE INTO github_read_quota_control VALUES(1,1,NULL,NULL,0);`);
    const columns = this.db.prepare('PRAGMA table_info(github_read_reservations)').all() as {
      name: string;
    }[];
    // Pre-migration receipts may already have dispatched. Never make them reusable.
    if (!columns.some((c) => c.name === 'started'))
      this.db.exec(
        'ALTER TABLE github_read_reservations ADD COLUMN started INTEGER NOT NULL DEFAULT 1',
      );
  }
  private control() {
    return this.db.prepare('SELECT * FROM github_read_quota_control WHERE id=1').get() as {
      epoch: number;
      principal_id: string | null;
      probe_at: number | null;
      unbound_charges: number;
    };
  }
  /** Only the trusted read owner mints request IDs. The epoch is part of the ID,
   * so changing a retry's time cannot turn a compacted receipt into fresh work. */
  requestId(now = Date.now()) {
    if (!Number.isSafeInteger(now) || now < 0) throw Error('invalid_quota_request');
    return this.db.transaction(() => {
      const n = this.reservationCount();
      if (n >= GITHUB_QUOTA_RESERVATIONS) {
        const removed = this.db
          .prepare('DELETE FROM github_read_reservations WHERE at<=? AND expires_at<=?')
          .run(now - 60000, now);
        if (n - removed.changes >= GITHUB_QUOTA_RESERVATIONS) throw Error('quota_retention_limit');
        this.db.prepare('UPDATE github_read_quota_control SET epoch=epoch+1 WHERE id=1').run();
      }
      return `q1:${this.control().epoch}:${randomUUID()}`;
    })();
  }
  private reservationCount() {
    return (
      this.db.prepare('SELECT count(*) n FROM github_read_reservations').get() as {
        n: number;
      }
    ).n;
  }
  private capacity(id: string) {
    const epoch = /^q1:([1-9][0-9]*):[^:]+$/.exec(id);
    if (!epoch || Number(epoch[1]) !== this.control().epoch)
      throw Error('reservation_epoch_expired');
    if (this.reservationCount() >= GITHUB_QUOTA_RESERVATIONS) throw Error('quota_retention_limit');
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
    const exists = this.db
      .prepare('SELECT 1 FROM github_read_quota WHERE principal_id=?')
      .get(principalId);
    const { n } = this.db.prepare('SELECT count(*) n FROM github_read_quota').get() as {
      n: number;
    };
    if (!exists && n >= MAX_PRINCIPALS) throw Error('quota_retention_limit');
    this.db
      .prepare(
        'INSERT INTO github_read_quota VALUES (?,?) ON CONFLICT(principal_id) DO UPDATE SET data=excluded.data',
      )
      .run(principalId, JSON.stringify(state));
  }
  observe(principalId: string, m: Metadata, now: number) {
    if (
      !/^github:[1-9][0-9]*$/.test(principalId) ||
      principalId.length > 200 ||
      ![m.limit, m.remaining, m.resetAt, now, m.retryAt ?? 0].every(Number.isSafeInteger) ||
      now < 0 ||
      m.limit < 1 ||
      m.remaining < 0 ||
      m.remaining > m.limit ||
      m.resetAt <= now
    )
      throw Error('invalid_quota_metadata');
    this.db.transaction(() => {
      const s = this.inspect(principalId);
      s.retryAt = Math.max(s.retryAt, m.retryAt ?? 0);
      if (s.resetAt === 0 || (now >= s.resetAt && m.resetAt > s.resetAt)) {
        s.limit = m.limit;
        s.remaining = m.remaining;
        s.resetAt = m.resetAt;
        s.epochStart = now;
        s.spent = 0;
        s.allocation = Math.max(0, Math.floor((m.remaining - Math.ceil(m.limit * 0.2)) / 2));
      } else {
        // Delayed responses and duplicated remaining headers cannot refill an epoch.
        if (m.resetAt !== s.resetAt) {
          this.save(principalId, s);
          return;
        }
        s.limit = Math.min(s.limit, m.limit);
        s.remaining = Math.min(s.remaining, m.remaining);
        s.allocation = Math.min(
          s.allocation,
          s.spent + Math.max(0, Math.floor((s.remaining - Math.ceil(s.limit * 0.2)) / 2)),
        );
      }
      s.observedAt = now;
      this.save(principalId, s);
    })();
  }
  reserve(r: Request) {
    if (
      ![r.requestId, r.principalId, r.connectionId].every(
        (v) => v && Buffer.byteLength(v) <= 200,
      ) ||
      !/^github:[1-9][0-9]*$/.test(r.principalId) ||
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
      this.capacity(r.requestId);
      const s = this.inspect(r.principalId);
      const window = this.db
        .prepare(
          'SELECT count(*) requests,COALESCE(sum(cost),0) points FROM github_read_reservations WHERE principal_id=? AND at>?',
        )
        .get(r.principalId, r.now - 60000) as {
        requests: number;
        points: number;
      };
      const active = this.active(r.connectionId, r.now);
      if (
        s.retryAt > r.now ||
        window.requests >= 60 ||
        window.points + r.cost > 120 ||
        active.total >= 4 ||
        active.connection >= 2
      )
        throw Error('quota_delayed');
      const fresh = s.resetAt > r.now && s.observedAt >= r.now - 60000;
      if (!fresh) {
        if (
          !r.probe ||
          r.cost !== 1 ||
          active.principal(r.principalId) ||
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
        .prepare('INSERT INTO github_read_reservations VALUES (?,?,?,?,?,?,?,0,0)')
        .run(r.requestId, r.principalId, r.connectionId, fingerprint, r.cost, r.now, expiresAt);
      return { id: r.requestId, expiresAt };
    })();
  }
  private active(connectionId: string, now: number) {
    const rows = this.db
      .prepare(
        'SELECT principal_id,connection_id FROM github_read_reservations WHERE finished=0 AND expires_at>?',
      )
      .all(now) as { principal_id: string; connection_id: string }[];
    return {
      total: rows.length,
      connection: rows.filter((r) => r.connection_id === connectionId).length,
      principal: (id: string) => rows.filter((r) => r.principal_id === id).length,
    };
  }
  /** A reservation is a receipt, not reusable permission to perform HTTP I/O. */
  start(id: string, now: number) {
    if (!Number.isSafeInteger(now) || now < 0) throw Error('invalid_quota_request');
    this.db.transaction(() => {
      const r = this.db
        .prepare('SELECT expires_at,started,finished FROM github_read_reservations WHERE id=?')
        .get(id) as { expires_at: number; started: number; finished: number } | undefined;
      if (!r || r.expires_at <= now) throw Error('reservation_expired');
      if (r.started || r.finished) throw Error('reservation_consumed');
      this.db.prepare('UPDATE github_read_reservations SET started=1 WHERE id=?').run(id);
    })();
  }
  /** The fixed trusted credential owner alone uses this escrow for initial /user.
   * No caller-selected principal or connection identity can attest an account. */
  reserveIdentity(requestId: string, connectionId: string, now: number, background = false) {
    if (
      ![requestId, connectionId].every((v) => v && Buffer.byteLength(v) <= 200) ||
      !Number.isSafeInteger(now) ||
      now < 0
    )
      throw Error('invalid_quota_request');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(['identity', connectionId, background]))
      .digest('hex');
    const old = this.db
      .prepare(
        'SELECT principal_id,fingerprint,expires_at FROM github_read_reservations WHERE id=?',
      )
      .get(requestId) as
      | {
          principal_id: string;
          fingerprint: string;
          expires_at: number;
        }
      | undefined;
    if (old?.fingerprint === fingerprint)
      return { id: requestId, expiresAt: old.expires_at, principalId: old.principal_id || null };
    if (old && !old.principal_id) throw Error('request_conflict');
    const principalId = old?.principal_id ?? this.control().principal_id;
    if (principalId)
      return {
        ...this.reserve({
          requestId,
          connectionId,
          principalId,
          background,
          cost: 1,
          now,
          probe: true,
        }),
        principalId,
      };
    return this.db.transaction(() => {
      this.capacity(requestId);
      const current = this.control();
      if (current.probe_at !== null && now - current.probe_at < 60000) throw Error('quota_delayed');
      const active = this.active(connectionId, now);
      if (active.total >= 4 || active.connection >= 2) throw Error('quota_delayed');
      const expiresAt = now + 20000;
      this.db
        .prepare('INSERT INTO github_read_reservations VALUES (?,?,?,?,?,?,?,0,0)')
        .run(requestId, '', connectionId, fingerprint, 1, now, expiresAt);
      this.db
        .prepare(
          'UPDATE github_read_quota_control SET probe_at=?,unbound_charges=unbound_charges+1 WHERE id=1',
        )
        .run(now);
      return { id: requestId, expiresAt, principalId: null };
    })();
  }
  attest(id: string, principalId: string) {
    if (!/^github:[1-9][0-9]*$/.test(principalId) || principalId.length > 200)
      throw Error('invalid_quota_principal');
    this.db.transaction(() => {
      const r = this.db
        .prepare('SELECT principal_id,started FROM github_read_reservations WHERE id=?')
        .get(id) as { principal_id: string; started: number } | undefined;
      if (!r?.started) throw Error('reservation_consumed');
      if (r.principal_id !== principalId) {
        const c = this.control(),
          s = this.inspect(principalId);
        const charge = r.principal_id ? 1 : c.unbound_charges;
        s.charged += charge;
        s.remaining = Math.max(0, s.remaining - charge);
        this.save(principalId, s);
        // Uncertain bootstrap failures remain charged, even if their receipts were compacted.
        this.db
          .prepare(
            "UPDATE github_read_reservations SET principal_id=? WHERE principal_id='' OR id=?",
          )
          .run(principalId, id);
        this.db.prepare('UPDATE github_read_quota_control SET unbound_charges=0 WHERE id=1').run();
      }
      this.db
        .prepare('UPDATE github_read_quota_control SET principal_id=? WHERE id=1')
        .run(principalId);
    })();
  }
  defer(principalId: string, retryAt: number, now: number) {
    if (!Number.isSafeInteger(retryAt) || retryAt < now) throw Error('invalid_quota_metadata');
    this.db.transaction(() => {
      const s = this.inspect(principalId);
      s.retryAt = Math.max(s.retryAt, retryAt);
      this.save(principalId, s);
    })();
  }
  deferIdentity(retryAt: number, now: number) {
    if (!Number.isSafeInteger(retryAt) || retryAt < now) throw Error('invalid_quota_metadata');
    // Escrow admits at most one unknown-identity probe per minute. Extending
    // that fence preserves Retry-After even before any numeric identity exists.
    this.db
      .prepare(
        'UPDATE github_read_quota_control SET probe_at=max(COALESCE(probe_at,0),?) WHERE id=1',
      )
      .run(retryAt - 60000);
  }
  finish(id: string) {
    this.db.prepare('UPDATE github_read_reservations SET finished=1 WHERE id=?').run(id);
  }
}
