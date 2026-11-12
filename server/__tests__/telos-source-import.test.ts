import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { TelosRuntimeStore } from '../telos-runtime-store.js';
const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'telos-import-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'telos.db');
  TelosRuntimeStore.initialize(path);
  const store = new TelosRuntimeStore(path),
    db = new Database(path);
  cleanup.push(() => {
    db.close();
    store.close();
  });
  return { store, db };
}
const item = { id: 'imported', summary: 'Source title', profile: 'manual', sources: [] };
it('batches item/evidence reads and prepares writes once across a full import', () => {
  const { store } = fixture();
  const prepare = vi.spyOn(Database.prototype, 'prepare');
  try {
    expect(
      store.importSources({
        items: Array.from({ length: 500 }, (_, n) => ({ ...item, id: 'source-' + n })),
      }),
    ).toMatchObject({ created: 500 });
    expect(prepare.mock.calls.filter(([sql]) => /^SELECT/.test(sql))).toHaveLength(2);
    expect(prepare.mock.calls.length).toBeLessThan(10);
  } finally {
    prepare.mockRestore();
  }
});
it('rejects duplicate identities atomically', () => {
  const { store } = fixture();
  expect(() =>
    store.importSources({ items: [item, { ...item, summary: 'Conflicting title' }] }),
  ).toThrow(/Duplicate import/);
  expect(store.list().items).toEqual([]);
});
it('retains legacy evidence identities and keeps ambiguous colon tuples distinct', () => {
  const { store, db } = fixture();
  const source = {
    type: 'a:b',
    sourceId: 'c',
    url: '',
    title: 'Original',
    author: '',
    timestamp: '2026-11-07',
  };
  store.importSources({ items: [{ ...item, sources: [source] }] });
  const legacyId = createHash('sha256').update('imported:a:b:c').digest('hex').slice(0, 16);
  db.prepare('UPDATE sources SET id=?').run(legacyId);
  store.importSources({
    items: [
      { ...item, sources: [{ ...source, type: 'a', sourceId: 'b:c', title: 'Separate evidence' }] },
    ],
  });
  store.importSources({
    items: [{ ...item, sources: [{ ...source, title: 'Updated original' }] }],
  });
  expect(db.prepare('SELECT type,source_id,title FROM sources ORDER BY type').all()).toEqual([
    { type: 'a', source_id: 'b:c', title: 'Separate evidence' },
    { type: 'a:b', source_id: 'c', title: 'Updated original' },
  ]);
  expect(db.prepare('SELECT id FROM sources WHERE type=?').get('a:b')).toEqual({ id: legacyId });
});
it('refuses new children under completed or archived parents without changing imported work', () => {
  const { store, db } = fixture();
  const parent = store.create({ summary: 'Finished parent', profile: 'manual' }).item.id;
  store.action(parent, { action: 'done' });
  expect(() => store.importSources({ items: [{ ...item, parentId: parent }] })).toThrow(
    /Completed import parent/,
  );
  db.prepare("UPDATE items SET status='active' WHERE id=?").run(parent);
  db.prepare('INSERT INTO telos_work_lifecycle(item_id,data) VALUES(?,?)').run(
    parent,
    JSON.stringify({
      disposition: 'archived',
      restoreDisposition: 'active',
      pauseControlIds: [],
      generation: 1,
    }),
  );
  expect(() => store.importSources({ items: [{ ...item, parentId: parent }] })).toThrow(
    /Archived or trashed import parent/,
  );
  expect(db.prepare('SELECT count(*) AS n FROM items').get()).toEqual({ n: 1 });
});
