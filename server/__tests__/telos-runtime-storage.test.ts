import { resetOfflineUserEnvironment } from './fixtures/offline-user-home.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  statSync,
  chmodSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { selectedTelosDatabaseFiles } from '@mitzo/protocol/telos-sqlite-owners';
import { ensureTelosRuntimeStorage } from '../telos-runtime-storage.js';
import { TelosRuntimeStore } from '../telos-runtime-store.js';
import { isPrivateCodexPath } from '../codex-private-path.js';
import Database from 'better-sqlite3';
const roots: string[] = [];
beforeEach(resetOfflineUserEnvironment);
afterEach(() => {
  vi.unstubAllEnvs();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function root() {
  const path = mkdtempSync(join(tmpdir(), 'telos-storage-'));
  roots.push(path);
  return path;
}
it.each(['shared', 'symlink'] as const)(
  'refuses existing storage under a %s parent directory',
  (kind) => {
    const directory = root();
    const database = join(directory, 'telos.db');
    TelosRuntimeStore.initialize(database);
    let selected = database;
    if (kind === 'shared') chmodSync(directory, 0o755);
    else {
      const alias = join(root(), 'alias');
      symlinkSync(directory, alias);
      selected = join(alias, 'telos.db');
    }
    vi.stubEnv('TELOS_DB_PATH', selected);
    expect(() => ensureTelosRuntimeStorage(root())).toThrow(/Private owned.*directory/);
    expect(statSync(database).mode & 0o777).toBe(0o600);
  },
);
it('selects private application storage independently of the management checkout', () => {
  vi.stubEnv('REPO_PATH', root());
  vi.stubEnv('TELOS_DB_PATH', '');
  vi.stubEnv('MITZO_TELOS_DATA_DIR', '');
  vi.stubEnv('XDG_DATA_HOME', '');
  expect(selectedTelosDatabaseFiles().canonical).toBe(
    join(homedir(), '.mitzo/private/telos/telos.db'),
  );
  const custom = join(root(), 'custom');
  vi.stubEnv('MITZO_TELOS_DATA_DIR', custom);
  expect(selectedTelosDatabaseFiles().canonical).toBe(join(custom, 'telos.db'));
  expect(isPrivateCodexPath(join(custom, 'telos.db'))).toBe(true);
  vi.stubEnv('MITZO_TELOS_DATA_DIR', '');
  expect(isPrivateCodexPath(join(custom, 'telos.db'))).toBe(true);
});
it('initializes a private fresh installation and refuses a silent empty replacement for legacy data', () => {
  const repo = root(),
    data = root();
  vi.stubEnv('TELOS_DB_PATH', '');
  vi.stubEnv('MITZO_TELOS_DATA_DIR', join(data, 'runtime'));
  const legacy = join(repo, 'command_center/data');
  mkdirSync(legacy, { recursive: true });
  TelosRuntimeStore.initialize(join(legacy, 'smart_todo.db'));
  expect(() => ensureTelosRuntimeStorage(repo)).toThrow(/migration/);
  expect(existsSync(join(data, 'runtime/telos.db'))).toBe(false);
  rmSync(join(legacy, 'smart_todo.db'));
  ensureTelosRuntimeStorage(repo);
  expect(statSync(join(data, 'runtime')).mode & 0o777).toBe(0o700);
  expect(statSync(join(data, 'runtime/telos.db')).mode & 0o777).toBe(0o600);
});
it('refuses an empty replacement when the legacy directory cannot be inspected', () => {
  const repo = root();
  const runtime = join(root(), 'runtime');
  vi.stubEnv('TELOS_DB_PATH', '');
  vi.stubEnv('MITZO_TELOS_DATA_DIR', runtime);
  const legacy = join(repo, 'command_center/data');
  mkdirSync(legacy, { recursive: true });
  TelosRuntimeStore.initialize(join(legacy, 'smart_todo.db'));
  chmodSync(legacy, 0o000);
  try {
    expect(() => ensureTelosRuntimeStorage(repo)).toThrow();
    expect(existsSync(join(runtime, 'telos.db'))).toBe(false);
  } finally {
    chmodSync(legacy, 0o700);
  }
});
it.each(
  ['selected', 'legacy'].flatMap((location) =>
    ['-wal', '-shm', '-journal', '-unknown-sidecar', '.migration.json', 'ownership'].map(
      (evidence) => ({ location, evidence }),
    ),
  ),
)(
  'refuses fresh storage beside $location $evidence recovery evidence',
  ({ location, evidence }) => {
    const repo = root();
    const runtime = join(root(), 'runtime');
    const legacy = join(repo, 'command_center/data');
    mkdirSync(runtime, { mode: 0o700 });
    mkdirSync(legacy, { recursive: true });
    vi.stubEnv('TELOS_DB_PATH', '');
    vi.stubEnv('MITZO_TELOS_DATA_DIR', runtime);
    const directory = location === 'selected' ? runtime : legacy;
    const name = location === 'selected' ? 'telos.db' : 'smart_todo.db';
    const retained =
      evidence === 'ownership'
        ? join(directory, '.telos-file-owners')
        : join(directory, name + evidence);
    if (evidence === 'ownership') mkdirSync(retained);
    else writeFileSync(retained, 'retained recovery evidence');
    expect(() => ensureTelosRuntimeStorage(repo)).toThrow();
    expect(existsSync(join(runtime, 'telos.db'))).toBe(false);
    expect(existsSync(retained)).toBe(true);
  },
);
it('upgrades an older transferred item schema before native reads and outcome creation', () => {
  const path = join(root(), 'telos.db');
  TelosRuntimeStore.initialize(path);
  const old = new Database(path);
  try {
    old.exec('DROP INDEX idx_items_idempotency_key');
    for (const name of [
      'intent',
      'rationale',
      'acceptance_criteria',
      'idempotency_key',
      'priority',
      'categories',
      'goal_id',
    ])
      old.exec(`ALTER TABLE items DROP COLUMN ${name}`);
  } finally {
    old.close();
  }
  vi.stubEnv('TELOS_DB_PATH', path);
  ensureTelosRuntimeStorage(root());
  const store = new TelosRuntimeStore(path);
  try {
    expect(
      store.createOutcome(
        {
          summary: 'Recovered work',
          intent: 'Keep history',
          rationale: 'Old installation',
          acceptanceCriteria: ['Native creation works'],
          milestones: ['Verify'],
          profile: 'manual',
          idempotencyKey: 'old-schema-create',
        },
        () => {},
      ),
    ).toMatchObject({ created: true });
    expect(store.list().items).toHaveLength(1);
  } finally {
    store.close();
  }
});

it.each(['empty', 'unrelated'] as const)(
  'refuses an existing %s database without hiding legacy items',
  (kind) => {
    const repo = root();
    const runtime = join(root(), 'runtime');
    mkdirSync(runtime, { mode: 0o700 });
    const path = join(runtime, 'telos.db');
    if (kind === 'empty') writeFileSync(path, '', { mode: 0o600 });
    else {
      const unrelated = new Database(path);
      unrelated.exec('CREATE TABLE unrelated (value TEXT)');
      unrelated.close();
      chmodSync(path, 0o600);
    }
    const legacy = join(repo, 'command_center/data');
    mkdirSync(legacy, { recursive: true });
    const legacyPath = join(legacy, 'smart_todo.db');
    TelosRuntimeStore.initialize(legacyPath);
    const original = new TelosRuntimeStore(legacyPath);
    const saved = original.create({ summary: 'Retained legacy work', profile: 'manual' });
    original.close();
    vi.stubEnv('TELOS_DB_PATH', path);
    vi.stubEnv('MITZO_TELOS_DATA_DIR', runtime);
    expect(() => ensureTelosRuntimeStorage(repo)).toThrow(/canonical schema/);
    const check = new Database(path, { readonly: true });
    try {
      expect(check.pragma('table_info(items)')).toEqual([]);
    } finally {
      check.close();
    }
    const retained = new TelosRuntimeStore(legacyPath);
    try {
      expect(retained.list().items[0]).toMatchObject({
        id: saved.item.id,
        summary: 'Retained legacy work',
      });
    } finally {
      retained.close();
    }
  },
);
