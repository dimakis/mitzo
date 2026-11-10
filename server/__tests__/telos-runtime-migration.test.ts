import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  statSync,
  mkdirSync,
  symlinkSync,
  existsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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
it('requires explicit archival and retains exact orphan rows privately without inventing parents', () => {
  const { source, root, destination } = fixture();
  source.db.pragma('foreign_keys = OFF');
  // Extension columns can shadow SQLite's internal rowid. Valid and orphan
  // rows deliberately share this value; only the real orphan may be detached.
  source.db.exec('ALTER TABLE history ADD COLUMN rowid INTEGER DEFAULT 2');
  source.db
    .prepare(
      `INSERT INTO history(item_id,old_status,new_status,changed_at)
     VALUES('missing-parent','active','done','2026-11-10T00:00:00')`,
    )
    .run();
  source.db
    .prepare(
      `INSERT INTO sources(id,item_id,type,source_id,url,title,author,timestamp,raw_snippet)
     VALUES('orphan-source','missing-parent','manual','original','','Original π source',
     'original author','2026-11-10T00:00:00',?)`,
    )
    .run(Buffer.from([0, 255, 1]));
  const original = source.db.prepare('SELECT * FROM history ORDER BY id').all();
  const originalSources = source.db.prepare('SELECT * FROM sources ORDER BY id').all();
  const arguments_ = [
    script,
    '--source',
    source.dbPath,
    '--destination',
    destination,
    '--writers-stopped',
  ];
  expect(spawnSync('python3', arguments_).status).not.toBe(0);
  expect(existsSync(destination)).toBe(false);
  source.db
    .exec(`CREATE TABLE unsupported_orphan(id TEXT PRIMARY KEY,item_id TEXT REFERENCES items(id));
    INSERT INTO unsupported_orphan VALUES('unsupported','missing-parent');`);
  expect(spawnSync('python3', [...arguments_, '--archive-orphans']).status).not.toBe(0);
  expect(existsSync(destination + '.recovery.json')).toBe(false);
  source.db.exec('DROP TABLE unsupported_orphan');
  const receipt = JSON.parse(
    execFileSync('python3', [...arguments_, '--archive-orphans'], { encoding: 'utf8' }),
  );
  expect(receipt).toMatchObject({
    ok: true,
    verified: true,
    recoveryArchive: { rows: 2, byTable: { history: 1, sources: 1 } },
  });
  const archivePath = destination + '.recovery.json';
  expect(statSync(archivePath).mode & 0o777).toBe(0o600);
  const archive = JSON.parse(readFileSync(archivePath, 'utf8'));
  const orphan = original.at(-1) as Record<string, unknown>;
  expect(archive.rows[0]).toMatchObject({
    table: 'history',
    columns: Object.keys(orphan),
    values: Object.values(orphan),
  });
  expect(archive.sourceSnapshot).toEqual(receipt.snapshot);
  const originalSource = originalSources[0] as Record<string, unknown>;
  expect(archive.rows[1]).toMatchObject({
    table: 'sources',
    columns: Object.keys(originalSource),
    values: Object.values(originalSource).map((value) =>
      Buffer.isBuffer(value) ? { sqliteBlobBase64: value.toString('base64') } : value,
    ),
  });
  const target = new Database(destination, { readonly: true });
  try {
    expect(target.pragma('foreign_key_check')).toEqual([]);
    expect(target.prepare('SELECT * FROM history ORDER BY id').all()).toEqual(
      original.slice(0, -1),
    );
    expect(target.prepare('SELECT * FROM sources').all()).toEqual([]);
    expect(target.prepare('SELECT id FROM items ORDER BY id').all()).toEqual([{ id: 'studio' }]);
  } finally {
    target.close();
  }
  expect(source.db.prepare('SELECT * FROM history ORDER BY id').all()).toEqual(original);
  expect(source.db.prepare('SELECT * FROM sources ORDER BY id').all()).toEqual(originalSources);
  const retainedArchive = readFileSync(archivePath);
  const migrationReceipt = readFileSync(destination + '.migration.json');
  vi.stubEnv('TELOS_DB_PATH', destination);
  unlinkSync(destination + '.migration.json');
  execFileSync('mkfifo', ['-m', '600', destination + '.migration.json']);
  expect(() => ensureTelosRuntimeStorage(root)).toThrow(/recovery archive/);
  unlinkSync(destination + '.migration.json');
  writeFileSync(destination + '.migration.json', migrationReceipt, { mode: 0o600 });
  writeFileSync(destination + '.migration.json', '{');
  expect(() => ensureTelosRuntimeStorage(root)).toThrow(/recovery archive/);
  writeFileSync(destination + '.migration.json', migrationReceipt);
  writeFileSync(archivePath, Buffer.concat([retainedArchive, Buffer.from('changed')]));
  expect(() => ensureTelosRuntimeStorage(root)).toThrow(/recovery archive/);
  writeFileSync(archivePath, retainedArchive);
  unlinkSync(archivePath);
  expect(() => ensureTelosRuntimeStorage(root)).toThrow(/recovery archive/);
  unlinkSync(destination + '.migration.json');
  expect(() => ensureTelosRuntimeStorage(root)).toThrow(/recovery archive/);
  writeFileSync(destination + '.migration.json', migrationReceipt, { mode: 0o600 });
  writeFileSync(archivePath, retainedArchive, { mode: 0o600 });
  ensureTelosRuntimeStorage(root);
  // Model publication interrupted after the archive, before runtime/receipt.
  unlinkSync(destination);
  unlinkSync(destination + '.migration.json');
  vi.stubEnv('TELOS_DB_PATH', destination);
  expect(() => ensureTelosRuntimeStorage(root)).toThrow(/Retained Telos family/);
  expect(existsSync(destination)).toBe(false);
  expect(spawnSync('python3', [...arguments_, '--archive-orphans']).status).not.toBe(0);
  expect(readFileSync(archivePath)).toEqual(retainedArchive);
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
