import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionRemovalStore } from '../src/session-removal-store.js';
import { EventStore } from '../src/event-store.js';

const dispose: Array<() => void> = [];
afterEach(() =>
  dispose
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function database() {
  const root = mkdtempSync(join(tmpdir(), 'session-removal-'));
  dispose.push(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'events.db');
}
it('persists a removal fence across connections and every failure/restart', () => {
  const path = database();
  const db = new Database(path);
  const first = new SessionRemovalStore(db);
  first.begin('chat', 'operation', 'resource-fingerprint');
  expect(() => first.assertAdmissible('chat')).toThrow(/remov/i);
  first.transition('chat', 'operation', 'closing', 'failed', 'shutdown unconfirmed');
  db.close();
  const reopened = new Database(path);
  dispose.push(() => reopened.close());
  const second = new SessionRemovalStore(reopened);
  expect(second.read('chat')).toMatchObject({ phase: 'failed', error: 'shutdown unconfirmed' });
  expect(() => second.assertAdmissible('chat')).toThrow(/remov/i);
  expect(() => second.begin('chat', 'another-operation', 'changed-resources')).toThrow();
  expect(second.begin('chat', 'operation', 'resource-fingerprint').phase).toBe('failed');
  second.transition('chat', 'operation', 'failed', 'closing');
  expect(second.read('chat')?.preparationCompleted).toBe(false);
  expect(() => second.transition('chat', 'operation', 'closing', 'releasing')).toThrow();
  second.markPrepared('chat', 'operation');
  second.transition('chat', 'operation', 'closing', 'releasing');
  second.transition('chat', 'operation', 'releasing', 'completed');
  expect(() => second.assertAdmissible('chat')).toThrow(/remov/i);
  expect(() => second.assertAdmissible('other-chat')).not.toThrow();
});
it('requires the original operation and phase for progress', () => {
  const db = new Database(database());
  dispose.push(() => db.close());
  const store = new SessionRemovalStore(db);
  store.begin('chat', 'original', 'resources');
  expect(() => store.transition('chat', 'substitute', 'closing', 'completed')).toThrow();
  expect(() => store.transition('chat', 'original', 'releasing', 'completed')).toThrow();
  expect(store.read('chat')?.phase).toBe('closing');
});
it('blocks new durable sends in the actual EventStore while retaining historical receipts', () => {
  const events = new EventStore(database());
  dispose.push(() => events.close());
  events.upsertSession({ sessionId: 'chat', cwd: '/task', mode: 'agent' });
  events.insertSendCommand('earlier', 'chat', { text: 'already retained' });
  events.removals.begin('chat', 'removal', 'resources');
  expect(() => events.insertSendCommand('later', 'chat', { text: 'must not run' })).toThrow(
    /remov/i,
  );
  expect(events.getSendCommand('later')).toBeUndefined();
  expect(() => events.beginExecution('chat')).toThrow(/remov/i);
  expect(events.getSendCommand('earlier')?.sessionId).toBe('chat');
  expect(events.getSession('chat')?.isHidden).toBeFalsy();
});
