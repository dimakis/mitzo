import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openCollaborationVisibleSource } from '../src/collaboration-visible-source.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE events(seq INTEGER PRIMARY KEY,session_id TEXT,type TEXT,payload TEXT,seat_id TEXT,symposium_provenance TEXT);
    CREATE TABLE session_output_references(output_id TEXT,session_id TEXT,message_end_seq INTEGER,sha256 TEXT,provenance TEXT);`);
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});
function event(seq: number, type: string, payload: Record<string, unknown>) {
  db.prepare('INSERT INTO events VALUES(?,?,?,?,NULL,NULL)').run(
    seq,
    'one',
    type,
    JSON.stringify(payload),
  );
}
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
  expect(source.readSelected(['m1'])[0].blocks[0].blockId).toBe('user-m1');
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

it.each(['witness', 'page', 'assistant', 'user', 'empty'])(
  'refuses an interleaved assistant prefix before any %s selection can qualify it',
  (mode) => {
    user(1, 'u1', 'First');
    event(2, 'message_start', { messageId: 'a1' });
    event(3, 'block_start', { messageId: 'a1', blockId: 'b1', blockType: 'text' });
    event(4, 'block_delta', { messageId: 'a1', blockId: 'b1', delta: 'Answer' });
    user(5, 'u2', 'Second');
    event(6, 'block_end', { messageId: 'a1', blockId: 'b1' });
    event(7, 'message_end', { messageId: 'a1' });
    expect(() => {
      const source = openCollaborationVisibleSource(db, 'one', { sequence: 7, messageId: 'a1' });
      if (mode === 'witness') source.readPrefixWitness();
      else if (mode === 'page') source.readPage(0, 50);
      else source.readSelected(mode === 'empty' ? [] : [mode === 'user' ? 'u1' : 'a1']);
    }).toThrow('snapshot_changed');
  },
);
it('refuses overlapping completed assistants and newly introduced interleaving at every read fence', () => {
  event(1, 'message_start', { messageId: 'a1' });
  event(2, 'block_start', { messageId: 'a1', blockId: 'b1', blockType: 'text' });
  event(4, 'block_delta', { messageId: 'a1', blockId: 'b1', delta: 'First' });
  event(6, 'block_end', { messageId: 'a1', blockId: 'b1' });
  event(8, 'message_end', { messageId: 'a1' });
  const source = openCollaborationVisibleSource(db, 'one', { sequence: 8, messageId: 'a1' });
  source.readSelected(['a1']);
  user(5, 'u1', 'Interleaved after opening');
  for (const read of [
    () => source.readPrefixWitness(),
    () => source.readPage(0, 50),
    () => source.readSelected([]),
    () => source.assertCurrent(),
  ])
    expect(read).toThrow('snapshot_changed');
  db.prepare('DELETE FROM events WHERE seq=5').run();
  event(3, 'message_start', { messageId: 'a2' });
  event(5, 'block_start', { messageId: 'a2', blockId: 'b2', blockType: 'text' });
  event(7, 'block_end', { messageId: 'a2', blockId: 'b2' });
  event(9, 'message_end', { messageId: 'a2' });
  expect(() => openCollaborationVisibleSource(db, 'one', { sequence: 9, messageId: 'a2' })).toThrow(
    'snapshot_changed',
  );
});
it.each(['page', 'selected'])(
  'bounds cumulative escaped %s bytes before reading a malformed continuation',
  (mode) => {
    user(1, 'first', '\u0000'.repeat(50000));
    user(2, 'second', '\u0000'.repeat(50000));
    event(3, 'user_message', { messageId: 'third', text: 42 });
    const source = openCollaborationVisibleSource(db, 'one', { sequence: 3, messageId: 'third' });
    expect(() =>
      mode === 'page' ? source.readPage(0, 50) : source.readSelected(['first', 'second', 'third']),
    ).toThrow('capacity_refused');
    expect(source.readSelected(['first'])).toHaveLength(1);
    expect(() => source.assertCurrent()).not.toThrow();
  },
);
it('stops SQLite delta hydration at the byte limit rather than collecting the entire assistant', () => {
  event(1, 'message_start', { messageId: 'a1' });
  event(2, 'block_start', { messageId: 'a1', blockId: 'b1', blockType: 'text' });
  for (let n = 3; n <= 7; n++)
    event(n, 'block_delta', { messageId: 'a1', blockId: 'b1', delta: 'x'.repeat(280000) });
  event(8, 'block_end', { messageId: 'a1', blockId: 'b1' });
  event(9, 'message_end', { messageId: 'a1' });
  let hydrated = 0;
  db.function('observe_delta', (value: string) => {
    hydrated++;
    return value;
  });
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) =>
    prepare(
      sql.replace(
        "THEN json_extract(payload,'$.delta') END AS delta",
        "THEN observe_delta(json_extract(payload,'$.delta')) END AS delta",
      ),
    ),
  );
  const source = openCollaborationVisibleSource(db, 'one', { sequence: 9, messageId: 'a1' });
  expect(() => source.readSelected(['a1'])).toThrow('capacity_refused');
  expect(hydrated).toBe(2);
});

it('charges escaped assistant content before consuming malformed later rows', () => {
  event(1, 'message_start', { messageId: 'a1' });
  event(2, 'block_start', { messageId: 'a1', blockId: 'b1', blockType: 'text' });
  for (let n = 3; n <= 4; n++)
    event(n, 'block_delta', {
      messageId: 'a1',
      blockId: 'b1',
      delta: '\u0000'.repeat(50000),
    });
  event(5, 'block_end', { messageId: 'a1', blockId: 42 });
  event(6, 'message_end', { messageId: 'a1' });
  const source = openCollaborationVisibleSource(db, 'one', { sequence: 6, messageId: 'a1' });
  expect(() => source.readSelected(['a1'])).toThrow('capacity_refused');
});

it('refuses oversized SQL identifier projections at the boundary, anchor, block and artifact paths', () => {
  const oversized = 'x'.repeat(10000);
  user(1, oversized, 'Text');
  expect(() =>
    openCollaborationVisibleSource(db, 'one', { sequence: 1, messageId: oversized }),
  ).toThrow('snapshot_changed');
  user(2, 'last', 'Last');
  const source = openCollaborationVisibleSource(db, 'one', { sequence: 2, messageId: 'last' });
  expect(() => source.readPage(0, 50)).toThrow('snapshot_changed');
  expect(() => source.readSelected([oversized])).toThrow('snapshot_changed');
  expect(() => source.readPrefixWitness()).toThrow('snapshot_changed');
  db.prepare('DELETE FROM events WHERE seq=1').run();
  event(3, 'message_start', { messageId: 'a1' });
  event(4, 'block_start', { messageId: 'a1', blockId: oversized, blockType: 'text' });
  event(5, 'block_end', { messageId: 'a1', blockId: oversized });
  event(6, 'message_end', { messageId: 'a1' });
  const assistant = openCollaborationVisibleSource(db, 'one', { sequence: 6, messageId: 'a1' });
  expect(() => assistant.readSelected(['a1'])).toThrow('snapshot_changed');
  db.prepare('INSERT INTO session_output_references VALUES(?,?,?,?,NULL)').run(
    oversized,
    'one',
    2,
    '0'.repeat(64),
  );
  expect(() => source.readPrefixWitness()).toThrow('snapshot_changed');
});

it('keeps repeated selected reads independent and bounds the final aggregate recheck', () => {
  user(1, 'first', 'x'.repeat(280000));
  user(2, 'second', 'y'.repeat(280000));
  const source = openCollaborationVisibleSource(db, 'one', { sequence: 2, messageId: 'second' });
  source.readSelected(['first']);
  source.readSelected(['first']);
  expect(() => source.assertCurrent()).not.toThrow();
  source.readSelected(['second']);
  expect(() => source.assertCurrent()).toThrow('capacity_refused');
});

it('accepts the exact serialized byte boundary consistently at selection and the final fence', () => {
  user(1, 'first', 'x'.repeat(250000));
  user(2, 'second', '');
  const boundary = { sequence: 2, messageId: 'second' };
  const initial = openCollaborationVisibleSource(db, 'one', boundary).readSelected([
    'first',
    'second',
  ]);
  const padding = 512 * 1024 - Buffer.byteLength(JSON.stringify(initial));
  const update = db.prepare('UPDATE events SET payload=? WHERE seq=2');
  update.run(JSON.stringify({ messageId: 'second', text: 'y'.repeat(padding) }));
  const exact = openCollaborationVisibleSource(db, 'one', boundary);
  expect(Buffer.byteLength(JSON.stringify(exact.readSelected(['first', 'second'])))).toBe(
    512 * 1024,
  );
  expect(exact.readPage(0, 50).messages).toHaveLength(2);
  expect(exact.readPrefixWitness().messageCount).toBe(2);
  expect(() => exact.assertCurrent()).not.toThrow();
  update.run(JSON.stringify({ messageId: 'second', text: 'y'.repeat(padding + 1) }));
  expect(() =>
    openCollaborationVisibleSource(db, 'one', boundary).readSelected(['first', 'second']),
  ).toThrow('capacity_refused');
});
