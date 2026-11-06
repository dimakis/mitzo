import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { z } from 'zod';
import {
  openTelosOwnedDatabase,
  type TelosOwnedDatabase,
} from '@mitzo/protocol/telos-sqlite-owners';
import {
  TelosOutcomeCreateBodySchema,
  TelosOutcomeContextHintsSchema,
  TelosOutcomeLinkSchema,
} from '@mitzo/protocol';
import { TodoActionBody, TodoCreateBody } from './api-schemas.js';
import { projectTelosWorkRecord } from './telos-work-record.js';
import { dueTelosSnoozeIds, renewDueTelosSnoozes } from './telos-snooze.js';
import { TelosWorkError } from './telos-work-store.js';

const source = z.strictObject({
  type: z.string().min(1).max(100),
  sourceId: z.string().min(1).max(300),
  url: z.string().max(4000),
  title: z.string().max(20000),
  author: z.string().max(500),
  timestamp: z.string().min(1).max(100),
  rawSnippet: z.string().max(50000).default(''),
});
export const TelosImportBody = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
        summary: z.string().min(1).max(20000),
        profile: z.string().min(1).max(100),
        parentId: z.string().nullable().optional(),
        urgency: z.number().min(0).max(1).default(0),
        sources: z.array(source).max(100),
        priority: z.number().int().min(1).max(10).default(5),
        categories: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
        firstSeen: z.iso.datetime({ offset: true }).optional(),
        contextHints: TelosOutcomeContextHintsSchema.optional(),
        links: z.array(TelosOutcomeLinkSchema).max(100).default([]),
      }),
    )
    .max(500),
});
type Row = Record<string, unknown> & { id: string; parent_id: string | null };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function storedHints(hints: z.output<typeof TelosOutcomeContextHintsSchema> | undefined) {
  return JSON.stringify({
    repos: hints?.repos ?? [],
    paths: hints?.paths ?? [],
    issues: hints?.issues ?? [],
    doc_ids: hints?.docIds ?? [],
    people: hints?.people ?? [],
    jira_keys: hints?.jiraKeys ?? [],
    keywords: hints?.keywords ?? [],
    task_hint: hints?.taskHint ?? '',
    session_ids: hints?.sessionIds ?? [],
  });
}
function assertSync(assertion: () => void) {
  const result: unknown = assertion();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    throw Error('Synchronous current Telos authority required');
  }
}

/** Mitzo owns this schema. MGMT source import has no access to authored fields. */
export function initializeTelosRuntimeSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, summary TEXT NOT NULL, intent TEXT DEFAULT '', rationale TEXT DEFAULT '',
      acceptance_criteria TEXT DEFAULT '[]', idempotency_key TEXT, profile TEXT NOT NULL,
      cluster_id TEXT, urgency REAL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 5
      CHECK(typeof(priority)='integer' AND priority BETWEEN 1 AND 10), categories TEXT NOT NULL DEFAULT '[]',
      starred INTEGER DEFAULT 0, status TEXT DEFAULT 'active', snoozed_until TEXT,
      context_hints TEXT DEFAULT '{}', first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      parent_id TEXT REFERENCES items(id) ON DELETE CASCADE, goal_id TEXT);
    CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id)
      ON DELETE CASCADE, type TEXT NOT NULL, source_id TEXT NOT NULL, url TEXT NOT NULL,
      title TEXT NOT NULL, author TEXT NOT NULL, timestamp TEXT NOT NULL, raw_snippet TEXT DEFAULT '');
    CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id)
      ON DELETE CASCADE, type TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, old_status TEXT,
      new_status TEXT NOT NULL, changed_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_items_profile ON items(profile);
    CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
    CREATE INDEX IF NOT EXISTS idx_sources_item ON sources(item_id);
    CREATE INDEX IF NOT EXISTS idx_links_item ON links(item_id);
    CREATE TABLE IF NOT EXISTS telos_runtime_creation_receipts (
      idempotency_key TEXT PRIMARY KEY, input_hash TEXT NOT NULL, receipt TEXT NOT NULL);
  `);
  const columns = new Set(
    (db.pragma('table_info(items)') as Array<{ name: string }>).map((c) => c.name),
  );
  // Transferred older installations can predate structured outcomes and priority.
  // Add their columns before indexes or native readers reference them.
  const additions = {
    intent: "TEXT DEFAULT ''",
    rationale: "TEXT DEFAULT ''",
    acceptance_criteria: "TEXT DEFAULT '[]'",
    idempotency_key: 'TEXT',
    priority: 'INTEGER NOT NULL DEFAULT 5',
    categories: "TEXT NOT NULL DEFAULT '[]'",
    parent_id: 'TEXT REFERENCES items(id) ON DELETE CASCADE',
    goal_id: 'TEXT',
  };
  for (const [column, definition] of Object.entries(additions))
    if (!columns.has(column)) db.exec(`ALTER TABLE items ADD COLUMN ${column} ${definition}`);
  if (!columns.has('priority')) db.exec('UPDATE items SET priority=10 WHERE starred=1');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_items_idempotency_key ON items(idempotency_key)
      WHERE idempotency_key IS NOT NULL;`);
}

