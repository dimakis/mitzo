import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { SymposiumProfileStore } from '../symposium-profiles.js';

const closers: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0).reverse()) close();
});

it('reuses prepared profile reads while observing changed, missing and invalid rows afresh', () => {
  const db = new Database(':memory:');
  closers.push(() => db.close());
  const prepare = db.prepare;
  const statements: Array<{ sql: string; reads: ReturnType<typeof vi.fn> }> = [];
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const statement = Reflect.apply(prepare, db, [sql]);
    if (sql.includes('FROM symposium_profile_versions WHERE owner = ? AND profile_id = ?')) {
      const get = statement.get;
      const reads = vi.fn((...args: unknown[]) => Reflect.apply(get, statement, args));
      vi.spyOn(statement, 'get').mockImplementation(reads);
      statements.push({ sql, reads });
    }
    return statement;
  });
  const profiles = new SymposiumProfileStore(':memory:', db);
  const definition = {
    name: 'Fresh profile',
    role: 'agent' as const,
    instructions: 'Read current rows.',
    expectedOutput: 'Fresh values',
    acceptanceCriteria: ['Validate each read'],
    modelPolicyRole: 'agent',
  };
  const insert = db.prepare('INSERT INTO symposium_profile_versions VALUES (?, ?, ?, ?, ?)');
  insert.run('owner', 'fresh', 1, JSON.stringify(definition), 'a'.repeat(64));
  const first = profiles.get('owner', 'fresh', 1)!;
  expect(first.definition.name).toBe('Fresh profile');
  first.definition.name = 'Mutated returned object';
  expect(profiles.get('owner', 'fresh', 1)?.definition.name).toBe('Fresh profile');
  expect(profiles.get('owner', 'fresh')?.revision).toBe(1);
  db.prepare('UPDATE symposium_profile_versions SET definition=?').run(
    JSON.stringify({ ...definition, name: 'Changed profile' }),
  );
  expect(profiles.get('owner', 'fresh', 1)?.definition.name).toBe('Changed profile');
  insert.run('owner', 'fresh', 2, JSON.stringify(definition), 'b'.repeat(64));
  expect(profiles.get('owner', 'fresh')?.revision).toBe(2);
  expect(profiles.get('other', 'fresh', 1)).toBeNull();
  db.prepare('UPDATE symposium_profile_versions SET definition=? WHERE revision=1').run('{}');
  expect(() => profiles.get('owner', 'fresh', 1)).toThrow();
  db.prepare('DELETE FROM symposium_profile_versions').run();
  expect(profiles.get('owner', 'fresh', 1)).toBeNull();
  expect(statements).toHaveLength(2);
  expect(statements.reduce((sum, entry) => sum + entry.reads.mock.calls.length, 0)).toBe(8);
  expect(() => profiles.get('owner', 'fresh', 0)).toThrow();
  expect(() => profiles.get('owner', 'fresh', 1.5)).toThrow();
  expect(() => profiles.get('owner', 'fresh', NaN)).toThrow();
  expect(() => profiles.get('', 'fresh', 1)).toThrow();
  expect(() => profiles.get('owner', '', 1)).toThrow();
  expect(statements.reduce((sum, entry) => sum + entry.reads.mock.calls.length, 0)).toBe(8);
});

it('keeps compiled reads within each store and preserves shared database ownership', () => {
  const db = new Database(':memory:');
  closers.push(() => db.close());
  const prepare = vi.spyOn(db, 'prepare');
  const first = new SymposiumProfileStore(':memory:', db);
  const second = new SymposiumProfileStore(':memory:', db);
  expect(
    prepare.mock.calls.filter(([sql]) =>
      sql.includes('FROM symposium_profile_versions WHERE owner = ? AND profile_id = ?'),
    ),
  ).toHaveLength(4);
  first.close();
  expect(db.open).toBe(true);
  expect(second.get('owner', 'missing', 1)).toBeNull();
  second.close();
  expect(db.open).toBe(true);
  const owned = new SymposiumProfileStore(':memory:');
  owned.close();
  expect(() => owned.get('owner', 'missing', 1)).toThrow();
});
