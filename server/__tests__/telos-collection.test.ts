import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import { TelosItemStore } from '../telos-item-store.js';
import { TelosWorkStore } from '../telos-work-store.js';

const fixtures: ReturnType<typeof createTelosCanonicalData>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.close()));
function fixture() {
  const f = createTelosCanonicalData();
  fixtures.push(f);
  return f;
}
it('lists all ten newly created children by their persisted identity, across profiles and after renaming', () => {
  const f = fixture();
  f.db.prepare("UPDATE items SET profile='work' WHERE id='studio'").run();
  const items = new TelosItemStore(f.dbPath);
  try {
    let revision = items.read('studio').revision;
    const ids: string[] = [];
    for (let index = 0; index < 10; index++) {
      const receipt = items.createChildGuarded(
        {
          parentId: 'studio',
          expectedParentRevision: revision,
          requestId: `report-${index}`,
          summary: `Associate ${index}`,
          intent: 'Review the source PDF',
          rationale: 'Quarterly connection',
          acceptanceCriteria: ['Manager reviewed'],
          note: 'Create individual report item',
        },
        'planning',
        () => {},
        () => {},
      );
      ids.push(receipt.item.id);
      revision = receipt.parentRevision;
    }
    f.db.prepare('UPDATE items SET summary=? WHERE id=?').run('Renamed associate', ids[0]);
    const before = f.db.prepare('SELECT * FROM items ORDER BY id').all();
    const read = TelosWorkStore.openForRecordRead(f.dbPath, {});
    try {
      const collection = read.readCollection('active', f.actor);
      expect(collection.failures).toEqual([]);
      expect(
        collection.records
          .filter((record) => record.parentId === 'studio')
          .map((record) => record.itemId)
          .sort(),
      ).toEqual([...ids].sort());
      expect(collection.records.find((record) => record.itemId === ids[0])?.summary).toBe(
        'Renamed associate',
      );
      expect(collection.profiles).toEqual(['manual', 'work']);
      expect(f.db.prepare('SELECT * FROM items ORDER BY id').all()).toEqual(before);
    } finally {
      read.close();
    }
  } finally {
    items.close();
  }
});
it('filters inherited lifecycle and preserves completed children without exposing completed roots', () => {
  const f = fixture();
  f.db.exec(
    "INSERT INTO items(id,parent_id,summary,status,profile,context_hints,first_seen,last_seen,created_at,updated_at) VALUES('child','studio','Reviewed','completed','manual','{}','2026-10-30','2026-10-30','2026-10-30','2026-10-30'),('finished',NULL,'Finished','completed','manual','{}','2026-10-30','2026-10-30','2026-10-30','2026-10-30')",
  );
  expect(
    f.work
      .readCollection('active', f.actor)
      .records.map((record) => record.itemId)
      .sort(),
  ).toEqual(['child', 'studio']);
  f.work.executeLifecycle(
    {
      operation: 'archive',
      itemId: 'studio',
      expectedRevision: f.work.readLifecycle('studio', f.actor).revision,
      requestId: 'archive-studio',
    },
    f.actor,
  );
  expect(f.work.readCollection('active', f.actor).records).toEqual([]);
  expect(
    f.work
      .readCollection('archive', f.actor)
      .records.map((record) => record.itemId)
      .sort(),
  ).toEqual(['child', 'studio']);
});
it('reports malformed records individually and reads source/link/kind tables once per collection', () => {
  const f = fixture();
  f.db.exec(
    "INSERT INTO items(id,parent_id,summary,status,profile,context_hints,first_seen,last_seen,created_at,updated_at) VALUES('bad','studio','Broken','active','manual','invalid-json','2026-10-30','2026-10-30','2026-10-30','2026-10-30')",
  );
  const prepare = vi.spyOn(Database.prototype, 'prepare');
  try {
    const collection = f.work.readCollection('active', f.actor);
    expect(collection.records.map((record) => record.itemId)).toEqual(['studio']);
    expect(collection.failures).toEqual([{ itemId: 'bad', code: 'invalid_record' }]);
    for (const table of ['sources', 'links', 'telos_work_kinds'])
      expect(
        prepare.mock.calls.filter(([sql]) => new RegExp(`FROM ${table}\\b`, 'i').test(sql)),
      ).toHaveLength(1);
    expect(() => f.work.readCollection('active', { kind: 'conversation', id: 'planning' })).toThrow(
      /operator/i,
    );
  } finally {
    prepare.mockRestore();
  }
});

it('keeps ancestry and lifecycle reads bounded as the number of sibling reports grows', () => {
  const f = fixture();
  const insert = f.db.prepare(
    `INSERT INTO items(id,parent_id,summary,status,profile,context_hints,first_seen,last_seen,created_at,updated_at) VALUES(?,'studio',?,'active','manual','{}',?,?,?,?)`,
  );
  for (let i = 0; i < 100; i++)
    insert.run(`child-${i}`, `Associate ${i}`, f.stamp, f.stamp, f.stamp, f.stamp);
  const prepare = vi.spyOn(Database.prototype, 'prepare');
  try {
    expect(f.work.readCollection('active', f.actor).records).toHaveLength(101);
    const ancestry = prepare.mock.calls.filter(([sql]) => /FROM items\b/i.test(sql));
    const lifecycle = prepare.mock.calls.filter(([sql]) =>
      /FROM telos_work_lifecycle\b/i.test(sql),
    );
    expect(ancestry.length).toBeLessThanOrEqual(2);
    expect(lifecycle.length).toBeLessThanOrEqual(1);
  } finally {
    prepare.mockRestore();
  }
});

it('restricts grouped evidence reads to the selected visible identities', () => {
  const f = fixture();
  const prepare = vi.spyOn(Database.prototype, 'prepare');
  try {
    f.work.readCollection('active', f.actor);
    for (const table of ['sources', 'links', 'telos_work_kinds']) {
      const sql = prepare.mock.calls.find(([sql]) =>
        new RegExp(`FROM ${table}\\b`, 'i').test(sql),
      )?.[0];
      expect(sql).toMatch(/WHERE .*item_id IN \(SELECT value FROM json_each\(\?\)\)/);
    }
  } finally {
    prepare.mockRestore();
  }
});

it('refuses corrupt empty lifecycle metadata instead of treating the item as active', () => {
  const f = fixture();
  f.db.prepare('INSERT INTO telos_work_lifecycle(item_id,data) VALUES(?,?)').run('studio', '');
  expect(() => f.work.readCollection('active', f.actor)).toThrow();
});
