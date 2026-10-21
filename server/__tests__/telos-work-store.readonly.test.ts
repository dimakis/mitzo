import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { TelosWorkStore } from '../telos-work-store.js';
import { createTelosSourceApprovalData } from './fixtures/telos-source-approval-data.js';

it('reads current canonical authority without schema writes and cannot mutate work', () => {
  const f = createTelosSourceApprovalData();
  const read = TelosWorkStore.openReadOnly(f.dbPath, { ordinaryConversation: () => false });
  try {
    const before = read.read('studio', f.actor);
    expect(before).toEqual(f.work.read('studio', f.actor));
    expect(() => read.read('studio', { kind: 'conversation', id: 'foreign' })).toThrow(
      'not authorized',
    );
    expect(() =>
      read.execute(
        {
          operation: 'classify',
          itemId: 'studio',
          requestId: 'readonly-write',
          expectedRevision: before.revision,
          kind: 'outcome',
        },
        f.actor,
      ),
    ).toThrow(/readonly/i);
    expect(f.work.read('studio', f.actor)).toEqual(before);
  } finally {
    read.close();
    f.close();
  }
});

it('refuses missing schema without creating or migrating it', () => {
  const f = createTelosSourceApprovalData();
  const path = join(dirname(f.dbPath), 'uninitialized.db');
  const db = new Database(path);
  try {
    db.exec('CREATE TABLE items(id TEXT,parent_id TEXT,updated_at TEXT)');
    const before = db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all();
    expect(() => TelosWorkStore.openReadOnly(path, { ordinaryConversation: () => true })).toThrow(
      /no such table/,
    );
    expect(db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all()).toEqual(
      before,
    );
  } finally {
    db.close();
    f.close();
  }
});
