import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MitzoTelosStore } from '../telos-native-store.js';
import { TelosItemStore } from '../telos-item-store.js';
import { initializeTelosSchema } from '../telos-schema.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function path(initialize = true) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mitzo-telos-native-'));
  roots.push(root);
  const filename = join(root, 'telos.db');
  if (initialize) MitzoTelosStore.initialize(filename);
  return filename;
}
const outcome = {
  summary: 'Make Telos usable',
  intent: 'Own work in Mitzo',
  rationale: 'Reliable tracking',
  acceptanceCriteria: ['Edits persist'],
  milestones: ['Repair edits'],
  profile: 'manual',
  idempotencyKey: 'native-test',
};
it('checks interactive mutation authority after taking the original writer lock', () => {
  const filename = path(),
    plain = new MitzoTelosStore(filename);
  const id = plain.create('Existing', 'manual').item.id;
  plain.close();
  const observer = new Database(filename);
  observer.pragma('busy_timeout = 0');
  const store = new MitzoTelosStore(filename, {
    assertCurrentSync: () => {
      expect(() => observer.exec('BEGIN IMMEDIATE')).toThrow(/locked/);
      throw Error('revoked interactive authority');
    },
  });
  try {
    for (const mutate of [
      () => store.create('Denied', 'manual'),
      () => store.action(id, { action: 'priority', priority: 9 }),
      () => store.action(id, { action: 'done' }),
      () => store.createOutcome(outcome),
      () =>
        store.importSources({
          items: [{ id: 'denied', summary: 'Denied', profile: 'manual', sources: [] }],
        }),
    ])
      expect(mutate).toThrow('revoked interactive authority');
    expect(store.read(id)).toMatchObject({ summary: 'Existing', status: 'active' });
    expect(observer.prepare('SELECT priority FROM items WHERE id=?').get(id)).toEqual({
      priority: 5,
    });
    expect(store.list().items).toHaveLength(1);
  } finally {
    observer.close();
    store.close();
  }
});
it('upgrades original runtime receipts once and preserves their bytes across restart and later edits', () => {
  const filename = path(),
    store = new MitzoTelosStore(filename);
  const original = store.createOutcome(outcome);
  store.close();
  const db = new Database(filename);
  try {
    const saved = db
      .prepare('SELECT input_hash,receipt FROM mitzo_telos_creation_receipts')
      .get() as { input_hash: string; receipt: string };
    db.exec(
      'DROP TABLE mitzo_telos_creation_receipts; CREATE TABLE telos_runtime_creation_receipts(idempotency_key TEXT PRIMARY KEY,input_hash TEXT NOT NULL,receipt TEXT NOT NULL)',
    );
    db.prepare('INSERT INTO telos_runtime_creation_receipts VALUES(?,?,?)').run(
      outcome.idempotencyKey,
      saved.input_hash,
      saved.receipt,
    );
    db.prepare('UPDATE items SET summary=? WHERE id=?').run(
      'Later authored title',
      original.item.id,
    );
    initializeTelosSchema(db);
    initializeTelosSchema(db);
    const reopened = new MitzoTelosStore(filename);
    try {
      expect(reopened.createOutcome(outcome)).toMatchObject({
        created: false,
        item: { id: original.item.id, summary: outcome.summary },
      });
      expect(reopened.read(original.item.id).summary).toBe('Later authored title');
      expect(db.prepare('SELECT receipt FROM mitzo_telos_creation_receipts').get()).toEqual({
        receipt: saved.receipt,
      });
    } finally {
      reopened.close();
    }
  } finally {
    db.close();
  }
});
it('loads an outcome receipt with a constant number of reads across all milestones', () => {
  const store = new MitzoTelosStore(path());
  const prepare = vi.spyOn(Database.prototype, 'prepare');
  try {
    expect(
      store.createOutcome({
        ...outcome,
        milestones: Array.from({ length: 24 }, (_, n) => 'Milestone ' + n),
      }).item.childCount,
    ).toBe(24);
    expect(prepare.mock.calls.filter(([sql]) => /^SELECT/.test(sql))).toHaveLength(5);
  } finally {
    prepare.mockRestore();
    store.close();
  }
});
it('recovers the original creation receipt after later edits without rewriting the current item', () => {
  const store = new MitzoTelosStore(path());
  const created = store.createOutcome(outcome);
  store.editGuarded(
    {
      itemId: created.item.id,
      requestId: 'later-edit',
      expectedRevision: store.read(created.item.id).revision,
      summary: 'Updated title',
      note: 'Later decision',
    },
    'chat',
    () => {},
  );
  expect(store.createOutcome(outcome).item.summary).toBe(outcome.summary);
  expect(store.read(created.item.id).summary).toBe('Updated title');
  store.close();
});
it('creates a standalone database, durable outcome and milestones without Python or a management checkout', () => {
  const filename = path();
  let store = new MitzoTelosStore(filename);
  const result = store.createOutcome(outcome);
  expect(result).toMatchObject({
    ok: true,
    created: true,
    item: { summary: outcome.summary, childCount: 1 },
  });
  const id = result.item.id;
  expect(store.action(id, { action: 'priority', priority: 9 }, 'operator')).toEqual({ ok: true });
  store.close();
  store = new MitzoTelosStore(filename);
  expect(store.createOutcome(outcome)).toMatchObject({ created: false, item: { id } });
  expect(() => store.createOutcome({ ...outcome, intent: 'Changed' })).toThrow(
    /identity|different|conflict/i,
  );
  expect(store.list().items).toHaveLength(1);
  const progress = new TelosItemStore(filename);
  const child = progress.read(id).children[0].id;
  expect(() =>
    progress.update(
      {
        itemId: id,
        requestId: 'too-soon',
        expectedRevision: progress.read(id).revision,
        status: 'completed',
        note: 'Not ready',
      },
      'chat',
    ),
  ).toThrow(/Unfinished/);
  progress.update(
    {
      itemId: child,
      requestId: 'child-done',
      expectedRevision: progress.read(child).revision,
      status: 'completed',
      note: 'Verified child',
    },
    'chat',
  );
  progress.update(
    {
      itemId: id,
      requestId: 'done',
      expectedRevision: progress.read(id).revision,
      status: 'completed',
      note: 'Verified outcome',
    },
    'chat',
  );
  progress.close();
  store.close();
});
it('rolls back outcome, children, history and receipts together when a milestone fails', () => {
  const filename = path(),
    store = new MitzoTelosStore(filename),
    db = new Database(filename);
  db.exec(
    "CREATE TRIGGER refuse_milestone BEFORE INSERT ON items WHEN NEW.parent_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic milestone failure'); END",
  );
  expect(() => store.createOutcome(outcome)).toThrow('synthetic milestone failure');
  for (const table of ['items', 'history', 'mitzo_telos_creation_receipts'])
    expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  db.close();
  store.close();
});
it('snoozes by the host calendar day rather than the UTC date', () => {
  vi.stubEnv('TZ', 'Pacific/Auckland');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-02T00:30:00+13:00'));
  const filename = path(),
    store = new MitzoTelosStore(filename),
    db = new Database(filename);
  try {
    const item = store.create('Calendar snooze', 'manual').item;
    store.action(item.id, { action: 'snooze', days: 1 }, 'operator');
    expect(db.prepare('SELECT snoozed_until AS until FROM items WHERE id=?').get(item.id)).toEqual({
      until: '2026-01-03',
    });
  } finally {
    db.close();
    store.close();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});
it('creates new canonical database files with private permissions', () => {
  const filename = path(),
    store = new MitzoTelosStore(filename);
  expect(statSync(filename).mode & 0o077).toBe(0);
  store.close();
});
it('rejects non-synchronous creation authority before any effect', () => {
  const store = new MitzoTelosStore(path());
  expect(() => store.createOutcome(outcome, async () => {})).toThrow(/Synchronous/);
  expect(store.list().items).toEqual([]);
  store.close();
});
it('adopts existing canonical rows losslessly, including extensions, artifacts and durable IDs', () => {
  const filename = path(false);
  const db = new Database(filename);
  db.exec(
    readFileSync(new URL('./fixtures/telos-canonical-3077b7b4/fresh.sql', import.meta.url), 'utf8'),
  );
  db.exec(
    `INSERT INTO items(id,summary,profile,first_seen,last_seen,created_at,updated_at,context_hints) VALUES('original-id','Original title','work','2026-01-01','2026-01-02','2026-01-01','2026-01-02','{"unknown":{"keep":true}}'); CREATE TABLE private_extension(id TEXT, payload BLOB); INSERT INTO private_extension VALUES('e',X'0102');`,
  );
  const before = db.prepare('SELECT * FROM items').all();
  initializeTelosSchema(db);
  db.close();
  const store = new MitzoTelosStore(filename);
  expect(store.list().items[0]).toMatchObject({ id: 'original-id' });
  store.close();
  const after = new Database(filename);
  expect(after.prepare('SELECT * FROM items').all()).toEqual(before);
  expect(after.prepare('SELECT hex(payload) AS value FROM private_extension').get()).toEqual({
    value: '0102',
  });
  after.close();
});
it('reads a whole collection and lifecycle in four queries, independent of item count', () => {
  const store = new MitzoTelosStore(path());
  for (let n = 0; n < 50; n++) store.create('Item ' + n, 'manual');
  const prepare = vi.spyOn(Database.prototype, 'prepare');
  try {
    expect(store.list().items).toHaveLength(50);
    expect(prepare.mock.calls).toHaveLength(4);
  } finally {
    prepare.mockRestore();
    store.close();
  }
});
it('changes priority through its existing owner without initializing other stores', () => {
  const store = new MitzoTelosStore(path()),
    item = store.create('Priority', 'manual').item;
  const execute = vi.spyOn(Database.prototype, 'exec');
  try {
    store.action(item.id, { action: 'priority', priority: 9 }, 'operator');
    expect(execute).not.toHaveBeenCalled();
  } finally {
    execute.mockRestore();
    store.close();
  }
});
it('lists committed items without taking a writer lock and keeps completed children under active parents', () => {
  const filename = path(),
    store = new MitzoTelosStore(filename);
  const result = store.createOutcome(outcome);
  const progress = new TelosItemStore(filename),
    child = result.item.children[0].id;
  progress.update(
    {
      itemId: child,
      requestId: 'finish',
      expectedRevision: progress.read(child).revision,
      status: 'completed',
      note: 'Verified',
    },
    'chat',
  );
  const writer = new Database(filename);
  writer.exec('BEGIN IMMEDIATE');
  const reader = new MitzoTelosStore(filename, { readOnly: true });
  expect(reader.list().items[0]).toMatchObject({ id: result.item.id, completedChildCount: 1 });
  reader.close();
  writer.exec('ROLLBACK');
  writer.close();
  progress.close();
  store.close();
});
