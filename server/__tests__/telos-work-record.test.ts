import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelosWorkStore } from '../telos-work-store.js';
import { TelosArtifactStore } from '../telos-artifact-store.js';
import { TelosWorkItemSchema } from '@mitzo/protocol';
import { projectTelosWorkRecord } from '../telos-work-record.js';
import { readFileSync } from 'node:fs';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

const roots: string[] = [];
const stores: TelosWorkStore[] = [];
const databases: Database.Database[] = [];
const operator = { kind: 'operator' as const, id: 'verified-operator' };
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  databases.splice(0).forEach((db) => db.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'telos-record-'));
  roots.push(root);
  const path = join(root, 'telos.db');
  const db = new Database(path);
  databases.push(db);
  // Canonical MGMT field names, including fields the old HTTP DTO omits.
  db.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY, parent_id TEXT REFERENCES items(id), summary TEXT,
      intent TEXT, rationale TEXT, acceptance_criteria TEXT, profile TEXT,
      status TEXT, starred INTEGER, context_hints TEXT,
      created_at TEXT, updated_at TEXT, first_seen TEXT, last_seen TEXT,
      urgency REAL, snoozed_until TEXT, goal_id TEXT, idempotency_key TEXT,
      future_legacy_field TEXT
    );
    CREATE TABLE sources (
      id TEXT PRIMARY KEY, item_id TEXT, type TEXT, source_id TEXT, url TEXT,
      title TEXT, author TEXT, timestamp TEXT, raw_snippet TEXT
    );
    CREATE TABLE links (
      id TEXT PRIMARY KEY, item_id TEXT, type TEXT, url TEXT, title TEXT,
      description TEXT, created_at TEXT
    );
    CREATE TABLE history (id INTEGER PRIMARY KEY, item_id TEXT, new_status TEXT, changed_at TEXT);
    INSERT INTO items(id,summary,status,profile,updated_at) VALUES('parent','Parent','active','mitzo',NULL);
  `);
  const hints = {
    repos: ['dimakis/mitzo'],
    paths: ['server/telos-tool.ts'],
    issues: ['#975'],
    doc_ids: ['approved-design'],
    people: ['Dimitri'],
    jira_keys: ['RHOAIENG-1'],
    keywords: ['work'],
    session_ids: ['legacy-hint-not-an-assignment'],
    task_hint: 'Follow the approved mock exactly.',
    future_hint: { preserve: true },
  };
  db.prepare(
    `INSERT INTO items VALUES(
    'item','parent','Outcome','Deliver the agreed outcome','Why it matters',?,
    'work','snoozed',1,?,'2025-01-02T03:04:05','2026-10-16T11:35:00+01:00',
    '2024-01-01','2026-10-15',0.7,'2026-11-01','accounting-goal','capture-request','unmapped'
  )`,
  ).run(JSON.stringify(['Output reviewed', 'Evidence retained']), JSON.stringify(hints));
  const snippet = 'Full source evidence. '.repeat(40) + 'Never truncate this ending.';
  db.prepare(
    "INSERT INTO sources VALUES('source','item','manual','source-id','codex://threads/original','Original chat','Dimitri','2025-01-02T03:00:00',?)",
  ).run(snippet);
  db.prepare(
    "INSERT INTO links VALUES('link','item','design_doc','/api/telos/artifacts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?revision=2','Approved mock','Pinned r2','2026-10-16T10:00:00+01:00')",
  ).run();
  db.exec("INSERT INTO history VALUES(1,'item','snoozed','2026-10-15')");
  const store = new TelosWorkStore(path, { ordinaryConversation: (id) => id === 'linked-chat' });
  stores.push(store);
  const retained = () =>
    Object.fromEntries(
      ['items', 'sources', 'links', 'history'].map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  return { db, store, retained, snippet, hints, path };
}

describe('lossless Telos workspace record', () => {
  it.each(Array.from({ length: 10 }, (_, index) => index + 1))(
    'projects persisted numeric priority %s and refreshes the same canonical item/revision',
    (priority) => {
      const f = fixture();
      f.db.exec('ALTER TABLE items ADD COLUMN priority INTEGER NOT NULL DEFAULT 5');
      const before = f.store.read('item', operator).revision;
      f.db.prepare('UPDATE items SET priority=? WHERE id=?').run(priority, 'item');
      const record = f.store.readRecord('item', operator);
      expect(record.priority).toBe(priority);
      expect((record.legacyFields.item as Record<string, unknown>).priority).toBe(priority);
      if (priority !== 5) expect(f.store.read('item', operator).revision).not.toBe(before);
      f.db.prepare('UPDATE items SET priority=8 WHERE id=?').run('item');
      expect(f.store.readRecord('item', operator).priority).toBe(8);
    },
  );

  it('keeps old wire records compatible and maps missing stored values using legacy defaults', () => {
    const f = fixture();
    const record = f.store.readRecord('item', operator);
    expect(record.priority).toBe(10);
    const legacy = { ...record };
    delete legacy.priority;
    expect(TelosWorkItemSchema.safeParse(legacy).success).toBe(true);
    f.db.prepare('UPDATE items SET starred=0 WHERE id=?').run('item');
    expect(f.store.readRecord('item', operator).priority).toBe(5);
  });

  it.each([0, 11, 1.5, true, '7', null])(
    'rejects malformed stored numeric priority %s rather than publishing an invalid record',
    (priority) => {
      const f = fixture();
      const row = f.db.prepare('SELECT * FROM items WHERE id=?').get('item') as Record<
        string,
        unknown
      >;
      expect(() => projectTelosWorkRecord({ ...row, priority }, [], [], null)).toThrow();
    },
  );

  it('pins the new projection and its existing authorization/API owners in the reviewed manifest', () => {
    const manifest: Record<string, string> = reviewedHandlerSourceArtifacts;
    for (const file of [
      '../telos-work-record.ts',
      '../telos-work-store.ts',
      '../telos-work-routes.ts',
      '../../packages/client/src/telos-work-api.ts',
    ]) {
      expect(manifest[file], file).toBe(
        reviewedHandlerSourceFingerprint(
          readFileSync(new URL(file, new URL('../connections/', import.meta.url)), 'utf8'),
        ),
      );
    }
  });

  it('leaves actual retained material IDs, bytes, hashes, revisions and provenance under the existing artifact owner', () => {
    const f = fixture();
    const artifacts = new TelosArtifactStore(f.path);
    try {
      const save = (bytes: Buffer, requestId: string) =>
        artifacts.save({
          itemId: 'item',
          filename: 'approved-mock.html',
          title: 'Approved mock',
          bytes,
          sessionId: 'external-codex:original',
          sourcePath: 'original-mock.html',
          requestId,
        });
      const original = save(Buffer.from('<html>Exact approved source</html>\n'), 'r1');
      const later = save(Buffer.from('<html>Later revision</html>\n'), 'r2');
      expect(later.id).toBe(original.id);
      expect(later.revision).toBe(2);
      const before = [artifacts.read(original.id, 1), artifacts.read(original.id, 2)];
      const canonical = f.retained();
      const record = f.store.readRecord('item', operator);
      // The legacy owner's general artifact link is unpinned. Preserve it as-is;
      // its immutable revisions remain available through the artifact owner.
      expect(record.links).toContainEqual(
        expect.objectContaining({
          url: '/api/telos/artifacts/' + later.id,
          addedAt: later.createdAt,
        }),
      );
      expect([artifacts.read(original.id, 1), artifacts.read(original.id, 2)]).toEqual(before);
      expect(f.retained()).toEqual(canonical);
      expect(f.store.readRecord('item', operator)).toEqual(record);
    } finally {
      artifacts.close();
    }
  });

  it('projects the stored brief, full evidence, dates and pinned material references without rewriting any canonical record', () => {
    const f = fixture();
    const before = f.retained();
    const record = f.store.readRecord('item', operator);
    expect(record).toMatchObject({
      version: 1,
      itemId: 'item',
      kind: null,
      parentId: 'parent',
      summary: 'Outcome',
      intent: 'Deliver the agreed outcome',
      rationale: 'Why it matters',
      acceptanceCriteria: ['Output reviewed', 'Evidence retained'],
      profile: 'work',
      status: 'snoozed',
      starred: true,
      categories: [],
      createdAt: '2025-01-02T03:04:05',
      updatedAt: '2026-10-16T11:35:00+01:00',
      contextHints: {
        repos: f.hints.repos,
        paths: f.hints.paths,
        issues: f.hints.issues,
        docIds: f.hints.doc_ids,
        people: f.hints.people,
        jiraKeys: f.hints.jira_keys,
        keywords: f.hints.keywords,
        sessionIds: f.hints.session_ids,
        taskHint: f.hints.task_hint,
      },
      sources: [
        {
          rawSnippet: f.snippet,
          author: 'Dimitri',
          createdAt: '2025-01-02T03:00:00',
          addedAt: null,
          updatedAt: null,
        },
      ],
      links: [
        {
          url: '/api/telos/artifacts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?revision=2',
          addedAt: '2026-10-16T10:00:00+01:00',
        },
      ],
    });
    expect(record.legacyFields).toEqual({
      item: before.items[1],
      sources: before.sources,
      links: before.links,
    });
    expect(f.store.readRecord('item', operator)).toEqual(record);
    expect(f.retained()).toEqual(before);
    expect(f.store.read('item', operator)).toMatchObject({
      kind: null,
      links: [],
      assignments: [],
      sources: [],
      attempts: [],
    });
  });

  it('keeps unknown provenance unknown and uses only explicitly classified kinds', () => {
    const f = fixture();
    const legacy = f.store.readRecord('parent', operator);
    expect(legacy).toMatchObject({
      kind: null,
      categories: [],
      createdAt: null,
      updatedAt: null,
      sources: [],
      links: [],
    });
    f.store.execute(
      {
        operation: 'classify',
        itemId: 'parent',
        kind: 'outcome',
        requestId: 'classify',
        expectedRevision: f.store.read('parent', operator).revision,
      },
      operator,
    );
    expect(f.store.readRecord('parent', operator).kind).toBe('outcome');
    expect(f.store.read('parent', operator).assignments).toEqual([]);
  });

  it('enforces the same exact-item read authority and does not treat context hints as session links', () => {
    const f = fixture();
    for (const id of ['legacy-hint-not-an-assignment', 'linked-chat', '']) {
      expect(() => f.store.readRecord('item', { kind: 'conversation', id })).toThrow(
        /not authorized/,
      );
    }
    f.store.execute(
      {
        operation: 'link',
        itemId: 'item',
        role: 'advisor',
        conversation: { namespace: 'mitzo', conversationId: 'linked-chat' },
        requestId: 'link',
        expectedRevision: f.store.read('item', operator).revision,
      },
      operator,
    );
    expect(f.store.readRecord('item', { kind: 'conversation', id: 'linked-chat' }).itemId).toBe(
      'item',
    );
    expect(() => f.store.readRecord('parent', { kind: 'conversation', id: 'linked-chat' })).toThrow(
      /not authorized/,
    );
    expect(() => f.store.readRecord('missing', operator)).toThrow(/not found/);
  });

  it.each([
    ['acceptance_criteria', '{broken'],
    ['acceptance_criteria', '["valid",42]'],
    ['context_hints', '{broken'],
    ['context_hints', '{"session_ids":"not-an-array"}'],
    ['context_hints', '[]'],
    ['status', 'invented-state'],
  ])('refuses incompatible stored %s rather than silently losing it', (column, value) => {
    const f = fixture();
    f.db.prepare(`UPDATE items SET ${column}=? WHERE id='item'`).run(value);
    const before = f.retained();
    expect(() => f.store.readRecord('item', operator)).toThrow();
    expect(f.retained()).toEqual(before);
  });
});
