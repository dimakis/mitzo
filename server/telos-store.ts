/** Readonly better-sqlite3 reader for Telos smart_todo.db. Writes stay in todo_api.py. */

import Database from 'better-sqlite3';
import { existsSync, readdirSync } from 'fs';
import { basename } from 'path';
import { createLogger } from './logger.js';

const log = createLogger('telos-store');

// --- Types ---

export interface TelosSource {
  type: string;
  url: string;
  title: string;
  author: string;
  snippet: string;
}

export interface TelosLink {
  type: string;
  url: string;
  title: string;
  description: string;
}

export interface TelosContextHints {
  repos: string[];
  paths: string[];
  issues: string[];
  docIds: string[];
  people: string[];
  jiraKeys: string[];
  keywords: string[];
  taskHint: string;
  sessionIds: string[];
}

export interface TelosItem {
  id: string;
  summary: string;
  profile: string;
  urgency: number;
  starred: boolean;
  status: 'active' | 'acknowledged' | 'snoozed' | 'completed';
  ageDays: number;
  parentId: string | null;
  children: TelosItem[];
  childCount: number;
  completedChildCount: number;
  sources: TelosSource[];
  links: TelosLink[];
  contextHints: TelosContextHints;
  goalId: string | null;
}

// --- DB row types ---

interface ItemRow {
  id: string;
  summary: string;
  profile: string;
  cluster_id: string | null;
  urgency: number;
  starred: number;
  status: string;
  snoozed_until: string | null;
  context_hints: string;
  first_seen: string;
  last_seen: string;
  created_at: string;
  updated_at: string;
  parent_id: string | null;
  goal_id: string | null;
}

interface SourceRow {
  id: string;
  item_id: string;
  type: string;
  source_id: string;
  url: string;
  title: string;
  author: string;
  timestamp: string;
  raw_snippet: string | null;
}

interface LinkRow {
  id: string;
  item_id: string;
  type: string;
  url: string;
  title: string;
  description: string | null;
}

// --- Helpers ---

function emptyHints(): TelosContextHints {
  return {
    repos: [],
    paths: [],
    issues: [],
    docIds: [],
    people: [],
    jiraKeys: [],
    keywords: [],
    taskHint: '',
    sessionIds: [],
  };
}

function parseContextHints(raw: string | null): TelosContextHints {
  if (!raw) return emptyHints();
  try {
    const d = JSON.parse(raw);
    return {
      repos: d.repos ?? [],
      paths: d.paths ?? [],
      issues: d.issues ?? [],
      docIds: d.doc_ids ?? [],
      people: d.people ?? [],
      jiraKeys: d.jira_keys ?? [],
      keywords: d.keywords ?? [],
      taskHint: d.task_hint ?? '',
      sessionIds: d.session_ids ?? [],
    };
  } catch {
    return emptyHints();
  }
}

function computeAgeDays(firstSeen: string): number {
  const d = new Date(firstSeen);
  if (isNaN(d.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24)));
}

function rowToSource(row: SourceRow): TelosSource {
  return {
    type: row.type,
    url: row.url,
    title: row.title,
    author: row.author,
    snippet: (row.raw_snippet ?? '').slice(0, 200),
  };
}

function rowToLink(row: LinkRow): TelosLink {
  return {
    type: row.type,
    url: row.url,
    title: row.title,
    description: row.description ?? '',
  };
}

// --- Store ---

export class TelosStore {
  private db: Database.Database | null;
  private profilesDir: string;
  private hasGoalId: boolean;
  private hasLinksTable: boolean;

