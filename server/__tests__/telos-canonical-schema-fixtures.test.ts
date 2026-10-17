import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const directory = new URL('./fixtures/telos-canonical/', import.meta.url);

it.each(['fresh', 'upgraded'])('retains actual MGMT %s schema invariants', (variant) => {
  const schema = readFileSync(new URL(`${variant}.sql`, directory), 'utf8');
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'));
  expect(createHash('sha256').update(schema).digest('hex')).toBe(manifest.schemas[variant]);
  expect(manifest.owner.revision).toMatch(/^[a-f0-9]{40}$/);
  expect(manifest.upgrade.priority).toBe(10);
  expect(manifest.upgrade.firstSeenPreserved).toBe(true);
  expect(manifest.upgrade.historyPreserved).toBe(true);
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    const columns = db.pragma('table_info(items)') as { name: string; notnull: number }[];
    // This fixture must expose the current defect, never add a test-only category migration.
    expect(columns.some((column) => column.name === 'categories')).toBe(false);
    for (const name of ['first_seen', 'last_seen', 'created_at', 'updated_at'])
      expect(columns.find((column) => column.name === name)?.notnull).toBe(1);
    expect(() =>
      db
        .prepare('INSERT INTO items(id,summary,profile) VALUES(?,?,?)')
        .run('missing-timestamps', 'Missing timestamps', 'manual'),
    ).toThrow(/first_seen/);
    const insert = db.prepare(`INSERT INTO items
      (id,summary,profile,first_seen,last_seen,created_at,updated_at,priority)
      VALUES(?,?,?,'2026-10-16T10:00:00','2026-10-16T10:00:00',
      '2026-10-16T10:00:00','2026-10-16T10:00:00',?)`);
    for (const priority of [0, 11, 1.5, 'bad'])
      expect(() =>
        insert.run(`invalid-${priority}`, 'Invalid priority', 'manual', priority),
      ).toThrow(/CHECK/);
    insert.run('valid', 'Home studio', 'manual', 5);
    expect(db.prepare('SELECT priority FROM items WHERE id=?').get('valid')).toEqual({
      priority: 5,
    });
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='history'").get()).toBeDefined();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});
