import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { TelosStore } from '../telos-store.js';

const TEST_DIR = join(tmpdir(), `mitzo-telos-test-${process.pid}`);

// Telos schema matching store.py
const TELOS_SCHEMA = `
CREATE TABLE items (
    id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    profile TEXT NOT NULL,
    cluster_id TEXT,
    urgency REAL DEFAULT 0.0,
    starred INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    snoozed_until TEXT,
    context_hints TEXT DEFAULT '{}',
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    parent_id TEXT REFERENCES items(id) ON DELETE CASCADE,
    goal_id TEXT
);

CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    raw_snippet TEXT DEFAULT '',
    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE TABLE links (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    type TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE TABLE history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,
    old_status TEXT,
    new_status TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE INDEX idx_items_profile ON items(profile);
CREATE INDEX idx_items_status ON items(status);
CREATE INDEX idx_items_parent ON items(parent_id);
CREATE INDEX idx_sources_item ON sources(item_id);
CREATE INDEX idx_links_item ON links(item_id);
`;

const NOW = new Date().toISOString();
const WEEK_AGO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

let dbPath: string;
let profilesDir: string;

function createTelosDb(): Database.Database {
  dbPath = join(TEST_DIR, `telos-${Date.now()}.db`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(TELOS_SCHEMA);
  return db;
}

function insertItem(
  db: Database.Database,
  overrides: Partial<{
    id: string;
    summary: string;
    profile: string;
    status: string;
    urgency: number;
    starred: number;
    parent_id: string | null;
    goal_id: string | null;
    context_hints: string;
    first_seen: string;
  }> = {},
) {
  const id = overrides.id ?? `item-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO items (id, summary, profile, status, urgency, starred, parent_id, goal_id,
     context_hints, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    overrides.summary ?? `Test item ${id}`,
    overrides.profile ?? 'work',
    overrides.status ?? 'active',
    overrides.urgency ?? 0.5,
    overrides.starred ?? 0,
    overrides.parent_id ?? null,
    overrides.goal_id ?? null,
    overrides.context_hints ?? '{"repos":["mgmt"],"jira_keys":["RHAIENG-123"]}',
    overrides.first_seen ?? WEEK_AGO,
    NOW,
    NOW,
    NOW,
  );
  return id;
}

function insertSource(
  db: Database.Database,
  itemId: string,
  overrides: Partial<{
    id: string;
    type: string;
    source_id: string;
    url: string;
    title: string;
    author: string;
    raw_snippet: string;
  }> = {},
) {
  const id = overrides.id ?? `src-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO sources (id, item_id, type, source_id, url, title, author, timestamp, raw_snippet)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    itemId,
    overrides.type ?? 'manual',
    overrides.source_id ?? `manual-${id}`,
    overrides.url ?? '',
    overrides.title ?? `Source for ${itemId}`,
    overrides.author ?? 'test@example.com',
    NOW,
    overrides.raw_snippet ?? 'Test snippet content',
  );
}

