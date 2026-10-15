import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelosItemStore } from '../telos-item-store.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'telos-items-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'telos.db');
  const db = new Database(path);
  cleanup.push(() => db.close());
  db.exec(`CREATE TABLE items (
    id TEXT PRIMARY KEY, summary TEXT, status TEXT, parent_id TEXT,
    intent TEXT, rationale TEXT, acceptance_criteria TEXT, updated_at TEXT, snoozed_until TEXT);
    CREATE TABLE history(id INTEGER PRIMARY KEY, item_id TEXT, old_status TEXT,
      new_status TEXT, changed_at TEXT);
    INSERT INTO items VALUES ('parent','Research','active',NULL,'Answer the question',
      'Inform a decision','["Compare contracts"]','original',NULL);
    INSERT INTO items VALUES ('child','Inspect sources','active','parent','','','[]','original',NULL);`);
  const store = new TelosItemStore(path);
  cleanup.push(() => store.close());
  let nextRequest = 0;
  const update = (itemId = 'child', note = 'Pinned source inspection completed.') => ({
    itemId,
    requestId: `request-${++nextRequest}`,
    expectedRevision: store.read(itemId).revision,
    status: 'completed' as const,
    note,
  });
  return { store, db, path, update };
}

describe('Telos item progress', () => {
  it('reads the contract and exact milestone IDs without creating schema', () => {
    const { store, db } = fixture();
    expect(store.read('parent')).toMatchObject({
      id: 'parent',
      status: 'active',
      acceptanceCriteria: ['Compare contracts'],
      children: [{ id: 'child', summary: 'Inspect sources', status: 'active' }],
      updates: [],
    });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='telos_item_updates'").get(),
    ).toBeUndefined();
    expect(() => store.read('missing')).toThrow('Telos item not found');
  });

  it('atomically persists completion, history and session-attributed evidence across connections', () => {
    const { store, db, path, update } = fixture();
    const before = store.read('child');
    const receipt = store.update(update(), 'session-a');
    expect(receipt.item).toMatchObject({ id: 'child', status: 'completed' });
    expect(receipt.item.revision).not.toBe(before.revision);
    expect(receipt.update).toMatchObject({
      sessionId: 'session-a',
      note: 'Pinned source inspection completed.',
    });
    expect(db.prepare('SELECT old_status,new_status FROM history').all()).toEqual([
      { old_status: 'active', new_status: 'completed' },
    ]);
    const other = new TelosItemStore(path);
    try {
      expect(other.read('child').updates).toEqual([receipt.update]);
      expect(other.read('parent').children[0].status).toBe('completed');
    } finally {
      other.close();
    }
  });

  it('rejects stale parent reads and refuses completion with any unfinished descendant', () => {
    const { store, db, update } = fixture();
    const parent = update('parent');
    expect(() => store.update(parent, 'session-a')).toThrow('Unfinished milestones');
    store.update(update(), 'session-a');
    expect(() => store.update(parent, 'session-a')).toThrow('Telos item changed');
    db.exec(
      "INSERT INTO items VALUES ('grandchild','Still outstanding','active','child','','','[]','original',NULL)",
    );
    expect(() => store.update(update('parent'), 'session-a')).toThrow('Unfinished milestones');
    expect(store.read('parent').status).toBe('active');
  });

  it('replays only the exact original request receipt, even after later progress', () => {
    const { store, db, update } = fixture();
    const input = update();
    const receipt = store.update(input, 'session-a');
    store.update(
      {
        ...update(),
        requestId: 'reopen',
        status: 'active',
        note: 'New evidence requires another check.',
      },
      'session-b',
    );
    expect(store.update(input, 'session-a')).toEqual(receipt);
    expect(store.read('child').status).toBe('active');
    expect(() => store.update({ ...input, note: 'Different claim' }, 'session-a')).toThrow(
      'Update request identity reused',
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM history').get()).toEqual({ n: 2 });
  });

  it('records progress without changing status and detects external item or milestone edits', () => {
    const { store, db, update } = fixture();
    const { status: _status, ...progress } = update(
      'parent',
      'Report saved; comparison still needs review.',
    );
    const receipt = store.update(progress, 'session-a');
    expect(receipt.item.status).toBe('active');
    expect(db.prepare('SELECT COUNT(*) AS n FROM history').get()).toEqual({ n: 0 });
    const stale = update();
    db.exec("UPDATE items SET summary='Changed by operator' WHERE id='child'");
    expect(() => store.update(stale, 'session-a')).toThrow('Telos item changed');
    const parent = update('parent');
    db.exec("UPDATE items SET status='completed' WHERE id='child'");
    expect(() => store.update(parent, 'session-a')).toThrow('Telos item changed');
  });

  it('rolls back status, progress and history together when persistence fails', () => {
    const { store, db, update } = fixture();
    db.exec(
      "CREATE TRIGGER refuse_history BEFORE INSERT ON history BEGIN SELECT RAISE(ABORT,'unavailable'); END",
    );
    expect(() => store.update(update(), 'session-a')).toThrow('unavailable');
    expect(store.read('child')).toMatchObject({ status: 'active', updates: [] });
    expect(db.prepare('SELECT updated_at FROM items WHERE id=?').get('child')).toEqual({
      updated_at: 'original',
    });
  });
});
