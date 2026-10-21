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
  openSync,
  closeSync,
  fstatSync,
  readdirSync,
  statSync,
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
  expect(() => open(files).assertCurrent()).toThrow();
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
  expect(() => open(files).assertCurrent()).toThrow();
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
  expect(() => open(files).assertCurrent()).toThrow();
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

it('latches observed missing exclusion before restoration and cold reopening', () => {
  const files = fixture();
  createFreshTelosDatabaseFiles(files);
  const exclusion = join(roots[0], '.telos-file-owners/exclusion');
  renameSync(exclusion, exclusion + '.saved');
  expect(() => open(files).assertCurrent()).toThrow();
  renameSync(exclusion + '.saved', exclusion);
  expect(() => open(files).assertCurrent()).toThrow();
});

it.each(['key', 'birth.json'])(
  'latches observed missing owner metadata %s before restoration',
  (name) => {
    const files = fixture();
    createFreshTelosDatabaseFiles(files);
    const path = join(roots[0], '.telos-file-owners', name);
    renameSync(path, path + '.saved');
    expect(() => open(files).assertCurrent()).toThrow();
    renameSync(path + '.saved', path);
    expect(() => open(files).assertCurrent()).toThrow();
  },
);

it('refuses orphaned SQLite super-journal names before any main creation', () => {
  const files = fixture();
  const journal = files.canonical + '-mjA1B2C39FF';
  writeFileSync(journal, 'retained super journal');
  expect(() => createFreshTelosDatabaseFiles(files)).toThrow();
  for (const file of Object.values(files)) expect(existsSync(file)).toBe(false);
  expect(readFileSync(journal, 'utf8')).toBe('retained super journal');
});

it.each(['invalidate', 'stale exclusion release'] as const)(
  'never writes through a reused descriptor after %s on a disposed owner',
  (action) => {
    const files = fixture();
    createFreshTelosDatabaseFiles(files);
    const owner = open(files);
    const birth = statSync(join(roots[0], '.telos-file-owners/birth.json'), { bigint: true });
    const descriptor = readdirSync('/dev/fd')
      .map(Number)
      .find((fd) => {
        try {
          const info = fstatSync(fd, { bigint: true });
          return info.dev === birth.dev && info.ino === birth.ino;
        } catch {
          return false;
        }
      });
    if (descriptor === undefined) throw new Error('Actual retained birth descriptor not found');
    const release = owner.acquireDeletionExclusion();
    owner.close();
    const innocent = join(roots[0], 'unrelated-retained-file');
    writeFileSync(innocent, 'UNRELATED DATA MUST REMAIN', { flag: 'wx' });
    const descriptors: number[] = [];
    try {
      let reused = false;
      for (let i = 0; i < 256; i++) {
        const fd = openSync(innocent, 'r+');
        descriptors.push(fd);
        if (fd === descriptor) {
          reused = true;
          break;
        }
        if (fd > descriptor) break;
      }
      expect(reused).toBe(true);
      try {
        if (action === 'invalidate') owner.invalidate();
        else release();
      } catch {
        /* inspect actual corruption regardless of prior cleanup error */
      }
      expect(readFileSync(innocent, 'utf8')).toBe('UNRELATED DATA MUST REMAIN');
    } finally {
      for (const fd of descriptors) closeSync(fd);
    }
  },
);

it('treats a cold entirely absent owner directory as unknown without claiming sticky prior-history revocation', () => {
  const files = fixture();
  createFreshTelosDatabaseFiles(files);
  const prior = open(files);
  prior.close();
  const directory = join(roots[0], '.telos-file-owners');
  renameSync(directory, directory + '.saved');
  const unknown = open(files);
  expect(() => unknown.assertCurrent()).toThrow();
  unknown.close();
  renameSync(directory + '.saved', directory);
  const current = open(files);
  expect(() => current.assertCurrent()).not.toThrow();
  expect(() => prior.assertCurrent()).toThrow();
});
