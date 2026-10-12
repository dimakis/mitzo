import type Database from 'better-sqlite3';
import Sqlite from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore, toClientState } from '../src/event-store.js';
import {
  SessionLifecycleStore,
  type SessionLifecycleOwner,
} from '../src/session-lifecycle-store.js';
import { SessionLifecycleBeforeExtraction } from './fixtures/session-lifecycle-before-extraction.js';
import type { SessionState } from '../src/types.js';

const states: SessionState[] = [
  'CREATED',
  'STARTING',
  'ACTIVE',
  'DETACHED',
  'SUSPENDED',
  'CLOSING',
  'ENDED',
];
const allowed: Record<SessionState, SessionState[]> = {
  CREATED: ['STARTING', 'ENDED'],
  STARTING: ['ACTIVE', 'ENDED'],
  ACTIVE: ['DETACHED', 'SUSPENDED', 'CLOSING', 'ENDED'],
  DETACHED: ['ACTIVE', 'SUSPENDED', 'CLOSING', 'ENDED'],
  SUSPENDED: ['ACTIVE', 'ENDED'],
  CLOSING: ['ENDED'],
  ENDED: ['CREATED'],
};
const now = 1_800_000_000_000;
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
});
function fixture(before = false, file = false) {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-lifecycle-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = file ? join(directory, 'events.db') : ':memory:';
  const logs: unknown[] = [];
  const logger = {
    info(message: string, fields?: Record<string, unknown>) {
      if (
        [
          'invalid session state transition (warn-only)',
          'session state transition',
          'recovered stale sessions on startup',
        ].includes(message)
      )
        logs.push(structuredClone({ message, fields }));
    },
  };
  let store: EventStore;
  let db: Database.Database;
  let owner: SessionLifecycleOwner;
  function install() {
    store = new EventStore(path, logger);
    const internal = store as unknown as {
      db: Database.Database | null;
      stmts: SessionLifecycleOwner['statements'];
    };
    db = internal.db!;
    db.function('unixepoch', { varargs: true }, () => now / 1000);
    owner = {
      database: () => internal.db,
      statements: internal.stmts,
      logger,
      getSession: (id) => store.getSession(id),
      getSessionClientState: (id) => store.getSessionClientState(id),
      append: (id, type, payload) => store.append(id, type, payload),
      setSessionState: (id, state, opts) => store.setSessionState(id, state, opts),
      toClientState,
    };
    if (before) {
      const oracle = new SessionLifecycleBeforeExtraction(owner);
      for (const name of ['setSessionState', 'getSessionState', 'recoverStaleSessions'] as const)
        Object.defineProperty(store, name, {
          value: oracle[name].bind(oracle),
          configurable: true,
        });
    }
  }
  install();
  cleanups.push(() => store.close());
  store!.upsertSession({ sessionId: 'one' });
  return {
    get store() {
      return store;
    },
    get db() {
      return db;
    },
    get owner() {
      return owner;
    },
    logs,
    path,
    seed(id: string, state: SessionState | null) {
      store.upsertSession({ sessionId: id });
      db.prepare(
        'UPDATE sessions SET state=?, is_active=1, last_state_change=123 WHERE session_id=?',
      ).run(state, id);
    },
    reopen() {
      store.close();
      install();
    },
    rows() {
      return ['sessions', 'events', 'sqlite_sequence'].map((table) =>
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
  const expected = fixture(true, file);
  const actual = fixture(false, file);
  const expectedValue = run(expected);
  const actualValue = run(actual);
  expect(actualValue).toEqual(expectedValue);
  expect(actual.rows()).toEqual(expected.rows());
  expect(actual.logs).toEqual(expected.logs);
}

for (const from of states)
  for (const to of states) {
    it(`preserves ${from} → ${to}, warning, active flag and event ordering`, () =>
      parity((f) => {
        f.seed('one', from);
        expect(
          f.store.setSessionState('one', to, { clientId: 'client', reason: 'test' }),
        ).toBeUndefined();
        expect(f.store.getSessionState('one')).toBe(to);
        expect(f.store.getSession('one')).toMatchObject({
          state: to,
          isActive: to !== 'ENDED' && to !== 'CLOSING',
          lastStateChange: now,
        });
        const events = f.store.getSessionEvents('one');
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: 'session_state_changed',
          payload: {
            sessionId: 'one',
            state: toClientState(to),
            internalState: to,
            timestamp: now,
          },
        });
        const warns = f.logs.filter((log) =>
          (log as { message: string }).message.includes('warn-only'),
        );
        expect(warns).toHaveLength(allowed[from].includes(to) ? 0 : 1);
        return { events, state: f.store.getSession('one') };
      }));
  }
for (const to of states)
  it(`force retains ${to} writes and suppresses warning`, () =>
    parity((f) => {
      f.seed('one', 'ENDED');
      f.store.setSessionState('one', to, { force: true, clientId: 'forced', reason: 'operator' });
      expect(f.logs).toHaveLength(1);
      return f.store.getSessionEvents('one');
    }));
it('uses a single timestamp and treats a null state as no prior transition', () =>
  parity((f) => {
    f.seed('one', null);
    f.store.setSessionState('one', 'ACTIVE');
    expect(f.logs).toHaveLength(1);
    return f.store.getSession('one');
  }));
it('preserves the missing-row event without inventing session metadata', () =>
  parity((f) => {
    expect(f.store.getSessionState('missing')).toBeNull();
    f.store.setSessionState('missing', 'ACTIVE');
    expect(f.store.getSession('missing')).toBeNull();
    expect(f.store.getSessionEvents('missing')[0].payload.state).toBe('running');
  }));
it('reads raw null and retained unknown states without rewriting them', () =>
  parity((f) => {
    f.seed('null', null);
    f.db.prepare("UPDATE sessions SET state='historic' WHERE session_id='one'").run();
    expect(f.store.getSessionState('null')).toBeNull();
    expect(f.store.getSessionState('one')).toBe('historic');
    return f.rows();
  }));
it('resolves public metadata and client-state hooks at each call', () =>
  parity((f) => {
    const calls: string[] = [];
    vi.spyOn(f.store, 'getSession').mockImplementation(() => {
      calls.push('metadata');
      return null;
    });
    vi.spyOn(f.store, 'getSessionClientState').mockImplementation(() => {
      calls.push('projection');
      expect(f.store.getSessionState('one')).toBe('ACTIVE');
      return 'idle';
    });
    const append = f.store.append.bind(f.store);
    vi.spyOn(f.store, 'append').mockImplementation((id, type, payload) => {
      calls.push('append');
      return append(id, type, payload);
    });
    f.store.setSessionState('one', 'ACTIVE');
    expect(calls).toEqual(['metadata', 'projection', 'append']);
    expect(f.store.getSessionEvents('one')[0].payload.state).toBe('idle');
  }));
for (const signal of ['user_message', 'session_end', 'execution_state_changed'] as const)
  it(`uses the durable ${signal} turn projection after the row changes`, () =>
    parity((f) => {
      f.store.append(
        'one',
        signal,
        signal === 'execution_state_changed' ? { clientState: 'idle' } : {},
      );
      f.store.setSessionState('one', 'ACTIVE');
      expect(f.store.getSessionEvents('one').at(-1)?.payload.state).toBe(
        signal === 'user_message' ? 'running' : 'idle',
      );
    }));
for (const failure of ['metadata', 'warning', 'sql', 'projection', 'append', 'log'] as const)
  it(`preserves writes and error ordering when ${failure} fails`, () =>
    parity((f) => {
      f.seed('one', 'ENDED');
      const fail = () => {
        throw new Error(`${failure} fault`);
      };
      if (failure === 'metadata') vi.spyOn(f.store, 'getSession').mockImplementation(fail);
      if (failure === 'warning') vi.spyOn(f.owner.logger, 'info').mockImplementation(fail);
      if (failure === 'sql')
        f.db.exec(
          "CREATE TRIGGER fail_state BEFORE UPDATE OF state ON sessions BEGIN SELECT RAISE(ABORT, 'sql fault'); END",
        );
      if (failure === 'projection')
        vi.spyOn(f.store, 'getSessionClientState').mockImplementation(fail);
      if (failure === 'append') vi.spyOn(f.store, 'append').mockImplementation(fail);
      if (failure === 'log')
        vi.spyOn(f.owner.logger, 'info').mockImplementation((message) => {
          if (message === 'session state transition') fail();
        });
      expect(outcome(() => f.store.setSessionState('one', 'ACTIVE'))).toEqual({
        error: { name: failure === 'sql' ? 'SqliteError' : 'Error', message: `${failure} fault` },
      });
      expect(f.store.getSessionState('one')).toBe(
        ['metadata', 'warning', 'sql'].includes(failure) ? 'ENDED' : 'ACTIVE',
      );
      expect(f.store.getSessionEvents('one')).toHaveLength(failure === 'log' ? 1 : 0);
    }));
it('borrows the database and statements without taking close ownership', () => {
  const f = fixture();
  const lifecycle = new SessionLifecycleStore(f.owner);
  lifecycle.setSessionState('one', 'STARTING');
  expect(f.store.getSessionState('one')).toBe('STARTING');
  f.store.close();
  expect(() => lifecycle.getSessionState('one')).toThrow();
  expect(() => lifecycle.recoverStaleSessions()).toThrow();
  f.store.close();
});
it('retains an outer transaction and rolls its lifecycle event back with it', () =>
  parity((f) => {
    expect(() =>
      f.db.transaction(() => {
        f.store.setSessionState('one', 'ACTIVE');
        expect(f.db.inTransaction).toBe(true);
        expect(f.store.getSessionState('one')).toBe('ACTIVE');
        throw new Error('outer rollback');
      })(),
    ).toThrow('outer rollback');
    expect(f.store.getSessionState('one')).toBe('ENDED');
    expect(f.store.getSessionEvents('one')).toEqual([]);
  }));
it('preserves a committed lifecycle across reopen and recovery is idempotent', () =>
  parity((f) => {
    f.store.setSessionState('one', 'DETACHED');
    f.reopen();
    expect(f.store.getSessionState('one')).toBe('DETACHED');
    expect(f.store.recoverStaleSessions()).toBe(1);
    expect(f.store.recoverStaleSessions()).toBe(0);
    f.reopen();
    expect(f.store.getSessionState('one')).toBe('ENDED');
    expect(f.store.getSessionEvents('one')).toHaveLength(2);
  }, true));
for (const excludeSymposium of [undefined, false, true])
  it(`preserves restart selection with exclusion ${excludeSymposium}`, () =>
    parity((f) => {
      for (const state of states) f.seed(state, state);
      f.seed('typed-symposium', 'ACTIVE');
      f.db
        .prepare("UPDATE sessions SET session_type='symposium' WHERE session_id='typed-symposium'")
        .run();
      f.seed('configured-symposium', 'ACTIVE');
      f.db
        .prepare(
          "UPDATE sessions SET symposium_config='{}' WHERE session_id='configured-symposium'",
        )
        .run();
      f.seed('hidden', 'ACTIVE');
      f.store.hideSession('hidden');
      f.seed('legacy', 'ACTIVE');
      f.db
        .prepare(
          "UPDATE sessions SET conversation_source='legacy', prompt_count=0 WHERE session_id='legacy'",
        )
        .run();
      f.seed('null', null);
      const count = f.store.recoverStaleSessions(
        excludeSymposium === undefined ? undefined : { excludeSymposium },
      );
      expect(count).toBe(excludeSymposium ? 7 : 9);
      for (const state of states)
        expect(f.store.getSessionState(state)).toBe(state === 'CREATED' ? 'CREATED' : 'ENDED');
      expect(f.store.getSessionState('typed-symposium')).toBe(
        excludeSymposium ? 'ACTIVE' : 'ENDED',
      );
      expect(f.store.getSessionState('configured-symposium')).toBe(
        excludeSymposium ? 'ACTIVE' : 'ENDED',
      );
      expect(f.store.getSessionState('hidden')).toBe('ENDED');
      expect(f.store.getSessionState('legacy')).toBe('ENDED');
      expect(f.store.getSessionState('null')).toBeNull();
      return count;
    }));
it('recovery takes its initial row selection once and calls the public transition hook', () =>
  parity((f) => {
    f.seed('one', 'ACTIVE');
    f.seed('two', 'SUSPENDED');
    const calls: string[] = [];
    const transition = f.store.setSessionState.bind(f.store);
    vi.spyOn(f.store, 'setSessionState').mockImplementation((id, state, opts) => {
      calls.push(id);
      if (id === 'one') f.seed('later', 'ACTIVE');
      expect(opts).toEqual({ reason: 'server_restart', force: true });
      transition(id, state, opts);
    });
    expect(f.store.recoverStaleSessions()).toBe(2);
    expect(calls).toEqual(['one', 'two']);
    expect(f.store.getSessionState('later')).toBe('ACTIVE');
  }));
it('does not wrap a partially failed recovery in a new transaction', () =>
  parity((f) => {
    f.seed('one', 'ACTIVE');
    f.seed('two', 'ACTIVE');
    f.seed('three', 'ACTIVE');
    const transition = f.store.setSessionState.bind(f.store);
    vi.spyOn(f.store, 'setSessionState').mockImplementation((id, state, opts) => {
      if (id === 'two') throw new Error('second recovery fault');
      transition(id, state, opts);
    });
    expect(outcome(() => f.store.recoverStaleSessions())).toEqual({
      error: { name: 'Error', message: 'second recovery fault' },
    });
    expect(f.store.getSessionState('one')).toBe('ENDED');
    expect(f.store.getSessionState('two')).toBe('ACTIVE');
    expect(f.store.getSessionState('three')).toBe('ACTIVE');
    expect(f.logs).toHaveLength(1);
    expect(f.db.inTransaction).toBe(false);
  }));
it('recovery stays within an existing caller transaction', () =>
  parity((f) => {
    f.seed('one', 'ACTIVE');
    expect(() =>
      f.db.transaction(() => {
        expect(f.store.recoverStaleSessions()).toBe(1);
        expect(f.db.inTransaction).toBe(true);
        throw new Error('restart rollback');
      })(),
    ).toThrow('restart rollback');
    expect(f.store.getSessionState('one')).toBe('ACTIVE');
    expect(f.store.getSessionEvents('one')).toEqual([]);
  }));
it('a peer WAL connection sees the same committed lifecycle event and row', () =>
  parity((f) => {
    const peer = new Sqlite(f.path);
    try {
      f.store.setSessionState('one', 'ACTIVE');
      expect(
        peer.prepare("SELECT state, is_active FROM sessions WHERE session_id='one'").get(),
      ).toEqual({ state: 'ACTIVE', is_active: 1 });
      expect(
        peer.prepare("SELECT json_extract(payload,'$.internalState') AS state FROM events").all(),
      ).toEqual([{ state: 'ACTIVE' }]);
      return peer.prepare('SELECT * FROM events').all();
    } finally {
      peer.close();
    }
  }, true));

it('persists partial transition progress across a failed append and reopen', () =>
  parity((f) => {
    const append = vi.spyOn(f.store, 'append').mockImplementation(() => {
      throw new Error('append failure');
    });
    expect(outcome(() => f.store.setSessionState('one', 'ACTIVE'))).toEqual({
      error: { name: 'Error', message: 'append failure' },
    });
    append.mockRestore();
    f.reopen();
    expect(f.store.getSessionState('one')).toBe('ACTIVE');
    expect(f.store.getSessionEvents('one')).toEqual([]);
    expect(f.store.recoverStaleSessions()).toBe(1);
    expect(f.store.getSessionEvents('one')).toHaveLength(1);
  }, true));
it('preserves completed recovery if only the summary logger throws', () =>
  parity((f) => {
    f.seed('one', 'ACTIVE');
    f.seed('two', 'CLOSING');
    vi.spyOn(f.owner.logger, 'info').mockImplementation((message) => {
      if (message === 'recovered stale sessions on startup') throw new Error('summary fault');
    });
    expect(outcome(() => f.store.recoverStaleSessions())).toEqual({
      error: { name: 'Error', message: 'summary fault' },
    });
    expect(f.store.getSessionState('one')).toBe('ENDED');
    expect(f.store.getSessionState('two')).toBe('ENDED');
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 2 });
  }));
