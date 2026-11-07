import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateTelosDatabase } from '../telos-migration.js';
import { MitzoTelosStore } from '../telos-native-store.js';
const roots: string[] = [];
it('keeps backup bytes private from the first write in an existing destination directory', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'telos-private-migrate-'));
  roots.push(root);
  const source = join(root, 'source.db');
  new MitzoTelosStore(source).close();
  const original = Database.prototype.backup;
  const backup = vi.spyOn(Database.prototype, 'backup').mockImplementation(function (
    this: Database.Database,
    ...args: Parameters<Database.Database['backup']>
  ) {
    expect(statSync(args[0]).mode & 0o777).toBe(0o600);
    return original.apply(this, args);
  });
  try {
    expect((await migrateTelosDatabase(source, join(root, 'target.db'))).verified).toBe(true);
    expect(backup).toHaveBeenCalledOnce();
  } finally {
    backup.mockRestore();
  }
});
it.each(['source', 'destination'])(
  'refuses relocation through a retained %s file family',
  async (role) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'telos-family-migrate-'));
    roots.push(root);
    const source = join(root, 'legacy', 'telos.db');
    const destination = join(root, 'native', 'telos.db');
    new MitzoTelosStore(source).close();
    mkdirSync(join(root, role === 'source' ? 'legacy' : 'native', '.telos-file-owners'), {
      recursive: true,
    });
    await expect(migrateTelosDatabase(source, destination)).rejects.toThrow(/retained.*family/i);
  },
);
it('hashes artifact BLOB bytes directly without expanding them into JSON arrays', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'telos-blob-'));
  roots.push(root);
  const source = join(root, 'source.db'),
    store = new MitzoTelosStore(source),
    db = new Database(source);
  db.exec('CREATE TABLE artifact_bytes(id INTEGER PRIMARY KEY,bytes BLOB)');
  db.prepare('INSERT INTO artifact_bytes(bytes) VALUES(?)').run(Buffer.alloc(1024 * 1024, 0xa5));
  const json = vi.spyOn(Buffer.prototype, 'toJSON').mockImplementation(() => {
    throw Error('BLOB expanded into JSON');
  });
  try {
    expect((await migrateTelosDatabase(source, join(root, 'target.db'))).verified).toBe(true);
  } finally {
    json.mockRestore();
    db.close();
    store.close();
  }
});
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
it('backs up a WAL database, retains unknown tables and BLOBs, and never overwrites a destination', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'telos-migrate-'));
  roots.push(root);
  const source = join(root, 'legacy.db'),
    target = join(root, 'native', 'telos.db');
  const store = new MitzoTelosStore(source);
  const item = store.create('Legacy title', 'manual').item;
  const db = new Database(source);
  db.exec(
    "CREATE TABLE retained_keys(key TEXT PRIMARY KEY,value BLOB) WITHOUT ROWID; INSERT INTO retained_keys VALUES('saved',X'ff00');",
  );
  db.exec(
    "CREATE TABLE retained_artifacts(id TEXT PRIMARY KEY,bytes BLOB); INSERT INTO retained_artifacts VALUES('r1',X'000102ff')",
  );
  const receipt = await migrateTelosDatabase(source, target);
  expect(receipt.verified).toBe(true);
  const migrated = new Database(target);
  expect(migrated.prepare('SELECT id FROM items').get()).toEqual({ id: item.id });
  expect(migrated.prepare('SELECT hex(bytes) AS bytes FROM retained_artifacts').get()).toEqual({
    bytes: '000102FF',
  });
  migrated.close();
  await expect(migrateTelosDatabase(source, target)).rejects.toThrow(/exists/);
  expect(db.prepare('SELECT summary FROM items').get()).toEqual({ summary: 'Legacy title' });
  store.close();
  db.close();
});
