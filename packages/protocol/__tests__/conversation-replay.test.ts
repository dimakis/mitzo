import type Database from 'better-sqlite3';
import Sqlite from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/event-store.js';
import {
  ConversationReplayStore,
  type ConversationReplayOwner,
} from '../src/conversation-replay-store.js';
import { ConversationReplayBeforeExtraction } from './fixtures/conversation-replay-before-extraction.js';
import type { SessionState } from '../src/types.js';

const close: Array<() => void> = [];
afterEach(() => {
  close
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
});
const methods = [
  'getEventsAfter',
  'getSessionPredecessorSeq',
  'getSessionEvents',
  'getSessionEventsThroughCursor',
  'getRecentConversationText',
  'getConversationSourceSnapshots',
  'getSessionClientState',
  'captureReconnectState',
] as const;
function fixture(before = false, file = false) {
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-replay-'));
  close.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = file ? join(directory, 'events.db') : ':memory:';
  let store: EventStore;
  let db: Database.Database;
  function install() {
    store = new EventStore(path);
    const internal = store as unknown as {
      db: Database.Database;
      conversationReplay: { owner: ConversationReplayOwner<unknown> };
    };
    db = internal.db;
    db.function('unixepoch', { varargs: true }, () => 1_800_000_000);
    if (before) {
      const oracle = new ConversationReplayBeforeExtraction(internal.conversationReplay.owner);
      for (const name of methods)
        Object.defineProperty(store, name, {
          value: oracle[name].bind(oracle),
          configurable: true,
        });
    }
  }
  install();
  close.push(() => store.close());
  store!.upsertSession({ sessionId: 'one' });
  store!.upsertSession({ sessionId: 'other' });
  return {
    get store() {
      return store;
    },
    get db() {
      return db;
    },
    path,
    reopen() {
      store.close();
      install();
    },
    rows() {
      return ['sessions', 'events', 'provider_attempts', 'sqlite_sequence'].map((table) =>
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      );
    },
  };
}
function outcome(fn: () => unknown) {
  try {
    return { value: fn() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: { name: error.name, message: error.message } };
  }
}
function parity(run: (f: ReturnType<typeof fixture>) => unknown, file = false) {
  const a = fixture(true, file),
    b = fixture(false, file);
  const expected = run(a);
  const actual = run(b);
  expect(actual).toEqual(expected);
  expect(b.rows()).toEqual(a.rows());
  return actual;
}
function history(f: ReturnType<typeof fixture>) {
  const ids = [f.store.append('one', 'user_message', { messageId: 'u', text: 'hello' })];
  f.store.append('other', 'user_message', { messageId: 'foreign', text: 'other session' });
  ids.push(
    f.store.append('one', 'block_delta', { messageId: 'a', blockType: 'text', delta: 'answer' }),
  );
  f.store.append('one', 'block_delta', {
    messageId: 'a',
    blockType: 'thinking',
    delta: 'private reasoning',
  });
  ids.push(f.store.append('one', 'message_end', { messageId: 'a' }));
  return ids;
}