  constructor(dbPath: string, profilesDir: string) {
    if (!existsSync(dbPath)) {
      throw new Error(`Telos DB not found: ${dbPath}`);
    }
    this.profilesDir = profilesDir;
    this.db = new Database(dbPath, { readonly: true });
    this.db.pragma('busy_timeout = 5000');

    // Cache schema checks — DB is readonly so these won't change
    const cols = new Set(
      (this.db.pragma('table_info(items)') as { name: string }[]).map((c) => c.name),
    );
    this.hasGoalId = cols.has('goal_id');
    this.hasLinksTable =
      (
        this.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='links'")
          .all() as { name: string }[]
      ).length > 0;

    log.info('TelosStore initialized (readonly)', { dbPath, hasGoalId: this.hasGoalId });
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private getDb(): Database.Database {
    if (!this.db) throw new Error('TelosStore is closed');
    return this.db;
  }

  /**
   * List items with proper parent/child tree and accurate completedChildCount.
   *
   * Unlike the Python cmd_list which only fetches active/acknowledged items and
   * then tries to backfill completed children, this method fetches ALL children
   * of matched items regardless of status, ensuring correct counts.
   */
  listItems(profile?: string, statuses: string[] = ['active', 'acknowledged']): TelosItem[] {
    const db = this.getDb();

    // Step 1: fetch root-eligible items (matching status filter)
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (statuses.length > 0) {
      conditions.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    if (profile) {
      conditions.push('profile = ?');
      params.push(profile);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rootRows = db
      .prepare(`SELECT * FROM items ${where} ORDER BY starred DESC, urgency DESC, first_seen ASC`)
      .all(...params) as ItemRow[];

    if (rootRows.length === 0) {
      return [];
    }

    // Step 2: fetch ALL children of these items (any status)
    const rootIds = rootRows.map((r) => r.id);
    const childRows = this.fetchAllChildren(rootIds);

    // Step 3: batch-load sources and links for all items
    const allIds = [...new Set([...rootIds, ...childRows.map((c) => c.id)])];
    const sourceMap = this.loadSourcesForItems(allIds);
    const linkMap = this.loadLinksForItems(allIds);

    // Step 4: build tree
    return this.buildTree(rootRows, childRows, sourceMap, linkMap);
  }

  /**
   * Get a single item by full or partial ID (prefix match).
   */
  getItem(id: string): TelosItem | null {
    if (!id) return null;
    const db = this.getDb();

    // Try exact match
    let row = db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined;

    if (!row) {
      // Prefix match
      const rows = db
        .prepare('SELECT * FROM items WHERE substr(id, 1, ?) = ?')
        .all(id.length, id) as ItemRow[];
      if (rows.length === 1) {
        row = rows[0];
      } else {
        return null;
      }
    }

    const sourceMap = this.loadSourcesForItems([row.id]);
    const linkMap = this.loadLinksForItems([row.id]);

    // Also load children
    const childRows = this.fetchAllChildren([row.id]);
    const childIds = childRows.map((c) => c.id);
    if (childIds.length > 0) {
      const childSourceMap = this.loadSourcesForItems(childIds);
      const childLinkMap = this.loadLinksForItems(childIds);
      for (const [k, v] of childSourceMap) sourceMap.set(k, v);
      for (const [k, v] of childLinkMap) linkMap.set(k, v);
    }

    const items = this.buildTree([row], childRows, sourceMap, linkMap);
    return items[0] ?? null;
  }

  /**
   * List available profiles from YAML config directory + DB.
   */
  listProfiles(): string[] {
    const profiles = new Set<string>();

    // Scan YAML profile directory
    if (existsSync(this.profilesDir)) {
      try {
        for (const file of readdirSync(this.profilesDir)) {
          if (file.endsWith('.yaml') || file.endsWith('.yml')) {
            profiles.add(basename(file, file.endsWith('.yaml') ? '.yaml' : '.yml'));
          }
        }
      } catch {
        // Directory read failed — continue with DB profiles
      }
    }

    // Also include profiles that exist in DB but not in YAML
    const db = this.getDb();
    const rows = db.prepare('SELECT DISTINCT profile FROM items').all() as {
      profile: string;
    }[];
    for (const row of rows) {
      profiles.add(row.profile);
    }

    return [...profiles].sort();
  }

  // --- Private helpers ---

  /**
   * Fetch all children (any status) whose parent_id is in the given set.
   * Single level — items in this repo don't nest deeper than parent→child.
   */
  private fetchAllChildren(parentIds: string[]): ItemRow[] {
    if (parentIds.length === 0) return [];
    const db = this.getDb();
    const placeholders = parentIds.map(() => '?').join(',');
    return db
      .prepare(`SELECT * FROM items WHERE parent_id IN (${placeholders})`)
      .all(...parentIds) as ItemRow[];
  }

  private loadSourcesForItems(itemIds: string[]): Map<string, TelosSource[]> {
    if (itemIds.length === 0) return new Map();
    const db = this.getDb();
    const placeholders = itemIds.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT * FROM sources WHERE item_id IN (${placeholders}) ORDER BY timestamp DESC`)
      .all(...itemIds) as SourceRow[];

    const map = new Map<string, TelosSource[]>();
    for (const row of rows) {
      const sources = map.get(row.item_id) ?? [];
      sources.push(rowToSource(row));
      map.set(row.item_id, sources);
    }
    return map;
  }

  private loadLinksForItems(itemIds: string[]): Map<string, TelosLink[]> {
    if (itemIds.length === 0 || !this.hasLinksTable) return new Map();
    const db = this.getDb();

    const placeholders = itemIds.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT * FROM links WHERE item_id IN (${placeholders})`)
      .all(...itemIds) as LinkRow[];

    const map = new Map<string, TelosLink[]>();
    for (const row of rows) {
      const links = map.get(row.item_id) ?? [];
      links.push(rowToLink(row));
      map.set(row.item_id, links);
    }
    return map;
  }

  private rowToItem(
    row: ItemRow,
    sourceMap: Map<string, TelosSource[]>,
    linkMap: Map<string, TelosLink[]>,
  ): TelosItem {
    return {
      id: row.id,
      summary: row.summary,
      profile: row.profile,
      urgency: row.urgency,
      starred: row.starred === 1,
      status: row.status as TelosItem['status'],
      ageDays: computeAgeDays(row.first_seen),
      parentId: row.parent_id,
      children: [],
      childCount: 0,
      completedChildCount: 0,
      sources: sourceMap.get(row.id) ?? [],
      links: linkMap.get(row.id) ?? [],
      contextHints: parseContextHints(row.context_hints),
      goalId: this.hasGoalId ? (row.goal_id ?? null) : null,
    };
  }

  private buildTree(
    rootRows: ItemRow[],
    childRows: ItemRow[],
    sourceMap: Map<string, TelosSource[]>,
    linkMap: Map<string, TelosLink[]>,
  ): TelosItem[] {
    const itemsById = new Map<string, TelosItem>();

    // Convert all rows to TelosItem objects
    for (const row of [...rootRows, ...childRows]) {
      if (!itemsById.has(row.id)) {
        itemsById.set(row.id, this.rowToItem(row, sourceMap, linkMap));
      }
    }

    // Nest children under parents
    for (const item of itemsById.values()) {
      if (item.parentId && itemsById.has(item.parentId)) {
        const parent = itemsById.get(item.parentId)!;
        parent.children.push(item);
      }
    }

    // Compute counts after all children are nested
    for (const item of itemsById.values()) {
      if (item.children.length > 0) {
        item.childCount = item.children.length;
        item.completedChildCount = item.children.filter((c) => c.status === 'completed').length;
      }
    }

    // Return only root-level items (not nested under another item in this set)
    const result: TelosItem[] = [];
    for (const row of rootRows) {
      const item = itemsById.get(row.id);
      if (item && (!item.parentId || !itemsById.has(item.parentId))) {
        result.push(item);
      }
    }
    return result;
  }
}
