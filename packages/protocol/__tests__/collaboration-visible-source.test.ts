import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openCollaborationVisibleSource } from '../src/collaboration-visible-source.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE events(seq INTEGER PRIMARY KEY,session_id TEXT,type TEXT,payload TEXT,seat_id TEXT,symposium_provenance TEXT);
    CREATE TABLE session_output_references(output_id TEXT,session_id TEXT,message_end_seq INTEGER,sha256 TEXT,provenance TEXT);`);
});
afterEach(() => db.close());
function user(seq: number, id: string, text: string) {
  db.prepare('INSERT INTO events VALUES(?,?,?,?,NULL,NULL)').run(
    seq,
    'one',
    'user_message',
    JSON.stringify({ messageId: id, text }),
  );
}
it('witnesses all visible messages independently of bounded page calls and ignores later appends', () => {
  for (let n = 1; n <= 60; n++) user(n * 2, `m${n}`, `Text ${n}`);
  const source = openCollaborationVisibleSource(db, 'one', { sequence: 120, messageId: 'm60' });
  const witness = source.readPrefixWitness();
  expect(witness.messageCount).toBe(60);
  const first = source.readPage(0, 50);
  expect(first.messages).toHaveLength(50);
  expect(first).toMatchObject({ throughSequence: 100, hasMore: true });
  expect(source.readPage(100, 50)).toMatchObject({ throughSequence: 120, hasMore: false });
  user(122, 'later', 'Not frozen');
  expect(source.readPrefixWitness()).toEqual(witness);
  expect(() => source.assertCurrent()).not.toThrow();
});
it('rechecks selected bytes and full-prefix witness instead of trusting old source identity', () => {
  user(1, 'one', 'Original');
  user(2, 'two', 'Second');
  const selected = openCollaborationVisibleSource(db, 'one', { sequence: 2, messageId: 'two' });
  selected.readSelected(['one']);
  const full = openCollaborationVisibleSource(db, 'one', { sequence: 2, messageId: 'two' });
  full.readPrefixWitness();
  db.prepare('UPDATE events SET payload=? WHERE seq=1').run(
    JSON.stringify({ messageId: 'one', text: 'Changed' }),
  );
  expect(() => selected.assertCurrent()).toThrow('snapshot_changed');
  expect(() => full.assertCurrent()).toThrow('snapshot_changed');
});
it('refuses selected source deletion and private native-seat text does not enter the witness', () => {
  user(1, 'visible', 'Visible');
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?)').run(
    2,
    'one',
    'user_message',
    JSON.stringify({ messageId: 'private', text: 'Native private' }),
    'seat',
    '{}',
  );
  user(3, 'last', 'Last');
  const source = openCollaborationVisibleSource(db, 'one', { sequence: 3, messageId: 'last' });
  expect(source.readPrefixWitness().messageCount).toBe(2);
  expect(() => source.readSelected(['private'])).toThrow('snapshot_changed');
  source.readSelected(['visible']);
  db.prepare('DELETE FROM events WHERE seq=1').run();
  expect(() => source.assertCurrent()).toThrow('snapshot_changed');
});
it('refuses a full prefix overflow without truncating while a narrow selection still works', () => {
  for (let n = 1; n <= 501; n++) user(n, `m${n}`, 'Text');
  const source = openCollaborationVisibleSource(db, 'one', { sequence: 501, messageId: 'm501' });
  expect(() => source.readPrefixWitness()).toThrow('capacity_refused');
  expect(source.readSelected(['m1'])).toHaveLength(1);
});
it('refuses cumulative serialized review bytes before hydrating the remaining prefix', () => {
  user(1, 'first', 'x'.repeat(280000));
  user(2, 'second', 'y'.repeat(280000));
  // A malformed later record would fail as snapshot_changed if the reader hydrated past overflow.
  db.prepare('INSERT INTO events VALUES(?,?,?,?,NULL,NULL)').run(
    3,
    'one',
    'user_message',
    JSON.stringify({ messageId: 'third', text: 42 }),
  );
  const source = openCollaborationVisibleSource(db, 'one', { sequence: 3, messageId: 'third' });
  expect(() => source.readPrefixWitness()).toThrow('capacity_refused');
});
it('preserves an empty frozen prefix after later appends and refuses a missing legacy initial prompt', () => {
  const empty = openCollaborationVisibleSource(db, 'one', { sequence: 0, messageId: null });
  empty.readPrefixWitness();
  user(1, 'later', 'New message');
  expect(() => empty.assertCurrent()).not.toThrow();
  expect(() =>
    openCollaborationVisibleSource(
      db,
      'one',
      { sequence: 1, messageId: 'later' },
      'Legacy initial prompt',
    ),
  ).toThrow('snapshot_changed');
});
