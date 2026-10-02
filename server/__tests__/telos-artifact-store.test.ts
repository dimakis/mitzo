import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TelosArtifactStore } from '../telos-artifact-store.js';

const dirs: string[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'telos-artifacts-'));
  dirs.push(dir);
  const path = join(dir, 'telos.db');
  const db = new Database(path);
  db.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, summary TEXT);
    INSERT INTO items VALUES ('task-a', 'Recovery');
    INSERT INTO items VALUES ('task-b', 'Other');
    CREATE TABLE links (id TEXT PRIMARY KEY, item_id TEXT, type TEXT, url TEXT, title TEXT,
      description TEXT DEFAULT '', created_at TEXT);`);
  db.close();
  return { path, store: new TelosArtifactStore(path) };
}
const input = {
  itemId: 'task-a',
  filename: 'spec.md',
  title: 'Recovery spec',
  bytes: Buffer.from('# Original'),
  sessionId: 'session-a',
  sourcePath: '/sandbox/spec.md',
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('durable Telos artifacts', () => {
  it('persists bytes and provenance in live Telos, links the item, and reads from a fresh store', () => {
    const { path, store } = setup();
    const receipt = store.save(input);
    expect(receipt).toMatchObject({
      revision: 1,
      filename: 'spec.md',
      itemId: 'task-a',
      sessionId: 'session-a',
    });
    expect(receipt.url).toBe(`/api/telos/artifacts/${receipt.id}?revision=1`);
    store.close();
    const next = new TelosArtifactStore(path);
    expect(next.read(receipt.id).bytes.equals(input.bytes)).toBe(true);
    expect(next.list({ itemId: 'task-a' })).toHaveLength(1);
    expect(next.list({ query: 'Recovery' })).toHaveLength(1);
    const db = new Database(path);
    expect(db.prepare('SELECT url FROM links WHERE item_id=?').get('task-a')).toEqual({
      url: `/api/telos/artifacts/${receipt.id}`,
    });
    db.close();
    next.close();
  });
  it('retries idempotently and preserves historical revisions when another session edits', () => {
    const { store } = setup();
    const first = store.save(input);
    expect(store.save(input).revision).toBe(1);
    const second = store.save({
      ...input,
      bytes: Buffer.from('# Revised'),
      sessionId: 'session-b',
    });
    expect(second).toMatchObject({ id: first.id, revision: 2, sessionId: 'session-b' });
    expect(store.read(first.id, 1).bytes.toString()).toBe('# Original');
    expect(store.read(first.id).bytes.toString()).toBe('# Revised');
    expect(store.list({ itemId: 'task-b' })).toEqual([]);
    store.close();
  });
  it('rejects nonexistent tasks, oversized documents, traversal filenames and absent stores', () => {
    const { path, store } = setup();
    expect(() => store.save({ ...input, itemId: 'missing' })).toThrow('Telos item not found');
    expect(() => store.save({ ...input, filename: '../secret' })).toThrow();
    expect(() => store.save({ ...input, bytes: Buffer.alloc(5 * 1024 * 1024 + 1) })).toThrow();
    expect(store.list({})).toEqual([]);
    expect(() => store.read('missing')).toThrow('Artifact not found');
    store.close();
    expect(() => new TelosArtifactStore(path + '-missing')).toThrow();
  });
});
