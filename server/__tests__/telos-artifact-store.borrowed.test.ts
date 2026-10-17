import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { TelosArtifactStore } from '../telos-artifact-store.js';

const databases: Database.Database[] = [];
afterEach(() =>
  databases.splice(0).forEach((db) => {
    if (db.open) db.close();
  }),
);

it('keeps artifact save inside the exact work transaction and leaves borrowed connection lifetime with its owner', () => {
  const db = new Database(':memory:');
  databases.push(db);
  db.pragma('foreign_keys = ON');
  db.exec(
    "CREATE TABLE items(id TEXT PRIMARY KEY,profile TEXT); INSERT INTO items VALUES('item','manual'); CREATE TABLE links(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,description TEXT,created_at TEXT)",
  );
  const borrow = Reflect.get(TelosArtifactStore, 'borrowConnection');
  expect(typeof borrow).toBe('function');
  const artifacts = (borrow as (db: Database.Database) => TelosArtifactStore)(db);
  expect(() =>
    db.transaction(() => {
      artifacts.save({
        itemId: 'item',
        filename: 'origin.json',
        title: 'Reviewed source',
        bytes: Buffer.from('exact retained source'),
        sessionId: 'source-capture:operator',
        requestId: 'same-request',
      });
      throw new Error('work mutation refused');
    })(),
  ).toThrow('work mutation refused');
  expect(db.prepare('SELECT COUNT(*) AS count FROM telos_artifact_revisions').get()).toEqual({
    count: 0,
  });
  artifacts.close();
  expect(db.open).toBe(true);
  const reopened = (borrow as (db: Database.Database) => TelosArtifactStore)(db);
  const first = db.transaction(() =>
    reopened.save({
      itemId: 'item',
      filename: 'origin.json',
      title: 'Reviewed source',
      bytes: Buffer.from('exact retained source'),
      sessionId: 'source-capture:operator',
      requestId: 'same-request',
    }),
  )();
  expect(reopened.read(first.id, first.revision).bytes.toString()).toBe('exact retained source');
  expect(
    reopened.save({
      itemId: 'item',
      filename: 'origin.json',
      title: 'Reviewed source',
      bytes: Buffer.from('exact retained source'),
      sessionId: 'source-capture:operator',
      requestId: 'same-request',
    }),
  ).toEqual(first);
  reopened.close();
  expect(db.prepare('SELECT COUNT(*) AS count FROM telos_artifact_revisions').get()).toEqual({
    count: 1,
  });
});
