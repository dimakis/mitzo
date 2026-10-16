import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelosWorkStore } from '../telos-work-store.js';
const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((f) => f()),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'telos-origin-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'telos.db');
  const db = new Database(path);
  cleanups.push(() => db.close());
  db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY,parent_id TEXT,summary TEXT,updated_at TEXT,idempotency_key TEXT,context_hints TEXT);
 CREATE TABLE sources(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,raw_snippet TEXT,timestamp TEXT);
 CREATE TABLE links(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,description TEXT,created_at TEXT);
 INSERT INTO items VALUES('new',NULL,'Studio','original','planning:hash','{"session_ids":["planning"]}'),('milestone','new','Plan','original',NULL,'{}'),('other',NULL,'Other','original',NULL,'{}');`);
  const work = new TelosWorkStore(path, {
    ordinaryConversation: () => false,
    sourceConversation: (id) => id === 'planning',
  });
  cleanups.push(() => work.close());
  return { work, db };
}
it('records the actual creator as origin exactly once while preserving history and unknown reviewed context', () => {
  const { work, db } = fixture();
  const input = { itemId: 'new', idempotencyKey: 'planning:hash' };
  const actor = { kind: 'conversation' as const, id: 'planning' };
  work.recordCreatedOrigin(input, actor);
  work.recordCreatedOrigin(input, actor);
  const record = work.read('new', { kind: 'operator', id: 'user' });
  expect(record).toMatchObject({
    kind: 'outcome',
    links: [
      {
        role: 'origin',
        conversation: { namespace: 'mitzo', conversationId: 'planning' },
        availability: 'available',
      },
    ],
    assignments: [],
    sources: [],
    attempts: [],
  });
  expect(record.links).toHaveLength(1);
  expect(work.read('milestone', { kind: 'operator', id: 'user' }).kind).toBeNull();
  expect(db.prepare('SELECT updated_at FROM items WHERE id=?').get('new')).toEqual({
    updated_at: 'original',
  });
  expect(() => work.read('new', actor)).toThrow(/authorized/);
});
it('refuses unknown creators, operator substitution and unrelated canonical items', () => {
  const { work } = fixture();
  for (const [input, actor] of [
    [
      { itemId: 'other', idempotencyKey: 'planning:hash' },
      { kind: 'conversation', id: 'planning' },
    ],
    [
      { itemId: 'new', idempotencyKey: 'planning:hash' },
      { kind: 'conversation', id: 'unknown' },
    ],
    [
      { itemId: 'new', idempotencyKey: 'planning:hash' },
      { kind: 'operator', id: 'planning' },
    ],
    [
      { itemId: 'new', idempotencyKey: 'planning:different' },
      { kind: 'conversation', id: 'planning' },
    ],
  ] as const)
    expect(() => work.recordCreatedOrigin(input, actor)).toThrow();
  expect(work.read('new', { kind: 'operator', id: 'user' }).links).toEqual([]);
});