export class TelosRuntimeStore {
  private owner: TelosOwnedDatabase;
  private db: Database.Database;
  static initialize(path: string) {
    // Explicit fresh initialization refuses existing databases and symlinks.
    closeSync(openSync(path, 'wx', 0o600));
    const db = new Database(path, { fileMustExist: true });
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.transaction(() => initializeTelosRuntimeSchema(db)).immediate();
    } finally {
      db.close();
    }
  }
  constructor(path: string) {
    this.owner = openTelosOwnedDatabase('canonical', path, { fileMustExist: true });
    this.db = this.owner.database;
    try {
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('foreign_keys = ON');
      this.db.prepare('SELECT id,summary,priority,categories FROM items LIMIT 1').get();
      this.owner.seal();
    } catch (error) {
      this.owner.close();
      throw error;
    }
  }
  close() {
    this.owner.close();
  }
  private history(id: string, old: string | null, status: string, now: string) {
    this.db
      .prepare('INSERT INTO history(item_id,old_status,new_status,changed_at) VALUES(?,?,?,?)')
      .run(id, old, status, now);
  }
  private insert(
    summary: string,
    profile: string,
    parent: string | null,
    now: string,
    id: string = randomUUID(),
  ) {
    if (parent && !this.db.prepare('SELECT 1 FROM items WHERE id=?').get(parent))
      throw new TelosWorkError('not_found', 'Telos parent not found');
    this.db
      .prepare(
        `INSERT INTO items(id,summary,profile,parent_id,first_seen,last_seen,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(id, summary, profile, parent, now, now, now, now);
    this.history(id, null, 'active', now);
    return id;
  }
  private project(rows: Row[]) {
    const ids = JSON.stringify(rows.map((r) => r.id));
    const evidence = (table: 'sources' | 'links') =>
      this.db
        .prepare(
          `SELECT * FROM ${table} WHERE item_id IN (SELECT value FROM json_each(?)) ORDER BY rowid`,
        )
        .all(ids) as Array<Record<string, unknown>>;
    const sources = evidence('sources'),
      links = evidence('links');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const entries = rows.map((row) => {
      const record = projectTelosWorkRecord(
        row,
        sources.filter((s) => s.item_id === row.id),
        links.filter((s) => s.item_id === row.id),
        null,
      );
      const first = new Date(String(row.first_seen));
      first.setHours(0, 0, 0, 0);
      const ageDays = Math.round((today.getTime() - first.getTime()) / 86400000);
      const hints = record.contextHints;
      const score =
        Number(row.urgency) +
        Math.min(1, ageDays / 14) * 0.1 +
        Math.min(0.3, Math.max(0, record.sources.length - 1) * 0.15) +
        Math.min(0.2, (hints.jiraKeys.length + hints.docIds.length + hints.people.length) * 0.05) +
        (hints.sessionIds.length ? 0.1 : 0);
      return {
        id: row.id,
        summary: record.summary,
        intent: record.intent,
        rationale: record.rationale,
        acceptanceCriteria: record.acceptanceCriteria,
        profile: record.profile,
        urgency: Number(row.urgency),
        priority: record.priority,
        categories: record.categories,
        starred: record.starred,
        status: record.status,
        ageDays,
        rankScore: Math.round(Math.min(2, score) * 1000) / 1000,
        parentId: record.parentId,
        children: [] as Array<unknown>,
        childCount: 0,
        completedChildCount: 0,
        sources: record.sources.map((s) => ({
          type: s.type,
          url: s.url,
          title: s.title,
          author: s.author ?? '',
          snippet: s.rawSnippet.slice(0, 200),
        })),
        links: record.links.map((l) => ({
          type: l.type,
          url: l.url,
          title: l.title,
          description: l.description,
        })),
        contextHints: hints,
        goalId: row.goal_id ?? null,
      };
    });
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const roots: typeof entries = [];
    for (const entry of entries) {
      const parent = entry.parentId && byId.get(entry.parentId);
      if (parent) {
        parent.children.push(entry);
        parent.childCount++;
        if (entry.status === 'completed') parent.completedChildCount++;
      } else roots.push(entry);
    }
    return roots;
  }
  list(profile?: string, all = false) {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare('SELECT * FROM items ORDER BY starred DESC,urgency DESC,first_seen, rowid')
        .all() as Row[];
      // Most reads need no writer. Snooze renewal uses its own immediate transaction.
      const selected = rows.filter((r) => !profile || r.profile === profile);
      if (!all) {
        const visible = new Set(
          selected
            .filter((r) => ['active', 'acknowledged'].includes(String(r.status)))
            .map((r) => r.id),
        );
        let changed = true;
        while (changed) {
          changed = false;
          for (const row of selected) {
            if (
              row.status === 'completed' &&
              row.parent_id &&
              visible.has(row.parent_id) &&
              !visible.has(row.id)
            ) {
              visible.add(row.id);
              changed = true;
            }
          }
        }
        return {
          profiles: [...new Set(rows.map((r) => String(r.profile)))].sort(),
          items: this.project(selected.filter((r) => visible.has(r.id))),
        };
      }
      return {
        profiles: [...new Set(rows.map((r) => String(r.profile)))].sort(),
        items: this.project(selected),
      };
    })();
  }
  renewSnoozes() {
    const now = new Date();
    const rows = this.db
      .prepare("SELECT id,status,snoozed_until FROM items WHERE status='snoozed'")
      .all() as Row[];
    if (!dueTelosSnoozeIds(rows, now).length) return;
    // The shared owner rechecks status/date in its conditional SQL after the lock.
    this.db.transaction(() => renewDueTelosSnoozes(this.db, rows, () => {}, now)).immediate();
  }
  create(raw: unknown) {
    const input = TodoCreateBody.parse(raw);
    return this.db
      .transaction(() => {
        const id = this.insert(
          input.summary,
          input.profile,
          input.parentId ?? null,
          new Date().toISOString(),
        );
        return {
          ok: true as const,
          item: this.project([this.db.prepare('SELECT * FROM items WHERE id=?').get(id) as Row])[0],
        };
      })
      .immediate();
  }
  createOutcome(raw: unknown, assertion: () => void) {
    const input = TelosOutcomeCreateBodySchema.parse(raw);
    return this.db
      .transaction(() => {
        assertSync(assertion);
        // Additive receipt schema is created only on a real creation writer.
        this.db.exec(`CREATE TABLE IF NOT EXISTS telos_runtime_creation_receipts (
        idempotency_key TEXT PRIMARY KEY,input_hash TEXT NOT NULL,receipt TEXT NOT NULL)`);
        const hash = digest(JSON.stringify(input));
        const previous = this.db
          .prepare('SELECT * FROM telos_runtime_creation_receipts WHERE idempotency_key=?')
          .get(input.idempotencyKey) as { input_hash: string; receipt: string } | undefined;
        if (previous) {
          if (previous.input_hash !== hash)
            throw new TelosWorkError('conflict', 'Creation identity reused with different input');
          return { ...JSON.parse(previous.receipt), created: false };
        }
        // A reviewed legacy creation may have committed before migration without its new receipt.
        const old = this.db
          .prepare('SELECT * FROM items WHERE idempotency_key=?')
          .get(input.idempotencyKey) as Row | undefined;
        if (old) {
          const children = this.db
            .prepare('SELECT * FROM items WHERE parent_id=? ORDER BY rowid')
            .all(old.id) as Row[];
          const item = this.project([old, ...children])[0];
          return { ok: true as const, created: false, item };
        }
        const now = new Date().toISOString();
        const id = this.insert(input.summary, input.profile, null, now);
        const hints = input.contextHints ?? {};
        const storedHints = {
          repos: hints.repos ?? [],
          paths: hints.paths ?? [],
          issues: hints.issues ?? [],
          doc_ids: hints.docIds ?? [],
          people: hints.people ?? [],
          jira_keys: hints.jiraKeys ?? [],
          keywords: hints.keywords ?? [],
          task_hint: hints.taskHint ?? '',
          session_ids: hints.sessionIds ?? [],
        };
        this.db
          .prepare(
            `UPDATE items SET intent=?,rationale=?,acceptance_criteria=?,idempotency_key=?,
        context_hints=?,starred=1,priority=10,urgency=1 WHERE id=?`,
          )
          .run(
            input.intent,
            input.rationale,
            JSON.stringify(input.acceptanceCriteria),
            input.idempotencyKey,
            JSON.stringify(storedHints),
            id,
          );
        for (const link of input.links ?? [])
          this.db
            .prepare(
              'INSERT INTO links(id,item_id,type,url,title,description,created_at) VALUES(?,?,?,?,?,?,?)',
            )
            .run(randomUUID(), id, link.type, link.url, link.title, link.description, now);
        for (const summary of input.milestones) this.insert(summary, input.profile, id, now);
        const rows = this.db
          .prepare('SELECT * FROM items WHERE id=? OR parent_id=? ORDER BY rowid')
          .all(id, id) as Row[];
        const receipt = { ok: true as const, created: true, item: this.project(rows)[0] };
        this.db
          .prepare('INSERT INTO telos_runtime_creation_receipts VALUES(?,?,?)')
          .run(input.idempotencyKey, hash, JSON.stringify(receipt));
        return receipt;
      })
      .immediate();
  }
  action(id: string, raw: unknown) {
    const input = TodoActionBody.parse(raw);
    return this.db
      .transaction(() => {
        const row = this.db.prepare('SELECT * FROM items WHERE id=?').get(id) as Row | undefined;
        if (!row) throw new TelosWorkError('not_found', 'Telos item not found');
        const now = new Date().toISOString();
        if (input.action === 'star' || input.action === 'unstar') {
          const starred = input.action === 'star' ? 1 : 0;
          this.db
            .prepare('UPDATE items SET starred=?,updated_at=? WHERE id=?')
            .run(starred, now, id);
        } else if (input.action === 'priority') {
          this.db
            .prepare('UPDATE items SET priority=?,updated_at=? WHERE id=?')
            .run(input.priority, now, id);
        } else {
          const status = { ack: 'acknowledged', done: 'completed', snooze: 'snoozed' }[
            input.action
          ];
          let until: string | null = null;
          if (input.action === 'snooze') {
            if (
              input.days !== undefined &&
              (!Number.isInteger(input.days) || input.days < 1 || input.days > 3650)
            )
              throw new TelosWorkError('invalid', 'Snooze days must be an integer from 1 to 3650');
            const day = new Date();
            day.setDate(day.getDate() + (input.days ?? 3));
            until = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
          }
          this.db
            .prepare('UPDATE items SET status=?,snoozed_until=?,updated_at=? WHERE id=?')
            .run(status, until, now, id);
          this.history(id, String(row.status), status, now);
        }
        return { ok: true as const };
      })
      .immediate();
  }
  importSources(raw: unknown) {
    const { items } = TelosImportBody.parse(raw);
    return this.db
      .transaction(() => {
        const now = new Date().toISOString();
        let created = 0;
        const pending = new Map(items.map((item) => [item.id, item]));
        while (pending.size) {
          let progress = false;
          for (const [id, item] of pending) {
            const existing = this.db.prepare('SELECT 1 FROM items WHERE id=?').get(id);
            if (
              !existing &&
              item.parentId &&
              !this.db.prepare('SELECT 1 FROM items WHERE id=?').get(item.parentId)
            )
              continue;
            if (!existing) {
              this.insert(item.summary, item.profile, item.parentId ?? null, now, id);
              this.db
                .prepare(
                  `UPDATE items SET priority=?,starred=?,categories=?,context_hints=?,
                first_seen=?,created_at=? WHERE id=?`,
                )
                .run(
                  item.priority,
                  item.priority === 10 ? 1 : 0,
                  JSON.stringify(item.categories),
                  storedHints(item.contextHints),
                  item.firstSeen ?? now,
                  item.firstSeen ?? now,
                  id,
                );
              for (const link of item.links)
                this.db
                  .prepare(
                    `INSERT INTO links
                (id,item_id,type,url,title,description,created_at) VALUES(?,?,?,?,?,?,?)`,
                  )
                  .run(randomUUID(), id, link.type, link.url, link.title, link.description, now);
              created++;
            }
            // Repeated source imports never replace authored briefs, structure or lifecycle.
            this.db
              .prepare('UPDATE items SET last_seen=?,urgency=? WHERE id=?')
              .run(now, item.urgency, id);
            for (const evidence of item.sources)
              this.db
                .prepare(
                  `INSERT INTO sources
            (id,item_id,type,source_id,url,title,author,timestamp,raw_snippet) VALUES(?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET url=excluded.url,title=excluded.title,author=excluded.author,
            timestamp=excluded.timestamp,raw_snippet=excluded.raw_snippet`,
                )
                .run(
                  digest(`${id}:${evidence.type}:${evidence.sourceId}`).slice(0, 16),
                  id,
                  evidence.type,
                  evidence.sourceId,
                  evidence.url,
                  evidence.title,
                  evidence.author,
                  evidence.timestamp,
                  evidence.rawSnippet,
                );
            pending.delete(id);
            progress = true;
          }
          if (!progress) throw new TelosWorkError('invalid', 'Import parent missing or cyclic');
        }
        return { ok: true as const, total: items.length, created };
      })
      .immediate();
  }
}
