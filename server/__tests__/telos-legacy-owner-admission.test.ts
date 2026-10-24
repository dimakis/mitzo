import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { TaskStore } from '../task-store.js';
import { TelosWorkStore } from '../telos-work-store.js';
import { createFreshTelosDatabaseFiles } from '../../packages/protocol/src/telos-sqlite-owners.js';
const roots: string[] = [];
const stores: TaskStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('does not drop a legacy actual TaskStore writer while rejecting a differently selected malformed family', () => {
  const legacy = mkdtempSync(join(tmpdir(), 'telos-legacy-writer-'));
  roots.push(legacy);
  mkdirSync(join(legacy, '.mitzo'));
  vi.stubEnv('REPO_PATH', legacy);
  vi.stubEnv('TELOS_DB_PATH', join(legacy, 'canonical.db'));
  const tasks = new TaskStore(join(legacy, '.mitzo/tasks.db'));
  stores.push(tasks);
  const db = tasks.getDatabase();
  db.exec('BEGIN IMMEDIATE');
  const otherRoot = mkdtempSync(join(tmpdir(), 'telos-bad-family-selection-'));
  roots.push(otherRoot);
  const other = {
    canonical: join(otherRoot, 'canonical.db'),
    events: join(otherRoot, '.mitzo/events.db'),
    tasks: join(otherRoot, '.mitzo/tasks.db'),
  };
  createFreshTelosDatabaseFiles(other);
  const key = join(otherRoot, '.telos-file-owners/key');
  rmSync(key);
  linkSync(join(legacy, '.mitzo/tasks.db-shm'), key);
  vi.stubEnv('REPO_PATH', otherRoot);
  vi.stubEnv('TELOS_DB_PATH', other.canonical);
  try {
    expect(
      () => new TelosWorkStore(other.canonical, { ordinaryConversation: () => true }),
    ).toThrow();
    const sqlite = createRequire(import.meta.url).resolve('better-sqlite3');
    const probe = spawnSync(
      process.execPath,
      [
        '-e',
        `const Database=require(process.argv[1]);const db=new Database(process.argv[2],{timeout:0});try{db.exec('BEGIN IMMEDIATE;ROLLBACK');}catch(e){process.stdout.write(String(e.code));process.exitCode=23;}finally{db.close();}`,
        sqlite,
        join(legacy, '.mitzo/tasks.db'),
      ],
      { encoding: 'utf8', timeout: 5000, env: process.env },
    );
    expect(probe.status).toBe(23);
    expect(probe.stdout).toBe('SQLITE_BUSY');
  } finally {
    db.exec('ROLLBACK');
    rmSync(key);
  }
});