function insertLink(
  db: Database.Database,
  itemId: string,
  overrides: Partial<{
    id: string;
    type: string;
    url: string;
    title: string;
    description: string;
  }> = {},
) {
  const id = overrides.id ?? `link-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO links (id, item_id, type, url, title, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    itemId,
    overrides.type ?? 'design_doc',
    overrides.url ?? 'https://example.com/doc',
    overrides.title ?? 'Test doc',
    overrides.description ?? '',
    NOW,
  );
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  profilesDir = join(TEST_DIR, 'profiles');
  mkdirSync(profilesDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('TelosStore', () => {
  describe('constructor', () => {
    it('opens DB readonly', () => {
      const db = createTelosDb();
      db.close();
      const store = new TelosStore(dbPath, profilesDir);
      expect(store).toBeDefined();
      store.close();
    });

    it('throws when DB does not exist', () => {
      expect(() => new TelosStore(join(TEST_DIR, 'nonexistent.db'), profilesDir)).toThrow(
        'Telos DB not found',
      );
    });
  });

  describe('listItems', () => {
    it('returns items with correct tree structure and completedChildCount', () => {
      const db = createTelosDb();
      const parentId = insertItem(db, { id: 'parent-001', summary: 'Parent task' });
      insertSource(db, parentId);
      insertItem(db, {
        id: 'child-001',
        summary: 'Child 1 (active)',
        status: 'active',
        parent_id: parentId,
      });
      insertItem(db, {
        id: 'child-002',
        summary: 'Child 2 (completed)',
        status: 'completed',
        parent_id: parentId,
      });
      insertItem(db, {
        id: 'child-003',
        summary: 'Child 3 (completed)',
        status: 'completed',
        parent_id: parentId,
      });
      db.close();

      const store = new TelosStore(dbPath, profilesDir);
      const items = store.listItems();

      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('parent-001');
      expect(items[0].childCount).toBe(3);
      expect(items[0].completedChildCount).toBe(2);
      expect(items[0].children).toHaveLength(3);
      store.close();
    });

    it('filters by profile', () => {
      const db = createTelosDb();
      insertItem(db, { id: 'work-1', profile: 'work' });
      insertItem(db, { id: 'personal-1', profile: 'personal' });
      db.close();

      const store = new TelosStore(dbPath, profilesDir);
      const workItems = store.listItems('work');
      expect(workItems).toHaveLength(1);
      expect(workItems[0].profile).toBe('work');
      store.close();
    });

    it('filters by status', () => {
      const db = createTelosDb();
      insertItem(db, { id: 'active-1', status: 'active' });
      insertItem(db, { id: 'done-1', status: 'completed' });
      insertItem(db, { id: 'snoozed-1', status: 'snoozed' });
      db.close();

      const store = new TelosStore(dbPath, profilesDir);
      const items = store.listItems(undefined, ['active']);
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('active');
      store.close();
    });

    it('includes completed children even when filtering to active status', () => {
      const db = createTelosDb();
      const parentId = insertItem(db, { id: 'parent-a', status: 'active' });
      insertItem(db, {
        id: 'child-done',
        status: 'completed',
        parent_id: parentId,
      });
      db.close();

      const store = new TelosStore(dbPath, profilesDir);
      // Only active items, but completed children should still appear in the tree
      const items = store.listItems(undefined, ['active']);
      expect(items).toHaveLength(1);
      expect(items[0].childCount).toBe(1);
      expect(items[0].completedChildCount).toBe(1);
      store.close();
    });

    it('maps context_hints snake_case to camelCase', () => {
      const db = createTelosDb();
      insertItem(db, {
        id: 'hints-item',
        context_hints: JSON.stringify({
          repos: ['mgmt'],
          doc_ids: ['doc-1'],
          jira_keys: ['KEY-1'],
          task_hint: 'do the thing',
          session_ids: ['sess-1'],
        }),
      });
      db.close();

      const store = new TelosStore(dbPath, profilesDir);
      const items = store.listItems();
      const hints = items[0].contextHints;
      expect(hints.repos).toEqual(['mgmt']);
      expect(hints.docIds).toEqual(['doc-1']);
      expect(hints.jiraKeys).toEqual(['KEY-1']);
      expect(hints.taskHint).toBe('do the thing');
      expect(hints.sessionIds).toEqual(['sess-1']);
      store.close();
    });

    it('loads sources and links', () => {
      const db = createTelosDb();
      const id = insertItem(db, { id: 'sourced-item' });
      insertSource(db, id, { type: 'jira', title: 'RHAIENG-42', url: 'https://jira/42' });
      insertLink(db, id, { type: 'pr', url: 'https://github.com/pr/1', title: 'PR #1' });
      db.close();

      const store = new TelosStore(dbPath, profilesDir);
      const items = store.listItems();
      expect(items[0].sources).toHaveLength(1);
      expect(items[0].sources[0].type).toBe('jira');
      expect(items[0].sources[0].title).toBe('RHAIENG-42');
      expect(items[0].links).toHaveLength(1);
      expect(items[0].links[0].type).toBe('pr');
      store.close();
    });

    it('computes ageDays from first_seen', () => {
      const db = createTelosDb();
      insertItem(db, { id: 'old-item', first_seen: WEEK_AGO });
      db.close();

      const store = new TelosStore(dbPath, profilesDir);
      const items = store.listItems();
      expect(items[0].ageDays).toBeGreaterThanOrEqual(6);
      expect(items[0].ageDays).toBeLessThanOrEqual(8);
      store.close();
    });

    it('includes goalId from DB', () => {
      const db = createTelosDb();
      insertItem(db, { id: 'promoted-item', goal_id: 'task-uuid-123' });
      db.close();

      const store = new TelosStore(dbPath, profilesDir);
      const items = store.listItems();
      expect(items[0].goalId).toBe('task-uuid-123');
      store.close();
    });

    it('nests active child under active parent without duplicating', () => {
      const db = createTelosDb();
      insertItem(db, { id: 'parent-active', status: 'active' });
      insertItem(db, { id: 'child-active', status: 'active', parent_id: 'parent-active' });
      db.close();

      const store = new TelosStore(dbPath, profilesDir);
      const items = store.listItems(undefined, ['active']);
      // Child should be nested, not a separate root
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('parent-active');
      expect(items[0].children).toHaveLength(1);
      expect(items[0].children[0].id).toBe('child-active');
      store.close();
    });

    it('returns all items when statuses array is empty', () => {
      const db = createTelosDb();
      insertItem(db, { id: 'a-active', status: 'active' });
      insertItem(db, { id: 'b-completed', status: 'completed' });
      insertItem(db, { id: 'c-snoozed', status: 'snoozed' });
      db.close();

      const store = new TelosStore(dbPath, profilesDir);
      const items = store.listItems(undefined, []);
      expect(items).toHaveLength(3);
      store.close();
    });
  });

  describe('getItem', () => {
    it('finds item by exact ID', () => {
      const db = createTelosDb();
      insertItem(db, { id: 'abc123def4567890', summary: 'Exact match' });
      db.close();

      const store = new TelosStore(dbPath, profilesDir);
      const item = store.getItem('abc123def4567890');
      expect(item).not.toBeNull();
      expect(item!.summary).toBe('Exact match');
      store.close();
    });

    it('finds item by prefix', () => {
      const db = createTelosDb();
      insertItem(db, { id: 'abc123def4567890', summary: 'Prefix match' });
      db.close();

      const store = new TelosStore(dbPath, profilesDir);
      const item = store.getItem('abc123');
      expect(item).not.toBeNull();
      expect(item!.summary).toBe('Prefix match');
      store.close();
    });

    it('returns null for ambiguous prefix', () => {
      const db = createTelosDb();
      insertItem(db, { id: 'abc123aaaa' });
      insertItem(db, { id: 'abc123bbbb' });
      db.close();

      const store = new TelosStore(dbPath, profilesDir);
      const item = store.getItem('abc123');
      expect(item).toBeNull();
      store.close();
    });

    it('returns null for nonexistent ID', () => {
      const db = createTelosDb();
      db.close();

      const store = new TelosStore(dbPath, profilesDir);
      expect(store.getItem('nonexistent')).toBeNull();
      store.close();
    });

    it('includes children in getItem result', () => {
      const db = createTelosDb();
      insertItem(db, { id: 'parent-get', summary: 'Parent' });
      insertItem(db, { id: 'child-get-1', parent_id: 'parent-get', status: 'completed' });
      insertItem(db, { id: 'child-get-2', parent_id: 'parent-get', status: 'active' });
      db.close();

      const store = new TelosStore(dbPath, profilesDir);
      const item = store.getItem('parent-get');
      expect(item!.childCount).toBe(2);
      expect(item!.completedChildCount).toBe(1);
      store.close();
    });
  });

  describe('listProfiles', () => {
    it('returns profiles from YAML files', () => {
      const db = createTelosDb();
      db.close();

      writeFileSync(join(profilesDir, 'work.yaml'), 'name: work');
      writeFileSync(join(profilesDir, 'personal.yaml'), 'name: personal');

      const store = new TelosStore(dbPath, profilesDir);
      const profiles = store.listProfiles();
      expect(profiles).toContain('work');
      expect(profiles).toContain('personal');
      store.close();
    });

    it('includes DB-only profiles', () => {
      const db = createTelosDb();
      insertItem(db, { profile: 'db-only' });
      db.close();

      const store = new TelosStore(dbPath, profilesDir);
      const profiles = store.listProfiles();
      expect(profiles).toContain('db-only');
      store.close();
    });

    it('deduplicates profiles from YAML and DB', () => {
      const db = createTelosDb();
      insertItem(db, { profile: 'work' });
      db.close();

      writeFileSync(join(profilesDir, 'work.yaml'), 'name: work');

      const store = new TelosStore(dbPath, profilesDir);
      const profiles = store.listProfiles();
      const workCount = profiles.filter((p) => p === 'work').length;
      expect(workCount).toBe(1);
      store.close();
    });
  });
});
