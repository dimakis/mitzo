import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, renameSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import { TaskStore } from '../task-store.js';
import { createFreshTelosDatabaseFiles } from '../../packages/protocol/src/telos-sqlite-owners.js';
const closes: Array<() => void> = [];
afterEach(() => {
  for (const close of closes.splice(0).reverse()) close();
  vi.unstubAllEnvs();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'telos-reference-scope-'));
  closes.push(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    canonical: join(root, 'canonical.db'),
    events: join(root, '.mitzo/events.db'),
    tasks: join(root, '.mitzo/tasks.db'),
  };
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('TELOS_DB_PATH', files.canonical);
  createFreshTelosDatabaseFiles(files);
  const events = new EventStore(files.events);
  closes.push(() => events.close());
  const tasks = new TaskStore(files.tasks);
  closes.push(() => tasks.close());
  expect(typeof events.beginTelosDeletionReferenceScope).toBe('function');
  expect(typeof tasks.beginTelosDeletionReferenceScope).toBe('function');
  return { files, events, tasks };
}
it('holds its own actual reference writers until explicit release', () => {
  const { files, events, tasks } = fixture();
  const eventScope = events.beginTelosDeletionReferenceScope('unreferenced');
  const taskScope = tasks.beginTelosDeletionReferenceScope('unreferenced');
  closes.push(
    () => eventScope.close(),
    () => taskScope.close(),
  );
  for (const path of [files.events, files.tasks]) {
    const other = new Database(path, { timeout: 0 });
    try {
      expect(() => other.exec('BEGIN IMMEDIATE')).toThrow(/locked/);
    } finally {
      other.close();
    }
  }
  eventScope.assertCurrent();
  taskScope.assertCurrent();
  eventScope.close();
  taskScope.close();
  for (const path of [files.events, files.tasks]) {
    const other = new Database(path, { timeout: 0 });
    try {
      other.exec('BEGIN IMMEDIATE; ROLLBACK');
    } finally {
      other.close();
    }
  }
  expect(() => eventScope.assertCurrent()).toThrow();
});
it('refuses borrowed transactions without rolling back the other caller', () => {
  const { tasks } = fixture();
  tasks.getDatabase().exec('BEGIN IMMEDIATE');
  expect(() => tasks.beginTelosDeletionReferenceScope('unreferenced')).toThrow();
  expect(tasks.getDatabase().inTransaction).toBe(true);
  tasks.getDatabase().exec('ROLLBACK');
});
it('complete role custody refuses malformed hidden retained events', () => {
  const { events } = fixture();
  // The existing complete reader has no session visibility join.
  events.upsertSession({ sessionId: 'hidden' });
  events.append('hidden', 'telos_work_role_context', { version: 1, malformed: true });
  expect(() => events.beginTelosDeletionReferenceScope('unreferenced')).toThrow();
});
it('complete task custody refuses a retained binding or malformed unrelated row', () => {
  const { tasks } = fixture();
  const db = tasks.getDatabase();
  db.pragma('foreign_keys=OFF');
  db.prepare('INSERT INTO task_telos_execution_bindings VALUES(?,?,?,?,?,?,?,?)').run(
    'hidden',
    'attempt',
    'unreferenced',
    'lead',
    'worker',
    'snapshot',
    'a'.repeat(64),
    1,
  );
  expect(() => tasks.beginTelosDeletionReferenceScope('unreferenced')).toThrow();
  db.prepare('UPDATE task_telos_execution_bindings SET item_id=?,context_hash=?').run(
    'other',
    'malformed',
  );
  expect(() => tasks.beginTelosDeletionReferenceScope('unreferenced')).toThrow();
});
it('replacement observed by the real constructor owner cannot be restored into authority', () => {
  const { files, tasks } = fixture();
  renameSync(files.tasks, files.tasks + '.saved');
  copyFileSync(files.tasks + '.saved', files.tasks);
  expect(() => tasks.beginTelosDeletionReferenceScope('unreferenced')).toThrow();
  rmSync(files.tasks);
  renameSync(files.tasks + '.saved', files.tasks);
  expect(() => tasks.beginTelosDeletionReferenceScope('unreferenced')).toThrow();
});
