import { afterEach, expect, it, vi } from 'vitest';
import { linkSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { TaskStore } from '../task-store.js';
import {
  createFreshTelosDatabaseFiles,
  openTelosOwnedDatabase,
  type TelosOwnedDatabase,
} from '../../packages/protocol/src/telos-sqlite-owners.js';

const sqlite = createRequire(import.meta.url).resolve('better-sqlite3');
const roots: string[] = [];
const stores: TaskStore[] = [];
const owners: TelosOwnedDatabase[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.close();
  for (const store of stores.splice(0)) store.close();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function filesFixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'telos-sidecar-admission-'));
  roots.push(root);
  const files = {
    canonical: join(root, 'canonical.db'),
    events: join(root, '.mitzo/events.db'),
    tasks: join(root, '.mitzo/tasks.db'),
  };
  createFreshTelosDatabaseFiles(files);
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('TELOS_DB_PATH', files.canonical);
  return files;
}

function fixture() {
  const files = filesFixture();
  const tasks = new TaskStore(files.tasks);
  stores.push(tasks);
  const canonical = openTelosOwnedDatabase('canonical', files.canonical, {}, files);
  owners.push(canonical);
  canonical.database.pragma('journal_mode=WAL');
  canonical.database.exec('CREATE TABLE evidence(value TEXT)');
  return { files, tasks, canonical };
}

function writerProbe(path: string) {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      "const Database=require(process.argv[1]);const db=new Database(process.argv[2],{timeout:0});try{db.exec('BEGIN IMMEDIATE;ROLLBACK');}catch(e){process.stdout.write(String(e.code));process.exitCode=23;}finally{db.close();}",
      sqlite,
      path,
    ],
    { encoding: 'utf8', timeout: 5000, env: process.env },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { status: result.status, stdout: result.stdout };
}

it.each(['hardlink', 'renamed sole link'] as const)(
  'preserves an actual TaskStore writer when a new canonical sidecar is a %s to its SHM file',
  (alias) => {
    const { files, tasks, canonical } = fixture();
    const taskDb = tasks.getDatabase();
    taskDb.exec('BEGIN IMMEDIATE');
    const shm = files.tasks + '-shm';
    const journal = files.canonical + '-journal';
    if (alias === 'hardlink') linkSync(shm, journal);
    else renameSync(shm, journal);
    let failure: unknown;
    let restored = false;
    try {
      try {
        canonical.seal();
      } catch (error) {
        failure = error;
      }
      // Include failed constructor disposal: a rejected auxiliary descriptor
      // must not close an alias of a different still-open role's SHM file.
      canonical.close();
      // Restore the original pathname before probing: a missing SHM could let
      // SQLite create a different file instead of contending on the original.
      if (alias === 'hardlink') rmSync(journal);
      else renameSync(journal, shm);
      restored = true;
      expect(taskDb.inTransaction).toBe(true);
      expect(writerProbe(files.tasks)).toEqual({ status: 23, stdout: 'SQLITE_BUSY' });
      expect(failure).toBeInstanceOf(Error);
    } finally {
      if (!restored) {
        if (alias === 'hardlink') rmSync(journal);
        else renameSync(journal, shm);
      }
      taskDb.exec('ROLLBACK');
    }
    tasks.close();
    expect(writerProbe(files.tasks)).toEqual({ status: 0, stdout: '' });
  },
);

it('refuses first sidecar capture while a different live role has no sealed sidecar identities', () => {
  const files = filesFixture();
  const tasks = openTelosOwnedDatabase('tasks', files.tasks, {}, files);
  owners.push(tasks);
  tasks.database.pragma('journal_mode=WAL');
  tasks.database.exec('CREATE TABLE evidence(value TEXT); BEGIN IMMEDIATE');
  const canonical = openTelosOwnedDatabase('canonical', files.canonical, {}, files);
  owners.push(canonical);
  canonical.database.pragma('journal_mode=WAL');
  canonical.database.exec('CREATE TABLE evidence(value TEXT)');
  const shm = files.tasks + '-shm';
  const journal = files.canonical + '-journal';
  renameSync(shm, journal);
  let restored = false;
  let failure: unknown;
  try {
    try {
      canonical.seal();
    } catch (error) {
      failure = error;
    }
    canonical.close();
    renameSync(journal, shm);
    restored = true;
    expect(tasks.database.inTransaction).toBe(true);
    expect(writerProbe(files.tasks)).toEqual({ status: 23, stdout: 'SQLITE_BUSY' });
    expect(failure).toBeInstanceOf(Error);
  } finally {
    if (!restored) renameSync(journal, shm);
    tasks.database.exec('ROLLBACK');
  }
  tasks.close();
  expect(writerProbe(files.tasks)).toEqual({ status: 0, stdout: '' });
});