it('closed public lifecycle operations preserve their errors and create no writes', () => {
  const before = fixture(true);
  const after = fixture();
  before.store.close();
  after.store.close();
  for (const call of [
    (s: EventStore) => s.getSessionState('one'),
    (s: EventStore) => s.setSessionState('one', 'ACTIVE'),
    (s: EventStore) => s.recoverStaleSessions(),
  ])
    expect(outcome(() => call(after.store))).toEqual(outcome(() => call(before.store)));
});
it('a failed nested savepoint rolls back recovery without ending its parent transaction', () =>
  parity((f) => {
    f.seed('one', 'ACTIVE');
    f.db.transaction(() => {
      expect(() =>
        f.db.transaction(() => {
          expect(f.store.recoverStaleSessions()).toBe(1);
          throw new Error('savepoint rollback');
        })(),
      ).toThrow('savepoint rollback');
      expect(f.db.inTransaction).toBe(true);
      expect(f.store.getSessionState('one')).toBe('ACTIVE');
      expect(f.store.getSessionEvents('one')).toEqual([]);
      f.store.setSessionState('one', 'DETACHED');
    })();
    expect(f.store.getSessionState('one')).toBe('DETACHED');
    expect(f.store.getSessionEvents('one')).toHaveLength(1);
  }));
