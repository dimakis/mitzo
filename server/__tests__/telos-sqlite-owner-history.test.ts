import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  copyFileSync,
  rmSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createFreshTelosDatabaseFiles,
  openTelosOwnedDatabase,
  type TelosDatabaseFiles,
  type TelosOwnedDatabase,
} from '../../packages/protocol/src/telos-sqlite-owners.js';

const roots: string[] = [];
const owners: TelosOwnedDatabase[] = [];
function fixture(): TelosDatabaseFiles {
  const root = mkdtempSync(join(tmpdir(), 'telos-birth-'));
  roots.push(root);
  return {
    canonical: join(root, 'canonical.db'),
    events: join(root, 'events.db'),
    tasks: join(root, 'tasks.db'),
  };
}
function open(files: TelosDatabaseFiles, role: keyof TelosDatabaseFiles = 'canonical') {
  const owner = openTelosOwnedDatabase(role, files[role], {}, files);
  owners.push(owner);
  owner.database.pragma('journal_mode=WAL');
  owner.database.exec('CREATE TABLE IF NOT EXISTS evidence(value TEXT)');
  owner.seal();
  return owner;
}
afterEach(() => {
  for (const owner of owners.splice(0)) owner.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('creates the actual three empty files before SQLite and binds their real constructors', () => {
  const files = fixture();
  createFreshTelosDatabaseFiles(files);
  for (const role of ['canonical', 'events', 'tasks'] as const) {
    expect(readFileSync(files[role]).length).toBe(0);
    const owner = open(files, role);
    expect(() => owner.assertCurrent()).not.toThrow();
  }
  const release = owners[0].acquireDeletionExclusion();
  expect(() => owners[1].assertCurrent()).not.toThrow();
  release();
});
it.each(['-wal', '-shm', '-journal'])(
  'refuses orphaned %s before creating or adopting any main',
  (suffix) => {
    const files = fixture();
    writeFileSync(files.tasks + suffix, 'retained sidecar');
    expect(() => createFreshTelosDatabaseFiles(files)).toThrow();
    expect(readFileSync(files.tasks + suffix, 'utf8')).toBe('retained sidecar');
    for (const file of Object.values(files)) expect(existsSync(file)).toBe(false);
  },
);
it('refuses broken sidecar symlinks and existing roots without modifying them', () => {
  const files = fixture();
  symlinkSync(join(roots[0], 'missing'), files.events + '-wal');
  expect(() => createFreshTelosDatabaseFiles(files)).toThrow();
  rmSync(files.events + '-wal');
  writeFileSync(files.tasks, 'legacy');
  expect(() => createFreshTelosDatabaseFiles(files)).toThrow();
  expect(readFileSync(files.tasks, 'utf8')).toBe('legacy');
});
it('ordinary unknown-root opening never mints history or grants deletion', () => {
  const files = fixture();
  const owner = open(files);
  expect(() => owner.assertCurrent()).toThrow();
  expect(() => owner.acquireDeletionExclusion()).toThrow();
  expect(existsSync(join(roots[0], '.telos-file-owners'))).toBe(false);
});
it('loss and same-content replacement latch across restoration and cold constructors', () => {
  const files = fixture();
  createFreshTelosDatabaseFiles(files);
  const owner = open(files);
  const saved = files.canonical + '.saved';
  renameSync(files.canonical, saved);
  copyFileSync(saved, files.canonical);
  expect(() => owner.assertCurrent()).toThrow();
  rmSync(files.canonical);
  renameSync(saved, files.canonical);
  expect(() => owner.assertCurrent()).toThrow();
  owner.close();
  const cold = open(files);
  expect(() => cold.assertCurrent()).toThrow();
});
it('copied birth records and matching schema do not adopt different physical files', () => {
  const files = fixture();
  createFreshTelosDatabaseFiles(files);
  const original = open(files);
  original.close();
  const other = fixture();
  const destination = join(roots[1], '.telos-file-owners');
  mkdirSync(destination, { mode: 0o700 });
  for (const name of ['key', 'birth.json', 'exclusion'])
    copyFileSync(join(roots[0], '.telos-file-owners', name), join(destination, name));
  for (const role of ['canonical', 'events', 'tasks'] as const)
    copyFileSync(files[role], other[role]);
  expect(() => open(other).assertCurrent()).toThrow();
});
it('closed owners never recover authority while a fresh real constructor can', () => {
  const files = fixture();
  createFreshTelosDatabaseFiles(files);
  const owner = open(files);
  owner.close();
  expect(() => owner.assertCurrent()).toThrow();
  expect(() => open(files).assertCurrent()).not.toThrow();
});

it('invalidates the retained birth record even if its owner directory is moved and restored', () => {
  const files = fixture();
  createFreshTelosDatabaseFiles(files);
  const owner = open(files);
  const original = join(roots[0], '.telos-file-owners');
  const saved = original + '.saved';
  renameSync(original, saved);
  expect(() => owner.assertCurrent()).toThrow();
  renameSync(saved, original);
  owner.close();
  expect(() => open(files).assertCurrent()).toThrow();
});
it('observed missing main at a cold constructor remains denied after its restoration', () => {
  const files = fixture();
  createFreshTelosDatabaseFiles(files);
  const saved = files.tasks + '.saved';
  renameSync(files.tasks, saved);
  const lost = open(files);
  expect(() => lost.assertCurrent()).toThrow();
  lost.close();
  renameSync(saved, files.tasks);
  expect(() => open(files).assertCurrent()).toThrow();
});
it('retains the actual WAL family and rejects same-content sidecar replacement', () => {
  const files = fixture();
  createFreshTelosDatabaseFiles(files);
  const owner = openTelosOwnedDatabase('canonical', files.canonical, {}, files);
  owners.push(owner);
  owner.database.pragma('journal_mode=WAL');
  owner.database.exec('CREATE TABLE evidence(value TEXT)');
  owner.seal();
  expect(() => owner.assertCurrent()).not.toThrow();
  const wal = files.canonical + '-wal';
  renameSync(wal, wal + '.saved');
  copyFileSync(wal + '.saved', wal);
  expect(() => owner.assertCurrent()).toThrow();
});

it('latches authenticated exclusion-file replacement before a cold owner can be restored', () => {
  const files = fixture();
  createFreshTelosDatabaseFiles(files);
  const exclusion = join(roots[0], '.telos-file-owners/exclusion');
  renameSync(exclusion, exclusion + '.saved');
  writeFileSync(exclusion, '', { mode: 0o600, flag: 'wx' });
  const replaced = open(files);
  expect(() => replaced.assertCurrent()).toThrow();
  replaced.close();
  rmSync(exclusion);
  renameSync(exclusion + '.saved', exclusion);
  expect(() => open(files).assertCurrent()).toThrow();
});
it('rejects overlapping families before creating any selected main', () => {
  const files = fixture();
  const overlap = { ...files, events: files.canonical + '-wal' };
  expect(() => createFreshTelosDatabaseFiles(overlap)).toThrow();
  for (const file of Object.values(overlap)) expect(existsSync(file)).toBe(false);
});
it('denies unsupported rollback-journal authority without invalidating ordinary writes', () => {
  const files = fixture();
  createFreshTelosDatabaseFiles(files);
  const owner = openTelosOwnedDatabase('canonical', files.canonical, {}, files);
  owners.push(owner);
  owner.database.exec('CREATE TABLE evidence(value TEXT)');
  owner.seal();
  expect(() => owner.assertCurrent()).toThrow();
  owner.database.exec("INSERT INTO evidence VALUES ('ordinary retained write')");
  owner.close();
  const supported = openTelosOwnedDatabase('canonical', files.canonical, {}, files);
  owners.push(supported);
  supported.database.pragma('journal_mode=WAL');
  supported.database.prepare('SELECT * FROM evidence').all();
  supported.seal();
  expect(() => supported.assertCurrent()).not.toThrow();
});
