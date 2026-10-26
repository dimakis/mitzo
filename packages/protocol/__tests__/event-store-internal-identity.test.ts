import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/event-store.js';

const identitySql = `SELECT sdk_session_id AS sdkSessionId, parent_session_id AS parentSessionId,
      operation_id AS operationId, purpose, cwd FROM internal_sdk_executions WHERE sdk_session_id = ?`;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
  vi.restoreAllMocks();
});

it('compiles the identity SELECT once per owner while public session hooks execute fresh reads', () => {
  const prepare = vi.spyOn(Database.prototype, 'prepare');
  const store = new EventStore(':memory:');
  cleanups.push(() => store.close());
  store.upsertSession({ sessionId: 'conversation', conversationSource: 'mitzo' });
  const identity = vi.spyOn(store, 'getInternalSdkExecution');
  const ownerDb = (store as unknown as { db: Database.Database }).db;
  const statementPrototype = Object.getPrototypeOf(ownerDb.prepare('SELECT 1'));
  const gets = vi.spyOn(statementPrototype as Database.Statement, 'get');
  for (let index = 0; index < 3; index++) {
    expect(store.getSession('conversation')?.sessionId).toBe('conversation');
    expect(store.getSessionRuntimeBinding('conversation')).toBeNull();
  }
  expect(identity.mock.calls).toEqual(Array.from({ length: 6 }, () => ['conversation']));
  expect(
    gets.mock.contexts.filter(
      (statement) => (statement as Database.Statement).source === identitySql,
    ),
  ).toHaveLength(6);
  expect(prepare.mock.calls.filter(([sql]) => sql === identitySql)).toHaveLength(1);
});

it('observes external identity changes, rollback and independent owners without sharing returned rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-internal-identity-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'events.db');
  const store = new EventStore(path),
    second = new EventStore(path),
    external = new Database(path);
  cleanups.push(
    () => external.close(),
    () => second.close(),
    () => store.close(),
  );
  store.upsertSession({ sessionId: 'conversation', conversationSource: 'mitzo' });
  expect(store.getInternalSdkExecution('conversation')).toBeNull();
  expect(second.getInternalSdkExecution('conversation')).toBeNull();
  const insert = external.prepare(
    'INSERT INTO internal_sdk_executions(sdk_session_id,parent_session_id,operation_id,purpose,cwd) VALUES(?,?,?,?,?)',
  );
  insert.run('conversation', 'parent', 'operation', 'web_search', '/offline');
  const first = store.getInternalSdkExecution('conversation')!;
  first.cwd = 'caller mutation';
  expect(second.getInternalSdkExecution('conversation')?.cwd).toBe('/offline');
  expect(store.getInternalSdkExecution('conversation')?.cwd).toBe('/offline');
  expect(store.getSession('conversation')).toBeNull();
  expect(() => store.getSessionRuntimeBinding('conversation')).toThrow('Internal SDK executions');
  external
    .prepare('UPDATE internal_sdk_executions SET cwd=? WHERE sdk_session_id=?')
    .run('/changed', 'conversation');
  expect(store.getInternalSdkExecution('conversation')?.cwd).toBe('/changed');
  expect(second.getInternalSdkExecution('conversation')?.cwd).toBe('/changed');
  external
    .prepare('DELETE FROM internal_sdk_executions WHERE sdk_session_id=?')
    .run('conversation');
  const ownerDb = (store as unknown as { db: Database.Database }).db;
  expect(() =>
    ownerDb.transaction(() => {
      ownerDb
        .prepare(
          'INSERT INTO internal_sdk_executions(sdk_session_id,parent_session_id,operation_id,purpose,cwd) VALUES(?,?,?,?,?)',
        )
        .run('conversation', 'parent', 'operation', 'web_search', '/transaction');
      expect(store.getInternalSdkExecution('conversation')?.cwd).toBe('/transaction');
      throw Error('rollback');
    })(),
  ).toThrow('rollback');
  expect(store.getInternalSdkExecution('conversation')).toBeNull();
  expect(second.getInternalSdkExecution('conversation')).toBeNull();
  expect(store.getSession('conversation')?.sessionId).toBe('conversation');
  expect(store.getSessionRuntimeBinding('conversation')).toBeNull();
  store.close();
  expect(() => store.getInternalSdkExecution('conversation')).toThrow();
  expect(second.getSession('conversation')?.sessionId).toBe('conversation');
  const reopened = new EventStore(path);
  cleanups.push(() => reopened.close());
  expect(reopened.getSession('conversation')?.sessionId).toBe('conversation');
});

it('retains the original fresh identity lookup during a pre-statements constructor callback', () => {
  type EarlyOwner = { migratePromptTracking(db: Database.Database): void };
  const target = EventStore.prototype as unknown as EarlyOwner;
  const original = target.migratePromptTracking;
  const early = vi.spyOn(target, 'migratePromptTracking').mockImplementation(function (
    this: EventStore,
    db,
  ) {
    db.prepare(
      'INSERT INTO internal_sdk_executions(sdk_session_id,parent_session_id,operation_id,purpose,cwd) VALUES(?,?,?,?,?)',
    ).run('early', 'parent', 'operation', 'web_search', '/before-statements');
    expect(this.getInternalSdkExecution('early')?.cwd).toBe('/before-statements');
    db.prepare('DELETE FROM internal_sdk_executions WHERE sdk_session_id=?').run('early');
    return original.call(this, db);
  });
  const store = new EventStore(':memory:');
  cleanups.push(() => store.close());
  expect(early).toHaveBeenCalledOnce();
  expect(store.getInternalSdkExecution('early')).toBeNull();
});
