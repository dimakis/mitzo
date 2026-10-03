import Database from 'better-sqlite3';
import { NotificationPreferences } from '@mitzo/protocol';
import type {
  MitzoNotification,
  NotificationFilter,
  NotificationResolution,
} from '@mitzo/protocol';

type Input = Omit<MitzoNotification, 'createdAt' | 'readAt' | 'resolvedAt' | 'resolution'>;
interface Row {
  data: string;
  read_at: number | null;
  resolved_at: number | null;
  resolution: NotificationResolution | null;
}
function item(row: Row): MitzoNotification {
  return {
    ...JSON.parse(row.data),
    readAt: row.read_at,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
  };
}
/** Local-authoritative shared state; read receipts never grant or resolve permissions. */
export class NotificationStore {
  private db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, perm_id TEXT, created_at INTEGER NOT NULL,
      expires_at INTEGER, data TEXT NOT NULL, read_at INTEGER, resolved_at INTEGER, resolution TEXT,
      delivery_at INTEGER, delivery_status TEXT, delivery_attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS notifications_created ON notifications(created_at DESC, id);
    CREATE TABLE IF NOT EXISTS notification_preferences (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);`);
  }
  record(input: Input, now = Date.now()): boolean {
    const data = { ...input, createdAt: now };
    return (
      this.db
        .prepare(
          'INSERT OR IGNORE INTO notifications (id, kind, perm_id, created_at, expires_at, data) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          input.id,
          input.kind,
          input.permId ?? null,
          now,
          input.expiresAt ?? null,
          JSON.stringify(data),
        ).changes > 0
    );
  }
  get(id: string): MitzoNotification | undefined {
    const row = this.db.prepare('SELECT * FROM notifications WHERE id=?').get(id) as
      Row | undefined;
    return row ? item(row) : undefined;
  }
  expire(now = Date.now()): number {
    return this.db
      .prepare(
        "UPDATE notifications SET resolved_at=?, resolution='expired', delivery_status='cancelled' WHERE perm_id IS NOT NULL AND resolved_at IS NULL AND expires_at <= ?",
      )
      .run(now, now).changes;
  }
  reconcilePermissions(isLive: (id: string) => boolean, now = Date.now()): number {
    let count = this.expire(now);
    const rows = this.db
      .prepare(
        'SELECT perm_id FROM notifications WHERE perm_id IS NOT NULL AND resolved_at IS NULL',
      )
      .all() as { perm_id: string }[];
    for (const row of rows)
      if (!isLive(row.perm_id)) count += this.resolvePermission(row.perm_id, 'expired', now);
    return count;
  }
  resolvePermission(permId: string, resolution: NotificationResolution, now = Date.now()): number {
    return this.db
      .prepare(
        "UPDATE notifications SET resolved_at=?, resolution=?, delivery_status='cancelled' WHERE perm_id=? AND resolved_at IS NULL",
      )
      .run(now, resolution, permId).changes;
  }
  markRead(id: string, now = Date.now()): boolean {
    return (
      this.db
        .prepare('UPDATE notifications SET read_at=COALESCE(read_at, ?) WHERE id=?')
        .run(now, id).changes > 0
    );
  }
  markUpdatesRead(now = Date.now()): void {
    this.db
      .prepare(
        "UPDATE notifications SET read_at=COALESCE(read_at, ?) WHERE kind NOT IN ('approval','question')",
      )
      .run(now);
  }
  feed(filter: NotificationFilter = 'all', now = Date.now(), limit = 100, offset = 0) {
    this.expire(now);
    const where =
      filter === 'needs'
        ? "kind IN ('approval','question') AND resolved_at IS NULL"
        : filter === 'sessions'
          ? "kind='session'"
          : filter === 'updates'
            ? "kind IN ('update','test')"
            : filter === 'history'
              ? 'resolved_at IS NOT NULL'
              : '1=1';
    const items = (
      this.db
        .prepare(
          `SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
        )
        .all(Math.min(100, Math.max(1, limit)), Math.max(0, offset)) as Row[]
    ).map(item);
    const needsYou = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM notifications WHERE kind IN ('approval','question') AND resolved_at IS NULL",
        )
        .get() as { n: number }
    ).n;
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE ${where}`).get() as {
        n: number;
      }
    ).n;
    return { items, needsYou, total };
  }
  preferences(): NotificationPreferences {
    const row = this.db.prepare('SELECT data FROM notification_preferences WHERE id=1').get() as
      { data: string } | undefined;
    return NotificationPreferences.parse(row ? JSON.parse(row.data) : {});
  }
  setPreferences(patch: Partial<NotificationPreferences>): NotificationPreferences {
    const prefs = NotificationPreferences.parse({ ...this.preferences(), ...patch });
    this.db
      .prepare('INSERT OR REPLACE INTO notification_preferences (id,data) VALUES (1,?)')
      .run(JSON.stringify(prefs));
    return prefs;
  }
  queue(id: string, at: number): void {
    this.db
      .prepare(
        "UPDATE notifications SET delivery_at=?, delivery_status='queued' WHERE id=? AND delivery_status IS NULL",
      )
      .run(at, id);
  }
  due(now = Date.now()): MitzoNotification[] {
    this.expire(now);
    return (
      this.db
        .prepare(
          "SELECT * FROM notifications WHERE delivery_status='queued' AND delivery_at<=? AND resolved_at IS NULL ORDER BY delivery_at LIMIT 25",
        )
        .all(now) as Row[]
    ).map(item);
  }
  delivery(id: string, status: 'accepted' | 'failed' | 'cancelled', retryAt?: number): void {
    this.db
      .prepare(
        'UPDATE notifications SET delivery_status=?, delivery_attempts=delivery_attempts+1, delivery_at=COALESCE(?,delivery_at) WHERE id=?',
      )
      .run(retryAt ? 'queued' : status, retryAt ?? null, id);
  }
  attempts(id: string): number {
    return (
      (
        this.db.prepare('SELECT delivery_attempts AS n FROM notifications WHERE id=?').get(id) as
          { n: number } | undefined
      )?.n ?? 0
    );
  }
  close(): void {
    this.db.close();
  }
}
