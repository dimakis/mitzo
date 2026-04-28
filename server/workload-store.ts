import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { createLogger } from './logger.js';

const log = createLogger('workload-store');

// --- Types ---

export type TodoStatus = 'active' | 'acknowledged' | 'snoozed' | 'completed';

export interface ContextHints {
  repos: string[];
  paths: string[];
  issues: string[];
  docIds: string[];
  people: string[];
  jiraKeys: string[];
  keywords: string[];
  taskHint: string;
}

export interface TodoSource {
  id: string;
  itemId: string;
  sourceType: string;
  sourceId: string;
  url: string;
  title: string;
  author: string;
  timestamp: number;
  snippet: string;
}

export interface TodoItem {
  id: string;
  title: string;
  snippet: string | null;
  status: TodoStatus;
  profile: string;
  urgency: number;
  starred: boolean;
  snoozedUntil: string | null;
  contextHints: ContextHints;
  clusterId: string | null;
  goalId: string | null;
  sources: TodoSource[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkSignal {
  sourceType: string;
  sourceId: string;
  url: string;
  title: string;
  snippet: string;
  author: string;
  timestamp: string; // ISO 8601
  contextHints?: Partial<ContextHints>;
  urgencyHint?: number;
  profile?: string;
}

export interface TodoItemUpdateInput {
  title?: string;
  status?: TodoStatus;
  starred?: boolean;
  snoozedUntil?: string | null;
  urgency?: number;
  contextHints?: Partial<ContextHints>;
}

// --- DB row types ---

interface TodoItemRow {
  id: string;
  title: string;
  snippet: string | null;
  status: string;
  profile: string;
  urgency: number;
  starred: number;
  snoozed_until: string | null;
  context_hints: string | null;
  cluster_id: string | null;
  goal_id: string | null;
  created_at: number;
  updated_at: number;
}

interface TodoSourceRow {
  id: string;
  item_id: string;
  source_type: string;
  source_id: string;
  url: string;
  title: string;
  author: string;
  timestamp: number;
  snippet: string | null;
}

// --- Schema ---

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS todo_items (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    snippet         TEXT,
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK(status IN ('active','acknowledged','snoozed','completed')),
    profile         TEXT NOT NULL DEFAULT 'default',
    urgency         REAL NOT NULL DEFAULT 0.0,
    starred         INTEGER NOT NULL DEFAULT 0,
    snoozed_until   TEXT,
    context_hints   TEXT,
    cluster_id      TEXT,
    goal_id         TEXT,
    created_at      REAL NOT NULL,
    updated_at      REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS todo_sources (
    id              TEXT PRIMARY KEY,
    item_id         TEXT NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
    source_type     TEXT NOT NULL,
    source_id       TEXT NOT NULL,
    url             TEXT NOT NULL,
    title           TEXT NOT NULL,
    author          TEXT NOT NULL,
    timestamp       REAL NOT NULL,
    snippet         TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_todo_profile ON todo_items(profile);
  CREATE INDEX IF NOT EXISTS idx_todo_status ON todo_items(status);
  CREATE INDEX IF NOT EXISTS idx_todo_sources_item ON todo_sources(item_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_todo_sources_dedup ON todo_sources(source_type, source_id);
`;

// --- Helpers ---

/** Sentinel for missing context hints. Frozen to prevent accidental mutation via shallow copies. */
const EMPTY_HINTS: ContextHints = Object.freeze({
  repos: [],
  paths: [],
  issues: [],
  docIds: [],
  people: [],
  jiraKeys: [],
  keywords: [],
  taskHint: '',
}) as ContextHints;

function parseContextHints(raw: string | null): ContextHints {
  if (!raw) return { ...EMPTY_HINTS };
  try {
    const parsed = JSON.parse(raw);
    return { ...EMPTY_HINTS, ...parsed };
  } catch {
    return { ...EMPTY_HINTS };
  }
}

function mergeContextHints(existing: ContextHints, incoming: Partial<ContextHints>): ContextHints {
  const dedup = (a: string[], b: string[] | undefined) => [...new Set([...a, ...(b ?? [])])];
  return {
    repos: dedup(existing.repos, incoming.repos),
    paths: dedup(existing.paths, incoming.paths),
    issues: dedup(existing.issues, incoming.issues),
    docIds: dedup(existing.docIds, incoming.docIds),
    people: dedup(existing.people, incoming.people),
    jiraKeys: dedup(existing.jiraKeys, incoming.jiraKeys),
    keywords: dedup(existing.keywords, incoming.keywords),
    taskHint: incoming.taskHint || existing.taskHint,
  };
}

function rowToItem(row: TodoItemRow, sources: TodoSource[]): TodoItem {
  return {
    id: row.id,
    title: row.title,
    snippet: row.snippet,
    status: row.status as TodoStatus,
    profile: row.profile,
    urgency: row.urgency,
    starred: row.starred === 1,
    snoozedUntil: row.snoozed_until,
    contextHints: parseContextHints(row.context_hints),
    clusterId: row.cluster_id,
    goalId: row.goal_id,
    sources,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSource(row: TodoSourceRow): TodoSource {
  return {
    id: row.id,
    itemId: row.item_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    url: row.url,
    title: row.title,
    author: row.author,
    timestamp: row.timestamp,
    snippet: row.snippet ?? '',
  };
}

// --- Scoring ---

function computeUrgency(signal: WorkSignal): number {
  const base = signal.urgencyHint ?? 0.3;
  const ageMs = Date.now() - new Date(signal.timestamp).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const ageBoost = ageDays > 7 ? 0.1 : 0;
  return Math.min(1.0, base + ageBoost);
}

// --- Store ---

export class WorkloadStore {
  private db: Database.Database | null;

  constructor(db: Database.Database) {
    this.db = db;
    db.exec(SCHEMA);
    log.info('WorkloadStore initialized (shared DB)');
  }

  close(): void {
    // Don't close — DB is shared with TaskStore
    this.db = null;
  }

  private getDb(): Database.Database {
    if (!this.db) throw new Error('WorkloadStore is closed');
    return this.db;
  }

  /**
   * Ingest a WorkSignal. Deduplicates by (sourceType, sourceId).
   * - New source: creates a new item + source.
   * - Existing source: updates timestamp, returns existing item.
   */
  ingest(signal: WorkSignal): { item: TodoItem; created: boolean } {
    const db = this.getDb();
    const now = Date.now();
    const signalTs = new Date(signal.timestamp).getTime();

    // Validate timestamp format
    if (isNaN(signalTs)) {
      throw new Error(`Invalid timestamp format: ${signal.timestamp}`);
    }

    // Check if this exact source already exists
    const existingSource = db
      .prepare('SELECT * FROM todo_sources WHERE source_type = ? AND source_id = ?')
      .get(signal.sourceType, signal.sourceId) as TodoSourceRow | undefined;

    if (existingSource) {
      // Source exists — update timestamp, return existing item
      db.prepare('UPDATE todo_sources SET timestamp = ? WHERE id = ?').run(
        signalTs,
        existingSource.id,
      );
      db.prepare('UPDATE todo_items SET updated_at = ? WHERE id = ?').run(
        now,
        existingSource.item_id,
      );
      return { item: this.get(existingSource.item_id)!, created: false };
    }

    // New source — create a new item
    const profile = signal.profile ?? 'default';
    const itemId = randomUUID();
    const hints = signal.contextHints
      ? mergeContextHints({ ...EMPTY_HINTS }, signal.contextHints)
      : { ...EMPTY_HINTS };

    db.prepare(
      `INSERT INTO todo_items (id, title, snippet, status, profile, urgency, starred, context_hints, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, 0, ?, ?, ?)`,
    ).run(
      itemId,
      signal.title,
      signal.snippet || null,
      profile,
      computeUrgency(signal),
      JSON.stringify(hints),
      now,
      now,
    );

    // Create source
    const sourceId = randomUUID();
    db.prepare(
      `INSERT INTO todo_sources (id, item_id, source_type, source_id, url, title, author, timestamp, snippet)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sourceId,
      itemId,
      signal.sourceType,
      signal.sourceId,
      signal.url,
      signal.title,
      signal.author,
      signalTs,
      signal.snippet || null,
    );

    log.info('Ingested new work signal', {
      itemId,
      sourceType: signal.sourceType,
      sourceId: signal.sourceId,
      profile,
    });

    return { item: this.get(itemId)!, created: true };
  }

  /**
   * Ingest multiple signals in a single transaction.
   */
  ingestBatch(signals: WorkSignal[]): { items: TodoItem[]; created: number } {
    const db = this.getDb();
    const results: TodoItem[] = [];
    let created = 0;

    const tx = db.transaction(() => {
      for (const signal of signals) {
        const result = this.ingest(signal);
        results.push(result.item);
        if (result.created) created++;
      }
    });

    tx();
    return { items: results, created };
  }

  get(id: string): TodoItem | null {
    const row = this.getDb().prepare('SELECT * FROM todo_items WHERE id = ?').get(id) as
      | TodoItemRow
      | undefined;
    if (!row) return null;

    const sourceRows = this.getDb()
      .prepare('SELECT * FROM todo_sources WHERE item_id = ? ORDER BY timestamp DESC')
      .all(id) as TodoSourceRow[];

    return rowToItem(row, sourceRows.map(rowToSource));
  }

  list(options?: { profile?: string; status?: TodoStatus; starred?: boolean }): TodoItem[] {
    const db = this.getDb();
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (options?.profile) {
      conditions.push('profile = ?');
      values.push(options.profile);
    }
    if (options?.status) {
      conditions.push('status = ?');
      values.push(options.status);
    }
    if (options?.starred !== undefined) {
      conditions.push('starred = ?');
      values.push(options.starred ? 1 : 0);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = db
      .prepare(
        `SELECT * FROM todo_items ${where} ORDER BY starred DESC, urgency DESC, created_at ASC`,
      )
      .all(...values) as TodoItemRow[];

    // Batch-load sources for all items
    const itemIds = rows.map((r) => r.id);
    const sourceMap = this.loadSourcesForItems(itemIds);

    return rows.map((row) => rowToItem(row, sourceMap.get(row.id) ?? []));
  }

  update(id: string, fields: TodoItemUpdateInput): TodoItem | null {
    const existing = this.get(id);
    if (!existing) return null;

    const sets: string[] = [];
    const values: unknown[] = [];

    if (fields.title !== undefined) {
      sets.push('title = ?');
      values.push(fields.title);
    }
    if (fields.status !== undefined) {
      sets.push('status = ?');
      values.push(fields.status);
    }
    if (fields.starred !== undefined) {
      sets.push('starred = ?');
      values.push(fields.starred ? 1 : 0);
    }
    if (fields.snoozedUntil !== undefined) {
      sets.push('snoozed_until = ?');
      values.push(fields.snoozedUntil);
      if (fields.snoozedUntil && fields.status === undefined) {
        sets.push('status = ?');
        values.push('snoozed');
      }
    }
    if (fields.urgency !== undefined) {
      sets.push('urgency = ?');
      values.push(fields.urgency);
    }
    if (fields.contextHints !== undefined) {
      const merged = mergeContextHints(existing.contextHints, fields.contextHints);
      sets.push('context_hints = ?');
      values.push(JSON.stringify(merged));
    }

    if (sets.length === 0) return existing;

    sets.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);

    this.getDb()
      .prepare(`UPDATE todo_items SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values);

    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.getDb().prepare('DELETE FROM todo_items WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /**
   * Link a todo item to a task board goal (root task).
   */
  setGoalId(itemId: string, goalId: string): TodoItem | null {
    const db = this.getDb();
    db.prepare('UPDATE todo_items SET goal_id = ?, status = ?, updated_at = ? WHERE id = ?').run(
      goalId,
      'acknowledged',
      Date.now(),
      itemId,
    );
    return this.get(itemId);
  }

  /**
   * Complete items linked to a completed goal.
   */
  completeByGoal(goalId: string): void {
    this.getDb()
      .prepare(
        "UPDATE todo_items SET status = 'completed', updated_at = ? WHERE goal_id = ? AND status != 'completed'",
      )
      .run(Date.now(), goalId);
  }

  /**
   * Unsnooze items whose snooze period has expired.
   */
  unsnoozeDue(): number {
    const today = new Date().toISOString().slice(0, 10);
    const result = this.getDb()
      .prepare(
        "UPDATE todo_items SET status = 'active', snoozed_until = NULL, updated_at = ? WHERE status = 'snoozed' AND snoozed_until <= ?",
      )
      .run(Date.now(), today);
    return result.changes;
  }

  /**
   * Get profiles with item counts.
   */
  profiles(): { profile: string; count: number }[] {
    return this.getDb()
      .prepare(
        "SELECT profile, COUNT(*) as count FROM todo_items WHERE status != 'completed' GROUP BY profile ORDER BY count DESC",
      )
      .all() as { profile: string; count: number }[];
  }

  private loadSourcesForItems(itemIds: string[]): Map<string, TodoSource[]> {
    if (itemIds.length === 0) return new Map();

    const db = this.getDb();
    const placeholders = itemIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT * FROM todo_sources WHERE item_id IN (${placeholders}) ORDER BY timestamp DESC`,
      )
      .all(...itemIds) as TodoSourceRow[];

    const map = new Map<string, TodoSource[]>();
    for (const row of rows) {
      const sources = map.get(row.item_id) ?? [];
      sources.push(rowToSource(row));
      map.set(row.item_id, sources);
    }
    return map;
  }
}
