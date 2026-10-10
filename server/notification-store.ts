import Database from 'better-sqlite3';
import { NotificationPreferences } from '@mitzo/protocol';
import type {
  MitzoNotification,
  NotificationFilter,
  NotificationResolution,
  InboxQuery,
} from '@mitzo/protocol';
const needs =
  "resolved_at IS NULL AND (kind IN ('approval','question') OR COALESCE(json_extract(data, '$.inbox.needsAttention'),0)=1)";

const visible = 'inbox_visible(data,inbox_source_path)=1';
type InboxReadPolicy = (filename: string, sourcePath?: string) => boolean;

type Input = Omit<
  MitzoNotification,
  'createdAt' | 'readAt' | 'resolvedAt' | 'resolution' | 'archivedAt'
>;
interface Row {
  data: string;
  read_at: number | null;
  resolved_at: number | null;
  resolution: NotificationResolution | null;
  archived_at: number | null;
}
function item(row: Row): MitzoNotification {
  return {
    ...JSON.parse(row.data),
    readAt: row.read_at,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
    archivedAt: row.archived_at,
  };
}
/** Local-authoritative shared state; read receipts never grant or resolve permissions. */
export class NotificationStore {
  private db: Database.Database;
  private inboxPolicyFactory?: () => InboxReadPolicy;
  private inboxPolicy?: InboxReadPolicy;
  setInboxReadPolicy(factory: () => InboxReadPolicy) {
    this.inboxPolicyFactory = factory;
  }
  private refreshInboxPolicy() {
    try {
      this.inboxPolicy = this.inboxPolicyFactory?.();
    } catch {
      this.inboxPolicy = () => false;
    }
  }
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, perm_id TEXT, created_at INTEGER NOT NULL,
      expires_at INTEGER, data TEXT NOT NULL, read_at INTEGER, resolved_at INTEGER, resolution TEXT,
      delivery_at INTEGER, delivery_status TEXT, delivery_attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS notifications_created ON notifications(created_at DESC, id);
    CREATE TABLE IF NOT EXISTS notification_preferences (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notification_delivered_devices (
      notification_id TEXT NOT NULL, device TEXT NOT NULL, PRIMARY KEY(notification_id, device)
    );`);
    const columns = this.db.pragma('table_info(notifications)') as { name: string }[];
    if (!columns.some((column) => column.name === 'archived_at'))
      this.db.exec('ALTER TABLE notifications ADD COLUMN archived_at INTEGER');
    if (!columns.some((column) => column.name === 'inbox_source_path'))
      this.db.exec('ALTER TABLE notifications ADD COLUMN inbox_source_path TEXT');
    this.db.function('inbox_visible', (data: string, source: string | null) => {
      try {
        const record = JSON.parse(data) as MitzoNotification;
        if (record.inboxFilename === undefined) return 1;
        if (typeof record.inboxFilename !== 'string') return 0;
        return this.inboxPolicy?.(record.inboxFilename, source ?? undefined) === false ? 0 : 1;
      } catch {
        return 0;
      }
    });
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
    this.refreshInboxPolicy();
    const row = this.db.prepare(`SELECT * FROM notifications WHERE id=? AND ${visible}`).get(id) as
      Row | undefined;
    return row ? item(row) : undefined;
  }
  syncInbox(input: Input, at: number, archived = false, sourcePath?: string): boolean {
    return this.db.transaction(() => this.syncInboxSource(input, at, archived, sourcePath))();
  }
  private syncInboxSource(
    input: Input,
    at: number,
    archived: boolean,
    sourcePath?: string,
  ): boolean {
    if (input.inbox)
      input = {
        ...input,
        inbox: { ...input.inbox, sourceArchived: archived, sourceUpdatedAt: at },
      };
    // Internal reconciliation can replace stale content with a newly verified public source.
    const oldRow = this.db.prepare('SELECT * FROM notifications WHERE id=?').get(input.id) as
      Row | undefined;
    const old = oldRow ? item(oldRow) : undefined;
    const provenanceChanged =
      sourcePath !== undefined &&
      this.db
        .prepare(
          'UPDATE notifications SET inbox_source_path=? WHERE id=? AND inbox_source_path IS NOT ?',
        )
        .run(sourcePath, input.id, sourcePath).changes > 0;
    if (!old) {
      this.record(input, at);
      if (sourcePath)
        this.db
          .prepare('UPDATE notifications SET inbox_source_path=? WHERE id=?')
          .run(sourcePath, input.id);
      if (archived)
        this.db
          .prepare("UPDATE notifications SET archived_at=?, delivery_status='cancelled' WHERE id=?")
          .run(at, input.id);
    } else {
      const data = JSON.stringify({ ...input, createdAt: old.createdAt });
      const previous = this.db
        .prepare('SELECT data FROM notifications WHERE id=?')
        .get(input.id) as { data: string };
      if (previous.data === data) return provenanceChanged;
      // Update provenance/content while preserving human read/archive state.
      const worse = old.inbox?.severity !== 'critical' && input.inbox?.severity === 'critical';
      const reopened = old.inbox?.status === 'resolved' && input.inbox?.status === 'pending';
      const freshCritical =
        input.inbox?.severity === 'critical' &&
        (old.inbox?.content !== input.inbox.content ||
          (old.inbox?.sourceUpdatedAt !== undefined && old.inbox.sourceUpdatedAt !== at));
      const renewed =
        !archived && !!input.inbox?.needsAttention && (worse || reopened || freshCritical);
      const archiveTransition = archived && old.inbox?.sourceArchived !== true;
      this.db
        .prepare(
          `UPDATE notifications SET data=?, read_at=CASE WHEN ? THEN NULL ELSE read_at END,
        resolved_at=CASE WHEN ? THEN NULL ELSE resolved_at END,
        archived_at=CASE WHEN ? THEN ? WHEN ? THEN NULL ELSE archived_at END,
        delivery_status=CASE WHEN ? THEN 'cancelled' ELSE delivery_status END WHERE id=?`,
        )
        .run(
          data,
          renewed ? 1 : 0,
          renewed ? 1 : 0,
          archiveTransition ? 1 : 0,
          at,
          renewed ? 1 : 0,
          archiveTransition ? 1 : 0,
          input.id,
        );
    }
    if (input.inbox?.status === 'resolved') this.resolveInbox(input.id);
    return true;
  }
  archiveMissingSource(id: string): boolean {
    const record = this.get(id);
    if (!record?.inbox || record.inbox.sourceArchived !== false) return false;
    const row = this.db.prepare('SELECT data FROM notifications WHERE id=?').get(id) as {
      data: string;
    };
    const data = JSON.parse(row.data) as Input & { createdAt: number };
    data.inbox = { ...data.inbox!, sourceArchived: true };
    this.db
      .prepare(
        "UPDATE notifications SET data=?, archived_at=COALESCE(archived_at, ?), delivery_status='cancelled' WHERE id=?",
      )
      .run(JSON.stringify(data), Date.now(), id);
    return true;
  }
  resolveInbox(id: string, now = Date.now()): boolean {
    return (
      this.db
        .prepare(
          `UPDATE notifications SET resolved_at=COALESCE(resolved_at, ?), delivery_status='cancelled'
      WHERE id=? AND json_extract(data, '$.inbox') IS NOT NULL`,
        )
        .run(now, id).changes > 0
    );
  }
  inboxFeed(query: InboxQuery, now = Date.now()) {
    this.refreshInboxPolicy();
    this.expire(now);
    const clauses: string[] = [
      query.view === 'archive' ? 'archived_at IS NOT NULL' : 'archived_at IS NULL',
      visible,
    ];
    const values: (string | number)[] = [];
    // Search intentionally crosses the named views while respecting refinements.
    if (!query.query.trim()) {
      if (query.view === 'needs') clauses.push(needs);
      if (query.view === 'briefings')
        clauses.push("json_extract(data, '$.inbox.category')='briefing'");
      if (query.view === 'proposals')
        clauses.push("json_extract(data, '$.inbox.category')='proposal'");
    } else {
      clauses.push('instr(lower(data), lower(?)) > 0');
      values.push(query.query.trim());
      // Search covers archived records too; the Archive view remains archive-only.
      if (query.view !== 'archive') clauses[0] = '1=1';
    }
    if (query.source) {
      clauses.push("json_extract(data, '$.inbox.agent')=?");
      values.push(query.source);
    }
    if (query.type === 'sessions') clauses.push("kind IN ('session','approval','question')");
    else if (query.type === 'updates') clauses.push("kind IN ('update','test')");
    else if (query.type === 'approval' || query.type === 'question') {
      clauses.push('kind=?');
      values.push(query.type);
    } else if (query.type) {
      clauses.push("json_extract(data, '$.inbox.category')=?");
      values.push(query.type);
    }
    if (query.status === 'unread') clauses.push('read_at IS NULL');
    if (query.status === 'resolved') clauses.push('resolved_at IS NOT NULL');
    if (query.age !== 'any') {
      const today = new Date(now);
      today.setHours(0, 0, 0, 0);
      const since =
        query.age === 'today' ? today.getTime() : now - (query.age === 'week' ? 7 : 30) * 86400000;
      clauses.push('created_at>=?');
      values.push(since);
    }
    const where = clauses.join(' AND ');
    const rows = this.db
      .prepare(
        `SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
      )
      .all(...values, query.limit, query.offset) as Row[];
    const items = rows.map((row) => {
      const record = item(row);
      if (record.inbox) {
        record.inbox = { ...record.inbox };
        delete record.inbox.content;
      }
      return record;
    });
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE ${where}`).get(...values) as {
        n: number;
      }
    ).n;
    const needsYou = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM notifications WHERE ${visible} AND archived_at IS NULL AND (${needs})`,
        )
        .get() as { n: number }
    ).n;
    const sources = (
      this.db
        .prepare(
          `SELECT DISTINCT json_extract(data, '$.inbox.agent') AS agent FROM notifications WHERE ${visible} AND json_extract(data, '$.inbox.agent') IS NOT NULL ORDER BY agent`,
        )
        .all() as { agent: string }[]
    ).map((r) => r.agent);
    return { items, needsYou, total, sources };
  }
  expire(now = Date.now()): number {
    return this.db
      .prepare(
        "UPDATE notifications SET resolved_at=?, resolution='expired', delivery_status='cancelled' WHERE (perm_id IS NOT NULL OR id LIKE 'seat-access:%') AND resolved_at IS NULL AND expires_at <= ?",
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
  resolveSessionNotice(
    id: string,
    sessionId: string,
    resolution: NotificationResolution,
    now = Date.now(),
  ): number {
    return this.db
      .prepare(
        "UPDATE notifications SET resolved_at=?, resolution=?, delivery_status='cancelled' WHERE id=? AND json_extract(data, '$.sessionId')=? AND perm_id IS NULL AND resolved_at IS NULL",
      )
      .run(now, resolution, id, sessionId).changes;
  }
  markRead(id: string, now = Date.now()): boolean {
    this.refreshInboxPolicy();
    return (
      this.db
        .prepare(`UPDATE notifications SET read_at=COALESCE(read_at, ?) WHERE id=? AND ${visible}`)
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
  archive(id: string, now = Date.now()): boolean {
    this.expire(now);
    return (
      this.db
        .prepare(
          `UPDATE notifications SET archived_at=COALESCE(archived_at, ?),
      delivery_status='cancelled' WHERE id=? AND
      NOT (${needs})`,
        )
        .run(now, id).changes > 0
    );
  }
  archiveResolved(now = Date.now()): number {
    this.expire(now);
    return this.db
      .prepare(
        `UPDATE notifications SET archived_at=?, delivery_status='cancelled'
      WHERE archived_at IS NULL AND NOT (${needs}) AND (resolved_at IS NOT NULL OR read_at IS NOT NULL)`,
      )
      .run(now).changes;
  }
  restore(id: string): boolean {
    this.refreshInboxPolicy();
    return (
      this.db.prepare(`UPDATE notifications SET archived_at=NULL WHERE id=? AND ${visible}`).run(id)
        .changes > 0
    );
  }
  feed(filter: NotificationFilter = 'all', now = Date.now(), limit = 100, offset = 0) {
    this.refreshInboxPolicy();
    this.expire(now);
    const category =
      filter === 'needs'
        ? needs
        : filter === 'sessions'
          ? "kind='session'"
          : filter === 'updates'
            ? "kind IN ('update','test')"
            : filter === 'history'
              ? 'resolved_at IS NOT NULL'
              : '1=1';
    const where = `${visible} AND (${filter === 'archived' ? 'archived_at IS NOT NULL' : `archived_at IS NULL AND (${category})`})`;
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
          `SELECT COUNT(*) AS n FROM notifications WHERE ${visible} AND (${needs}) AND archived_at IS NULL`,
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
    this.refreshInboxPolicy();
    this.expire(now);
    return (
      this.db
        .prepare(
          `SELECT * FROM notifications WHERE ${visible} AND delivery_status='queued' AND archived_at IS NULL AND delivery_at<=? AND resolved_at IS NULL ORDER BY delivery_at LIMIT 25`,
        )
        .all(now) as Row[]
    ).map(item);
  }
  deliveredDevices(id: string): string[] {
    return (
      this.db
        .prepare('SELECT device FROM notification_delivered_devices WHERE notification_id=?')
        .all(id) as { device: string }[]
    ).map((row) => row.device);
  }
  delivery(
    id: string,
    status: 'accepted' | 'failed' | 'cancelled',
    retryAt?: number,
    acceptedDevices: string[] = [],
  ): void {
    this.db.transaction(() => {
      const record = this.db.prepare(
        'INSERT OR IGNORE INTO notification_delivered_devices (notification_id, device) VALUES (?, ?)',
      );
      for (const device of acceptedDevices) record.run(id, device);
      this.db
        .prepare(
          'UPDATE notifications SET delivery_status=?, delivery_attempts=delivery_attempts+1, delivery_at=COALESCE(?,delivery_at) WHERE id=?',
        )
        .run(retryAt ? 'queued' : status, retryAt ?? null, id);
    })();
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