it('does no connection access, migration or lifecycle work in the borrowed constructor', () => {
  const database = vi.fn(() => {
    throw Error('must not open');
  });
  new ConversationReplayStore({ database } as unknown as ConversationReplayOwner<unknown>);
  expect(database).not.toHaveBeenCalled();
  const source = readFileSync(
    new URL('../src/conversation-replay-store.ts', import.meta.url),
    'utf8',
  );
  expect(source).not.toMatch(/new Database|CREATE TABLE|ALTER TABLE|journal_mode/);
  expect(source).not.toMatch(/from ['"]\.\/event-store\.js['"]/);
});
it.each([undefined, null, 0, 1, 2, -1])('preserves ordered suffix reads and limit %s', (limit) => {
  parity((f) => {
    const ids = history(f);
    return [
      f.store.getEventsAfter('one', ids[0], limit as number),
      f.store.getSessionEvents('one'),
      f.store.getSessionPredecessorSeq('one', ids[1]),
    ];
  });
});
it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'preserves invalid cursor errors for %s',
  (cursor) => {
    parity((f) => [
      outcome(() => f.store.getSessionEventsThroughCursor('one', cursor)),
      outcome(() => f.store.captureReconnectState('one', cursor)),
      outcome(() => f.store.getSessionPredecessorSeq('one', cursor)),
    ]);
  },
);
it.each([0, 1, 2, 4, 999])('preserves immutable prefix and reconnect cursor %s', (cursor) => {
  parity((f) => {
    history(f);
    return [
      f.store.getSessionEventsThroughCursor('one', cursor),
      f.store.captureReconnectState('one', cursor),
      f.store.captureReconnectState('one', cursor, false),
    ];
  });
});
it.each([
  'CREATED',
  'STARTING',
  'ACTIVE',
  'DETACHED',
  'SUSPENDED',
  'CLOSING',
  'ENDED',
] as SessionState[])('preserves lifecycle/turn projection for %s', (state) => {
  parity((f) => {
    f.db.prepare('UPDATE sessions SET state=? WHERE session_id=?').run(state, 'one');
    const results = [f.store.getSessionClientState('one')];
    f.store.append('one', 'user_message', { messageId: 'u', text: 'hi' });
    results.push(f.store.getSessionClientState('one'));
    f.store.append('one', 'session_end', {});
    results.push(f.store.getSessionClientState('one'));
    return results;
  });
});
it('preserves text-only chronological projection and drops reasoning/tool/image fields', () => {
  const result = parity((f) => {
    history(f);
    f.store.append('one', 'tool_result', { messageId: 'a', secret: 'tool secret' });
    return f.store.getRecentConversationText('one');
  });
  expect(JSON.stringify(result)).not.toContain('private reasoning');
  expect(JSON.stringify(result)).not.toContain('tool secret');
});
it('preserves distinct ordinary source snapshots and excludes seat-attached sources', () => {
  parity((f) => {
    const source = [{ kind: 'briefing', content: 'saved source' }];
    f.store.append('one', 'user_message', { messageId: 's1', sourceSnapshots: source });
    f.store.append('one', 'user_message', { messageId: 's2', sourceSnapshots: source });
    const seq = f.store.append('one', 'user_message', {
      messageId: 'seat',
      sourceSnapshots: ['private seat source'],
    });
    f.db.prepare('UPDATE events SET seat_id=? WHERE seq=?').run('seat', seq);
    const values = f.store.getConversationSourceSnapshots('one');
    expect(values).toEqual([source]);
    return values;
  });
});
it('preserves missing-session and closed-owner behavior', () => {
  parity((f) => [
    f.store.captureReconnectState('missing', 0),
    f.store.captureReconnectState('missing', 2),
    f.store.getSessionClientState('missing'),
  ]);
  const a = fixture(true),
    b = fixture();
  a.store.close();
  b.store.close();
  for (const name of ['getSessionEvents', 'captureReconnectState'] as const)
    expect(outcome(() => b.store[name]('one', 0))).toEqual(outcome(() => a.store[name]('one', 0)));
});
it('keeps dynamic public hooks visible in reconnect reads', () => {
  const f = fixture();
  history(f);
  const state = vi.spyOn(f.store, 'getSessionClientState').mockReturnValue('requires_action');
  const attempts = vi.spyOn(f.store, 'getProviderAttempts').mockReturnValue([]);
  const execution = f.store.beginExecution('one', 'execution');
  const value = f.store.captureReconnectState('one', 0);
  expect(value.clientState).toBe('requires_action');
  expect(state).toHaveBeenCalledWith('one');
  expect(attempts).toHaveBeenCalledWith(execution.token);
});
it('keeps metadata-only reconnect from decoding event payloads', () => {
  const f = fixture();
  const seq = f.store.append('one', 'custom', {});
  const internal = f.store as unknown as {
    conversationReplay: { owner: ConversationReplayOwner<unknown> };
  };
  const decode = vi
    .spyOn(internal.conversationReplay.owner, 'eventFromRow')
    .mockImplementation(() => {
      throw Error('unexpected event decoding');
    });
  expect(f.store.captureReconnectState('one', 0, false)).toMatchObject({ cursor: seq, events: [] });
  expect(decode).not.toHaveBeenCalled();
  expect(() => f.store.captureReconnectState('one', 0)).toThrow('unexpected event decoding');
});
it('holds one WAL snapshot across peer commits to session, events and provider attempts', () => {
  const f = fixture(false, true);
  f.db.prepare('UPDATE sessions SET state=? WHERE session_id=?').run('ACTIVE', 'one');
  const execution = f.store.beginExecution('one', 'execution');
  f.store.beginProviderAttempt(execution.token, 'attempt');
  const originalCursor = f.store.getSessionEvents('one').at(-1)!.seq;
  const peer = new Sqlite(f.path);
  close.push(() => peer.close());
  const original = f.store.getSession.bind(f.store);
  let changed = false;
  vi.spyOn(f.store, 'getSession').mockImplementation((id) => {
    const session = original(id);
    if (!changed) {
      changed = true;
      peer.transaction(() => {
        peer.prepare("UPDATE sessions SET state='ENDED' WHERE session_id=?").run(id);
        peer
          .prepare(
            "UPDATE provider_attempts SET phase='TERMINAL', terminal_reason='failed' WHERE session_id=?",
          )
          .run(id);
        peer
          .prepare('INSERT INTO events(session_id,type,payload) VALUES(?,?,?)')
          .run(id, 'session_end', '{}');
      })();
    }
    return session;
  });
  const snapshot = f.store.captureReconnectState('one', 0);
  expect(snapshot.cursor).toBe(originalCursor);
  expect(snapshot.session!.state).toBe('ACTIVE');
  expect(snapshot.providerAttempts[0].phase).toBe('RUNNING');
  expect(snapshot.clientState).toBe('running');
  expect(snapshot.events.every((event) => event.seq <= originalCursor)).toBe(true);
  expect(f.store.getSession('one')!.state).toBe('ENDED');
});
it('preserves durable replay through close/reopen with gapped global sequences', () => {
  parity((f) => {
    const ids = history(f);
    f.reopen();
    return [
      f.store.getSessionEventsThroughCursor('one', ids[1]),
      f.store.captureReconnectState('one', ids[0]),
    ];
  }, true);
});

it.each([null, 17, true])('preserves invalid saved source errors for %s', (sourceSnapshots) => {
  const result = parity((f) => {
    f.store.append('one', 'user_message', { sourceSnapshots });
    return outcome(() => f.store.getConversationSourceSnapshots('one'));
  });
  expect(result).toMatchObject({ error: { message: 'Invalid saved source snapshot' } });
});
it('preserves the 64 distinct source projection bound', () => {
  const result = parity((f) => {
    for (let i = 0; i < 65; i++)
      f.store.append('one', 'user_message', { sourceSnapshots: [{ content: `source ${i}` }] });
    return outcome(() => f.store.getConversationSourceSnapshots('one'));
  });
  expect(result).toMatchObject({
    error: { message: 'Saved source snapshot projection exceeds bounds' },
  });
});
it('preserves UTF-8 per-record source bounds', () => {
  const result = parity((f) => {
    f.store.append('one', 'user_message', {
      sourceSnapshots: [{ content: '€'.repeat(4 * 1024 * 1024 + 1024) }],
    });
    return outcome(() => f.store.getConversationSourceSnapshots('one'));
  });
  expect(result).toMatchObject({ error: { message: 'Invalid saved source snapshot' } });
});
it('returns only the current generation provider history while retaining older receipts', () => {
  parity((f) => {
    const first = f.store.beginExecution('one', 'first');
    const prior = f.store.beginProviderAttempt(first.token, 'prior');
    f.store.transitionProviderAttempt(prior.token, 'TERMINAL', 'completed');
    f.store.transitionExecution(first.token, 'TERMINAL', 'completed');
    const second = f.store.beginExecution('one', 'second');
    f.store.beginProviderAttempt(second.token, 'current');
    const snapshot = f.store.captureReconnectState('one', 0);
    expect(snapshot.providerAttempts.map((attempt) => attempt.token.providerAttemptId)).toEqual([
      'current',
    ]);
    expect(f.store.getProviderAttempts(first.token)[0].token.providerAttemptId).toBe('prior');
    return snapshot;
  });
});
it('preserves explicit durable client state and excludes seat turn signals', () => {
  parity((f) => {
    f.db.prepare("UPDATE sessions SET state='ACTIVE' WHERE session_id='one'").run();
    f.store.append('one', 'execution_state_changed', { clientState: 'requires_action' });
    const seq = f.store.append('one', 'session_end', {});
    f.db.prepare('UPDATE events SET seat_id=? WHERE seq=?').run('seat', seq);
    expect(f.store.getSessionClientState('one')).toBe('requires_action');
    return f.store.captureReconnectState('one', 0);
  });
});
it.each(['decode', 'client-state'] as const)(
  'releases the read transaction after a %s error',
  (fault) => {
    const f = fixture(false, true);
    history(f);
    const internal = f.store as unknown as {
      conversationReplay: { owner: ConversationReplayOwner<unknown> };
    };
    const spy =
      fault === 'decode'
        ? vi.spyOn(internal.conversationReplay.owner, 'eventFromRow')
        : vi.spyOn(f.store, 'getSessionClientState');
    spy.mockImplementation(() => {
      throw Error('read fault');
    });
    expect(() => f.store.captureReconnectState('one', 0)).toThrow('read fault');
    expect(f.db.inTransaction).toBe(false);
    spy.mockRestore();
    const peer = new Sqlite(f.path);
    close.push(() => peer.close());
    peer.prepare("UPDATE sessions SET state='ENDED' WHERE session_id='one'").run();
    expect(f.store.captureReconnectState('one', 0).session!.state).toBe('ENDED');
  },
);
it('reads owner uncommitted writes without committing or rolling back the outer transaction', () => {
  parity((f) => {
    const before = f.store.getSessionEvents('one');
    let snapshot;
    expect(() =>
      f.db.transaction(() => {
        f.store.append('one', 'user_message', { messageId: 'pending', text: 'uncommitted' });
        snapshot = f.store.captureReconnectState('one', 0);
        expect(snapshot.events.at(-1)!.payload).toMatchObject({ text: 'uncommitted' });
        expect(f.db.inTransaction).toBe(true);
        throw Error('outer rollback');
      })(),
    ).toThrow('outer rollback');
    expect(f.store.getSessionEvents('one')).toEqual(before);
    expect(f.db.inTransaction).toBe(false);
    return snapshot;
  });
});
