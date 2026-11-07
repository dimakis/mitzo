import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, statSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import { ensureTelosRuntimeStorage } from '../telos-runtime-storage.js';
import { TelosRuntimeStore } from '../telos-runtime-store.js';
const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.unstubAllEnvs();
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
});
const script = new URL('../../scripts/migrate-telos.py', import.meta.url).pathname;
function fixture() {
  const source = createTelosCanonicalData();
  cleanup.push(() => source.close());
  const root = mkdtempSync(join(tmpdir(), 'telos-migrate-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const destination = join(root, 'private', 'telos.db');
  return { source, root, destination };
}
it('copies every schema object and row, including artifacts, unknown extensions and WAL content', () => {
  const { source, destination } = fixture();
  source.db.exec(`CREATE TABLE unknown_extension(id TEXT PRIMARY KEY,bytes BLOB);
    INSERT INTO unknown_extension VALUES('private',X'000102ff');`);
  const result = JSON.parse(
    execFileSync(
      'python3',
      [script, '--source', source.dbPath, '--destination', destination, '--writers-stopped'],
      { encoding: 'utf8' },
    ),
  );
  expect(result).toMatchObject({ ok: true, verified: true });
  expect(statSync(destination).mode & 0o777).toBe(0o600);
  expect(statSync(destination + '.migration.json').mode & 0o777).toBe(0o600);
  const target = new Database(destination, { readonly: true });
  try {
    expect(target.prepare('SELECT * FROM items').all()).toEqual(
      source.db.prepare('SELECT * FROM items').all(),
    );
    expect(target.prepare('SELECT * FROM history').all()).toEqual(
      source.db.prepare('SELECT * FROM history').all(),
    );
    expect(target.prepare('SELECT * FROM unknown_extension').all()).toEqual(
      source.db.prepare('SELECT * FROM unknown_extension').all(),
    );
    expect(target.prepare('SELECT * FROM telos_artifact_revisions').all()).toEqual(
      source.db.prepare('SELECT * FROM telos_artifact_revisions').all(),
    );
    expect(
      target.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name').all(),
    ).toEqual(
      source.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name').all(),
    );
  } finally {
    target.close();
  }
  const bytes = readFileSync(destination);
  const retry = spawnSync('python3', [
    script,
    '--source',
    source.dbPath,
    '--destination',
    destination,
    '--writers-stopped',
  ]);
  expect(retry.status).not.toBe(0);
  expect(readFileSync(destination)).toEqual(bytes);
});
it('requires explicit stopped-writer acknowledgement and refuses retained SQLite owner families', () => {
  const { source, root, destination } = fixture();
  expect(
    spawnSync('python3', [script, '--source', source.dbPath, '--destination', destination]).status,
  ).not.toBe(0);
  mkdirSync(join(root, '.telos-file-owners'));
  const blocked = spawnSync('python3', [
    script,
    '--source',
    source.dbPath,
    '--destination',
    join(root, 'telos.db'),
    '--writers-stopped',
  ]);
  expect(blocked.status).not.toBe(0);
});
it.each(['source', 'destination'])('refuses a broken retained-family marker at the %s', (role) => {
  const { source, root } = fixture();
  const destination = join(root, 'telos.db');
  symlinkSync(
    join(root, 'missing-owner-family'),
    join(role === 'source' ? dirname(source.dbPath) : root, '.telos-file-owners'),
  );
  expect(
    spawnSync('python3', [
      script,
      '--source',
      source.dbPath,
      '--destination',
      destination,
      '--writers-stopped',
    ]).status,
  ).not.toBe(0);
});
it('preserves a legacy creation identity and requires inspection when its original receipt is unavailable', () => {
  const { source, root, destination } = fixture();
  source.db
    .prepare('UPDATE items SET idempotency_key=? WHERE id=?')
    .run('reviewed-before-cutover', 'studio');
  execFileSync('python3', [
    script,
    '--source',
    source.dbPath,
    '--destination',
    destination,
    '--writers-stopped',
  ]);
  vi.stubEnv('TELOS_DB_PATH', destination);
  ensureTelosRuntimeStorage(root);
  const store = new TelosRuntimeStore(destination);
  try {
    expect(() =>
      store.createOutcome(
        {
          summary: 'Home studio',
          intent: 'Record music',
          rationale: 'Make music',
          acceptanceCriteria: ['Approved plan'],
          profile: 'manual',
          milestones: ['Next step'],
          idempotencyKey: 'reviewed-before-cutover',
        },
        () => {},
      ),
    ).toThrow(/Historical Telos creation identity/);
    expect(
      source.db
        .prepare('SELECT id FROM items WHERE idempotency_key=?')
        .get('reviewed-before-cutover'),
    ).toEqual({ id: 'studio' });
    expect(store.read('studio')).toMatchObject({ id: 'studio' });
    expect(store.list().items).toHaveLength(1);
  } finally {
    store.close();
  }
});
