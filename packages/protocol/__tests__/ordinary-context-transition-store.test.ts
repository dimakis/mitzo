import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrdinaryContextTransitionStore } from '../src/ordinary-context-transition-store.js';

const databases: Database.Database[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(path = ':memory:') {
  const db = new Database(path);
  databases.push(db);
  return new OrdinaryContextTransitionStore(db);
}
const intent = {
  sessionId: 'discussion',
  operationId: 'reviewed-handover',
  fingerprint: 'a'.repeat(64),
  expectedEpoch: 0,
};
const settled = () => undefined;

it('retains the exact deny fence across connections and restart without affecting other chats', () => {
  const root = mkdtempSync(join(tmpdir(), 'context-transition-'));
  roots.push(root);
  const path = join(root, 'events.db');
  const first = fixture(path);
  const command = {
    sessionId: 'discussion',
    commandId: 'retained-send',
    requestFingerprint: 'request',
  };
  first.retainCommand(command, 0);
  const originalCommand = first.readCommand(command.commandId);
  expect(first.capture('discussion')).toBe(0);
  const held = first.begin(intent);
  expect(held).toMatchObject({ ...intent, epoch: 1, phase: 'held' });
  const second = fixture(path);
  expect(second.observe('discussion')).toEqual({ epoch: 1, held: true });
  expect(second.observe('unrelated')).toEqual({ epoch: 0, held: false });
  expect(second.begin(intent)).toEqual(held);
  expect(() => second.capture('discussion')).toThrow(/transition/i);
  expect(second.capture('unrelated')).toBe(0);
  databases.splice(0).forEach((db) => db.close());
  const reopened = fixture(path);
  expect(reopened.read(intent.operationId)).toEqual(held);
  expect(reopened.readCommand(command.commandId)).toEqual(originalCommand);
  expect(() => reopened.assertCommand(command)).toThrow(/transition/i);
  expect(() => reopened.retainCommand({ ...command, commandId: 'new-send' }, 1)).toThrow(
    /transition/i,
  );
  expect(reopened.readCommand('new-send')).toBeUndefined();
  expect(() => reopened.assertAdmission('discussion', 0)).toThrow(/transition/i);
  expect(() => reopened.begin({ ...intent, fingerprint: 'b'.repeat(64) })).toThrow(/identity/i);
  expect(() => reopened.begin({ ...intent, operationId: 'competitor' })).toThrow(/transition/i);
});

it('rolls back a command stamp with its owning command transaction', () => {
  const store = fixture();
  const db = databases.at(-1)!;
  db.exec('CREATE TABLE commands (id TEXT PRIMARY KEY)');
  const command = {
    sessionId: 'discussion',
    commandId: 'atomic-send',
    requestFingerprint: 'request',
  };
  expect(() =>
    db
      .transaction(() => {
        db.prepare('INSERT INTO commands VALUES(?)').run(command.commandId);
        store.retainCommand(command, 0);
        throw Error('Command admission failed');
      })
      .immediate(),
  ).toThrow('Command admission failed');
  expect(db.prepare('SELECT * FROM commands').all()).toEqual([]);
  expect(store.readCommand(command.commandId)).toBeUndefined();
});

it('never makes pre-transition preparation current after release, including an aborted adoption', () => {
  const store = fixture();
  const preparedEpoch = store.capture('discussion');
  store.begin(intent);
  expect(() =>
    store.release(intent, 'aborted', () => {
      throw Error('Settlement unavailable');
    }),
  ).toThrow('Settlement unavailable');
  expect(() => store.capture('discussion')).toThrow(/transition/i);
  const receipt = store.release(intent, 'aborted', settled);
  expect(receipt).toMatchObject({ phase: 'released', outcome: 'aborted', epoch: 1 });
  expect(() => store.assertAdmission('discussion', preparedEpoch)).toThrow(/stale/i);
  expect(() => store.assertAdmission('discussion', store.capture('discussion'))).not.toThrow();
  expect(store.release(intent, 'aborted', settled)).toEqual(receipt);
  expect(() => store.release(intent, 'committed', settled)).toThrow(/identity/i);
  const second = store.begin({ ...intent, operationId: 'next-review', expectedEpoch: 1 });
  expect(second.epoch).toBe(2);
  expect(store.read(intent.operationId)).toEqual(receipt);
  expect(() => store.release(intent, 'aborted', settled)).not.toThrow();
  expect(() => store.capture('discussion')).toThrow(/transition/i);
});

it('pins command epochs once and rejects old dispatch without rewriting command evidence', () => {
  const store = fixture();
  const command = { sessionId: 'discussion', commandId: 'send-1', requestFingerprint: 'request-1' };
  store.retainCommand(command, 0);
  const original = store.readCommand(command.commandId);
  store.begin(intent);
  expect(() => store.assertCommand(command)).toThrow(/transition/i);
  store.release(intent, 'committed', settled);
  expect(() => store.assertCommand(command)).toThrow(/stale/i);
  expect(() => store.retainCommand(command, 1)).toThrow(/identity/i);
  expect(store.readCommand(command.commandId)).toEqual(original);
  const next = { ...command, commandId: 'send-2', requestFingerprint: 'request-2' };
  store.retainCommand(next, store.capture('discussion'));
  expect(() => store.assertCommand(next)).not.toThrow();
  expect(() => store.assertCommand({ ...next, sessionId: 'unrelated' })).toThrow(/identity/i);
  expect(() => store.assertCommand({ ...next, requestFingerprint: 'replaced' })).toThrow(
    /identity/i,
  );
  // Missing historical sidecars are epoch zero, never upgraded to today's epoch.
  expect(() => store.assertCommand({ ...command, commandId: 'legacy' })).toThrow(/stale/i);
  expect(() =>
    store.assertCommand({ ...command, commandId: 'legacy-other', sessionId: 'unrelated' }),
  ).not.toThrow();
});

it('rejects malformed identity, unsafe epochs and changed release authority before mutation', () => {
  const store = fixture();
  for (const bad of [
    { ...intent, expectedEpoch: -1 },
    { ...intent, expectedEpoch: 0.5 },
    { ...intent, fingerprint: 'unbounded payload' },
    { ...intent, sessionId: '' },
  ]) {
    expect(() => store.begin(bad)).toThrow();
  }
  store.begin(intent);
  expect(() =>
    store.release({ ...intent, fingerprint: 'b'.repeat(64) }, 'committed', settled),
  ).toThrow(/identity/i);
  expect(() => store.release(intent, 'committed', (() => Promise.resolve()) as never)).toThrow(
    /synchronous/i,
  );
  expect(() => store.capture('discussion')).toThrow(/transition/i);
});
