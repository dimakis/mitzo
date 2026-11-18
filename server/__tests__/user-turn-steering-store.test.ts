import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { UserTurnSteeringStore } from '../../packages/protocol/src/user-turn-steering-store.js';

const input = { requestId: 'req-1', targetCommandId: 'turn-1', text: 'Fix the order.' };
const previousTable = `CREATE TABLE user_turn_steering (
  request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, operator_id TEXT NOT NULL,
  input TEXT NOT NULL, input_uuid TEXT NOT NULL UNIQUE, content TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('claimed','submitted','accepted','rejected')));`;

function database() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO sessions VALUES(?)').run('chat');
  return db;
}

it('rebuilds a table created before the unconfirmed state, keeping every receipt', () => {
  const db = database();
  db.exec(previousTable);
  db.prepare('INSERT INTO user_turn_steering VALUES(?,?,?,?,?,?,?)').run(
    input.requestId,
    'chat',
    'operator',
    JSON.stringify(input),
    'uuid-1',
    JSON.stringify(input.text),
    'submitted',
  );
  const project = vi.fn();
  const store = new UserTurnSteeringStore(db, project);
  expect(store.read('chat', 'operator', input)?.status).toBe('submitted');
  // The retained submitted receipt can now be retired; the old CHECK would have refused it.
  expect(store.settleOrphaned('chat', 'operator', input)).toBe('unconfirmed');
  expect(project).toHaveBeenCalledWith('chat', input, 'unconfirmed');
  expect(() => new UserTurnSteeringStore(db, project)).not.toThrow();
  expect(store.read('chat', 'operator', input)?.status).toBe('unconfirmed');
});

it('settles only receipts the caller declares ownerless, and only once', () => {
  const db = database();
  const project = vi.fn();
  const store = new UserTurnSteeringStore(db, project);
  expect(store.settleOrphaned('chat', 'operator', input)).toBeUndefined();
  db.prepare('INSERT INTO user_turn_steering VALUES(?,?,?,?,?,?,?)').run(
    input.requestId,
    'chat',
    'operator',
    JSON.stringify(input),
    'uuid-1',
    JSON.stringify(input.text),
    'claimed',
  );
  expect(store.settleOrphaned('chat', 'operator', input)).toBe('rejected');
  expect(store.settleOrphaned('chat', 'operator', input)).toBe('rejected');
  expect(project).toHaveBeenCalledTimes(1);
  expect(() => store.settleOrphaned('chat', 'someone-else', input)).toThrow();
});
