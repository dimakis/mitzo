import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { TelosRuntimeStore } from '../telos-runtime-store.js';
import { TelosItemStore } from '../telos-item-store.js';
import { renewDueTelosSnoozes } from '../telos-snooze.js';
import * as logging from '../logger.js';

const cleanups: Array<() => void> = [];
afterEach(() => vi.restoreAllMocks());
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'telos-runtime-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'telos.db');
  TelosRuntimeStore.initialize(path);
  const store = new TelosRuntimeStore(path);
  cleanups.push(() => store.close());
  return { path, store };
}
const outcome = {
  summary: 'Keep authored work',
  intent: 'Private durable work',
  rationale: 'Preserve edits',
  acceptanceCriteria: ['History survives'],
  milestones: ['Migrate', 'Verify'],
  profile: 'manual',
  idempotencyKey: 'original-reviewed-creation',
};
describe('Mitzo canonical Telos persistence', () => {
  it.each(['completed', 'other-profile', 'archived', 'trashed'])(
    'bounds the requested collection after excluding %s history',
    (history) => {
      const { store, path } = fixture();
      const { item } = store.create({ summary: 'Current work', profile: 'work' });
      const seed = new Database(path);
      try {
        seed.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<5001)
          INSERT INTO items(id,summary,profile,status,context_hints,first_seen,last_seen,created_at,updated_at)
          SELECT 'history-'||i,'Retained history','work','active','{}','2026-01-01','2026-01-01','2026-01-01','2026-01-01' FROM n`);
        if (history === 'completed')
          seed.exec("UPDATE items SET status='completed' WHERE id LIKE 'history-%'");
        else if (history === 'other-profile')
          seed.exec("UPDATE items SET profile='personal' WHERE id LIKE 'history-%'");
        else
          seed
            .prepare(
              'INSERT INTO telos_work_lifecycle(item_id,data) SELECT id,? FROM items WHERE id LIKE ?',
            )
            .run(
              JSON.stringify({
                disposition: history,
                restoreDisposition: 'active',
                pauseControlIds: [],
                generation: 1,
              }),
              'history-%',
            );
        expect(store.list('work').items.map((row) => row.id)).toEqual([item.id]);
        expect(() =>
          store.list(
            history === 'other-profile' ? 'personal' : 'work',
            history === 'completed' || history === 'other-profile'
              ? true
              : history === 'archived'
                ? 'archive'
                : 'trash',
          ),
        ).toThrow(/bounded selection/);
      } finally {
        seed.close();
      }
    },
  );

  it.each([
    { action: { action: 'star' }, starred: 0, expected: { priority: 7, starred: true } },
    { action: { action: 'unstar' }, starred: 1, expected: { priority: 7, starred: false } },
    {
      action: { action: 'priority', priority: 8 },
      starred: 1,
      expected: { priority: 8, starred: true },
    },
    {
      action: { action: 'priority', priority: 10 },
      starred: 0,
      expected: { priority: 10, starred: false },
    },
  ] as const)(
    'keeps priority and stars independent for $action',
    ({ action, starred, expected }) => {
      const { store, path } = fixture();
      const { item } = store.create({ summary: 'Independent controls', profile: 'manual' });
      const seed = new Database(path);
      try {
        seed.prepare('UPDATE items SET priority=7,starred=? WHERE id=?').run(starred, item.id);
      } finally {
        seed.close();
      }
      store.action(item.id, action);
      expect(store.list().items[0]).toMatchObject(expected);
    },
  );

  it('reads committed work beside a writer when snoozes are future or indefinite', () => {
    const { store, path } = fixture();
    store.importSources({
      items: ['visible', 'future', 'indefinite'].map((id) => ({
        id,
        summary: id,
        profile: 'manual',
        sources: [],
      })),
    });
    const writer = new Database(path);
    try {
      writer.exec(
        "UPDATE items SET status='snoozed',snoozed_until='2999-12-31' WHERE id='future'; UPDATE items SET status='snoozed',snoozed_until=NULL WHERE id='indefinite'; BEGIN IMMEDIATE; UPDATE items SET summary='uncommitted' WHERE id='visible'",
      );
      const reader = new TelosRuntimeStore(path);
      try {
        expect(() => reader.renewSnoozes()).not.toThrow();
        expect(reader.list().items).toMatchObject([{ id: 'visible', summary: 'visible' }]);
        expect(
          reader.list(undefined, true).items.filter((row) => row.status === 'snoozed'),
        ).toHaveLength(2);
      } finally {
        reader.close();
      }
    } finally {
      if (writer.inTransaction) writer.exec('ROLLBACK');
      writer.close();
    }
  }, 12000);

  it('renews due snoozes exactly once while preserving future and indefinite snoozes', () => {
    const { store, path } = fixture();
    store.importSources({
      items: ['due', 'future', 'indefinite'].map((id) => ({
        id,
        summary: id,
        profile: 'manual',
        sources: [],
      })),
    });
    const db = new Database(path);
    try {
      db.exec(
        "UPDATE items SET status='snoozed'; UPDATE items SET snoozed_until='2000-01-01' WHERE id='due'; UPDATE items SET snoozed_until='2999-12-31' WHERE id='future'",
      );
      store.renewSnoozes();
      store.renewSnoozes();
      expect(store.list().items.map((row) => row.id)).toEqual(['due']);
      expect(
        db
          .prepare("SELECT item_id,old_status,new_status FROM history WHERE old_status='snoozed'")
          .all(),
      ).toEqual([{ item_id: 'due', old_status: 'snoozed', new_status: 'active' }]);
    } finally {
      db.close();
    }
  });

  it('rechecks stale snooze candidates inside the renewal transaction', () => {
    const { store, path } = fixture();
    const { item } = store.create({ summary: 'Rescheduled snooze', profile: 'manual' });
    const db = new Database(path);
    try {
      db.prepare("UPDATE items SET status='snoozed',snoozed_until='2999-12-31' WHERE id=?").run(
        item.id,
      );
      db.transaction(() =>
        renewDueTelosSnoozes(
          db,
          [{ id: item.id, status: 'snoozed', snoozed_until: '2000-01-01' }],
          () => {},
        ),
      ).immediate();
      expect(db.prepare('SELECT status,snoozed_until FROM items WHERE id=?').get(item.id)).toEqual({
        status: 'snoozed',
        snoozed_until: '2999-12-31',
      });
      expect(
        db.prepare('SELECT count(*) AS count FROM history WHERE item_id=?').get(item.id),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it('keeps starred work ahead of unstarred urgency when listing migrated items', () => {
    const { store } = fixture();
    store.importSources({
      items: [
        { id: 'urgent', summary: 'Urgent', profile: 'work', urgency: 1, sources: [] },
        { id: 'starred', summary: 'Selected', profile: 'work', priority: 10, sources: [] },
      ],
    });
    expect(store.list().items.map((item) => item.id)).toEqual(['starred', 'urgent']);
  });
  it('retains original source age and initial context, priority and links without later overwrites', () => {
    const { store } = fixture();
    const record = {
      id: 'source-item',
      summary: 'Source work',
      profile: 'manual',
      sources: [],
      priority: 8,
      categories: ['research'],
      firstSeen: '2026-01-01T10:00:00Z',
      contextHints: { people: ['Person'], sessionIds: ['planning'] },
      links: [{ type: 'external', url: 'https://example.test/plan', title: 'Plan' }],
    };
    store.importSources({ items: [record] });
    store.importSources({
      items: [{ ...record, priority: 1, categories: [], contextHints: {}, links: [] }],
    });
    expect(store.list().items[0]).toMatchObject({
      priority: 8,
      categories: ['research'],
      contextHints: { people: ['Person'], sessionIds: ['planning'] },
      links: [{ title: 'Plan' }],
    });
    expect(store.list().items[0].ageDays).toBeGreaterThan(250);
  });
  it('creates an outcome and ordered children atomically, with stable receipt recovery', () => {
    const { store, path } = fixture();
    const receipt = store.createOutcome(outcome, () => {});
    expect(receipt).toMatchObject({
      ok: true,
      created: true,
      item: {
        summary: outcome.summary,
        intent: outcome.intent,
        children: [{ summary: 'Migrate' }, { summary: 'Verify' }],
      },
    });
    const other = new TelosRuntimeStore(path);
    try {
      expect(other.createOutcome(outcome, () => {})).toMatchObject({
        created: false,
        item: { id: receipt.item.id },
      });
      expect(() => other.createOutcome({ ...outcome, summary: 'Different' }, () => {})).toThrow(
        /identity/,
      );
      expect(other.list().items).toHaveLength(1);
    } finally {
      other.close();
    }
  });
  it('checks current authority inside the creation transaction and rolls back a refusal', () => {
    const { store } = fixture();
    expect(() =>
      store.createOutcome(outcome, () => {
        throw Error('revoked');
      }),
    ).toThrow('revoked');
    expect(store.list().items).toEqual([]);
  });
  it('reports a rejected asynchronous creation guard while preserving an empty canonical store', async () => {
    const { store } = fixture();
    const warn = vi.fn();
    vi.spyOn(logging, 'createLogger').mockReturnValue({
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    });
    expect(() =>
      store.createOutcome(outcome, async () => {
        throw Error('private upstream detail');
      }),
    ).toThrow('Synchronous current Telos authority required');
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          stage: 'item-authority',
          code: 'ASYNC_AUTHORITY_REJECTED',
          diagnosticId: expect.any(String),
        }),
      ),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private upstream detail');
    expect(store.list().items).toEqual([]);
  });
  it('creates a shared outcome with feature children usable by the existing role hierarchy', () => {
    const { store, path } = fixture();
    const input = { ...outcome, workLevel: 'outcome' };
    const receipt = store.createOutcome(input, () => {});
    const db = new Database(path);
    try {
      expect(
        db.prepare('SELECT kind FROM telos_work_kinds WHERE item_id=?').get(receipt.item.id),
      ).toEqual({ kind: 'coordinator' });
      for (const child of receipt.item.children)
        expect(
          db.prepare('SELECT kind FROM telos_work_kinds WHERE item_id=?').get(child.id),
        ).toEqual({ kind: 'outcome' });
      expect(store.createOutcome(input, () => {})).toEqual({ ...receipt, created: false });
      expect(() => store.createOutcome(outcome, () => {})).toThrow(/identity/);
    } finally {
      db.close();
    }
  });
  it('keeps authored fields, hierarchy, progress and receipts across source imports', () => {
    const { store, path } = fixture();
    const record = {
      id: 'imported',
      summary: 'Original',
      profile: 'manual',
      sources: [
        {
          type: 'manual',
          sourceId: 'seed',
          url: '',
          title: 'Original',
          author: 'me',
          timestamp: '2026-11-05T00:00:00Z',
          rawSnippet: '',
        },
      ],
    };
    store.importSources({ items: [record] });
    const edits = new TelosItemStore(path);
    try {
      edits.editGuarded(
        {
          itemId: 'imported',
          requestId: 'edit',
          expectedRevision: edits.read('imported').revision,
          summary: 'Short edited title',
          intent: 'Keep the reviewed intent',
          rationale: 'Preserve our decision',
          acceptanceCriteria: ['User edits survive every refresh'],
          note: 'User edit',
        },
        'operator',
        () => {},
        () => {},
      );
      store.action('imported', { action: 'priority', priority: 9 });
      store.action('imported', { action: 'done' });
      store.importSources({
        items: [
          {
            ...record,
            summary: 'Stale enormous seed',
            parentId: null,
          },
        ],
      });
      expect(edits.read('imported')).toMatchObject({
        summary: 'Short edited title',
        intent: 'Keep the reviewed intent',
        rationale: 'Preserve our decision',
        acceptanceCriteria: ['User edits survive every refresh'],
        status: 'completed',
      });
      const db = new Database(path, { readonly: true });
      try {
        expect(
          db.prepare('SELECT summary,status,priority FROM items WHERE id=?').get('imported'),
        ).toEqual({ summary: 'Short edited title', status: 'completed', priority: 9 });
        expect(edits.read('imported').updates.map((update) => update.note)).toEqual([
          'Updated by the interactive operator.',
          'User edit',
        ]);
      } finally {
        db.close();
      }
    } finally {
      edits.close();
    }
  });
  it('rolls back the whole import on a missing parent and never reparents an existing item', () => {
    const { store } = fixture();
    expect(() =>
      store.importSources({
        items: [
          { id: 'a', summary: 'A', profile: 'work', sources: [] },
          { id: 'b', summary: 'B', profile: 'work', parentId: 'missing', sources: [] },
        ],
      }),
    ).toThrow();
    expect(store.list().items).toEqual([]);
  });
  it('updates actions and history using the selected database without a workspace script', () => {
    const { store, path } = fixture();
    const result = store.create({ summary: 'Ordinary work', profile: 'work' });
    expect(store.action(result.item.id, { action: 'ack' })).toEqual({ ok: true });
    expect(store.list('work').items[0]).toMatchObject({ status: 'acknowledged', priority: 5 });
    const db = new Database(path, { readonly: true });
    try {
      expect(db.prepare('SELECT new_status FROM history ORDER BY id').all()).toEqual([
        { new_status: 'active' },
        { new_status: 'acknowledged' },
      ]);
    } finally {
      db.close();
    }
  });
});
