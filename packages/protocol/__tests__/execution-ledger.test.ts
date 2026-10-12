import { afterEach, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore, ExecutionAdmissionError } from '../src/event-store.js';
import {
  ExecutionLedger,
  ExecutionAdmissionError as LedgerAdmissionError,
  type ExecutionLedgerOwner,
  type ExecutionSessionRow,
} from '../src/execution-ledger.js';
import { ExecutionLedgerBeforeExtraction } from './fixtures/execution-ledger-before-extraction.js';

const uuid = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:crypto', async (original) => ({
  ...(await original<typeof import('node:crypto')>()),
  randomUUID: () => `00000000-0000-0000-0000-${String(++uuid.count).padStart(12, '0')}`,
}));
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close());
  vi.restoreAllMocks();
});
const methods = [
  'beginExecution',
  'getExecutionAdmission',
  'getExecutionTerminalReason',
  'beginProviderAttempt',
  'transitionProviderAttempt',
  'getProviderAttempts',
  'transitionExecution',
  'recoverOrphanedExecutions',
] as const;

function fixture(before = false, file = false) {
  uuid.count = 0;
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-ledger-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = file ? join(directory, 'events.db') : ':memory:';
  let store: EventStore;
  const install = () => {
    store = new EventStore(path);
    const internal = store as unknown as {
      db: Database.Database;
      executionLedger: { owner: ExecutionLedgerOwner<ExecutionSessionRow> };
    };
    const db = internal.db;
    db.function('unixepoch', { varargs: true }, () => 1_800_000_000);
    if (before) {
      const oracle = new ExecutionLedgerBeforeExtraction(internal.executionLedger.owner);
      for (const method of methods) {
        // Preserve the real owner's dynamically dispatched public methods.
        Object.defineProperty(store, method, {
          value: oracle[method].bind(oracle),
          configurable: true,
        });
      }
    }
    return db;
  };
  let db = install();
  cleanups.push(() => store.close());
  store!.upsertSession({ sessionId: 'session', conversationSource: 'mitzo' });
  return {
    path,
    get store() {
      return store;
    },
    get db() {
      return db;
    },
    reopen() {
      store.close();
      db = install();
    },
    snapshot() {
      return Object.fromEntries(
        [
          'sessions',
          'client_command_claims',
          'execution_admissions',
          'provider_attempts',
          'events',
          'sqlite_sequence',
        ].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
      );
    },
    attempt(action: () => unknown) {
      try {
        return { value: action() };
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return {
          error: {
            name: error.name,
            message: error.message,
            ...(typeof (error as { code?: unknown }).code === 'string'
              ? { code: (error as { code: string }).code }
              : {}),
          },
        };
      }
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
function parity(run: (f: Fixture) => unknown, file = false) {
  const before = fixture(true, file);
  const expected = run(before);
  const snapshot = before.snapshot();
  const after = fixture(false, file);
  expect(run(after)).toEqual(expected);
  expect(after.snapshot()).toEqual(snapshot);
}

it('constructs a ledger without acquiring, opening, migrating or closing an owner database', () => {
  const database = vi.fn(() => {
    throw Error('Owner database accessed during construction');
  });
  const ledger = new ExecutionLedger({
    database,
  } as unknown as ExecutionLedgerOwner<ExecutionSessionRow>);
  expect(ledger).not.toHaveProperty('close');
  expect(database).not.toHaveBeenCalled();
  const source = readFileSync(new URL('../src/execution-ledger.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/from ['"]\.\/event-store\.js['"]/);
  expect(source).not.toMatch(/new Database|CREATE TABLE|ALTER TABLE|journal_mode/);
});

it('preserves the canonical exported admission error constructor', () => {
  expect(LedgerAdmissionError).toBe(ExecutionAdmissionError);
  const f = fixture();
  try {
    f.store.beginExecution('session', 'execution', 'command', '');
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionAdmissionError);
    return;
  }
  throw Error('Invalid admission must fail');
});

it('preserves exact duplicate receipts, conflicting fingerprints and generation history', () => {
  parity((f) => {
    const first = f.store.beginExecution('session', 'one', 'command', 'fingerprint');
    const duplicate = f.store.beginExecution('session', 'one', 'command', 'fingerprint');
    const conflict = f.attempt(() => f.store.beginExecution('session', 'one', 'command', 'other'));
    const idConflict = f.attempt(() =>
      f.store.beginExecution('session', 'other', 'command', 'fingerprint'),
    );
    const terminal = f.store.transitionExecution(first.token, 'TERMINAL', 'completed');
    const second = f.store.beginExecution('session', 'two', 'next', 'second');
    expect(duplicate).toEqual({ token: first.token, duplicate: true });
    expect(second.token.generation).toBe(2);
    expect(f.store.getExecutionTerminalReason(first.token)).toBe('completed');
    return { first, duplicate, conflict, idConflict, terminal, second };
  });
});

it.each([
  [undefined, 'unpaired'],
  ['', 'fp'],
  [' '.repeat(3), 'fp'],
  ['x'.repeat(513), 'fp'],
  ['command', undefined],
  ['command', ''],
  ['command', ' '.repeat(3)],
  ['command', 'x'.repeat(513)],
  [null, 'fp'],
  [5, 'fp'],
  ['command', 5],
])('preserves invalid admission rejection before writes: %s / %s', (command, fingerprint) => {
  parity((f) =>
    f.attempt(() =>
      f.store.beginExecution('session', 'one', command as never, fingerprint as never),
    ),
  );
});

const phases = ['RUNNING', 'REQUIRES_ACTION', 'STOPPING', 'TERMINAL'] as const;
it.each(phases.flatMap((phase) => phases.map((next) => ({ phase, next }))))(
  'preserves direct execution transition $phase to $next',
  ({ phase, next }) => {
    parity((f) => {
      const { token } = f.store.beginExecution('session', 'one');
      if (phase !== 'RUNNING')
        f.store.transitionExecution(token, phase, phase === 'TERMINAL' ? 'completed' : undefined);
      return f.attempt(() =>
        f.store.transitionExecution(token, next, next === 'TERMINAL' ? 'failed' : undefined),
      );
    });
  },
);

it('preserves stale token fencing, provider idempotency, parallel admission and terminal conflicts', () => {
  parity((f) => {
    const execution = f.store.beginExecution('session', 'one');
    const first = f.store.beginProviderAttempt(execution.token, 'first');
    const duplicate = f.store.beginProviderAttempt(execution.token, 'first');
    const blocked = f.attempt(() => f.store.beginProviderAttempt(execution.token, 'second'));
    const second = f.store.beginProviderAttempt(execution.token, 'second', { allowParallel: true });
    const terminalBlocked = f.attempt(() =>
      f.store.transitionExecution(execution.token, 'TERMINAL', 'completed'),
    );
    const stale = f.store.transitionProviderAttempt(
      { ...first.token, generation: 99 },
      'TERMINAL',
      'completed',
    );
    const finished = f.store.transitionProviderAttempt(first.token, 'TERMINAL', 'completed');
    const conflict = f.store.transitionProviderAttempt(first.token, 'TERMINAL', 'failed');
    expect(f.store.getProviderAttempts(execution.token)).toHaveLength(2);
    return {
      execution,
      first,
      duplicate,
      blocked,
      second,
      terminalBlocked,
      stale,
      finished,
      conflict,
    };
  });
});

it.each([
  'execution-state-event',
  'provider-start-event',
  'provider-end-event',
  'execution-end-event',
  'admission-receipt',
])('rolls back state, receipt and event atomically when %s fails', (point) => {
  parity((f) => {
    const token =
      point === 'execution-state-event' || point === 'admission-receipt'
        ? undefined
        : f.store.beginExecution('session', 'one').token;
    const attempt =
      point === 'provider-end-event'
        ? f.store.beginProviderAttempt(token!, 'attempt').token
        : undefined;
    const table = point === 'admission-receipt' ? 'execution_admissions' : 'events';
    const type = point.startsWith('provider')
      ? 'provider_attempt_state_changed'
      : 'execution_state_changed';
    f.db.exec(`CREATE TRIGGER injected_fault BEFORE INSERT ON ${table}
        ${table === 'events' ? `WHEN NEW.type = '${type}'` : ''}
        BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;`);
    const before = f.snapshot();
    const result = f.attempt(() =>
      point === 'provider-start-event'
        ? f.store.beginProviderAttempt(token!, 'attempt')
        : point === 'provider-end-event'
          ? f.store.transitionProviderAttempt(attempt!, 'TERMINAL', 'completed')
          : point === 'execution-end-event'
            ? f.store.transitionExecution(token!, 'TERMINAL', 'completed')
            : f.store.beginExecution('session', 'one', 'command', 'fp'),
    );
    expect(result).toMatchObject({ error: { message: 'injected write failure' } });
    expect(f.snapshot()).toEqual(before);
    f.db.exec('DROP TRIGGER injected_fault');
    return result;
  });
});

it('shares the owner transaction across session registration, ledger writes and ordinary events', () => {
  const f = fixture();
  const before = f.snapshot();
  expect(() =>
    f.db.transaction(() => {
      f.store.upsertSession({ sessionId: 'nested', conversationSource: 'mitzo' });
      const execution = f.store.beginExecution('nested', 'one', 'command', 'fp');
      f.store.beginProviderAttempt(execution.token, 'attempt');
      f.store.append('nested', 'user_message', { messageId: 'shared', text: 'same owner' });
      throw Error('Abort owning transaction');
    })(),
  ).toThrow('Abort owning transaction');
  expect(f.snapshot()).toEqual(before);
});

it('preserves partial restart recovery and retry without replaying settled attempts', () => {
  parity((f) => {
    const execution = f.store.beginExecution('session', 'one');
    f.store.beginProviderAttempt(execution.token, 'first');
    f.store.beginProviderAttempt(execution.token, 'second', { allowParallel: true });
    f.db.exec(`CREATE TRIGGER recovery_fault BEFORE INSERT ON events
      WHEN NEW.type='provider_attempt_state_changed' AND json_extract(NEW.payload,'$.providerAttemptId')='second'
      BEGIN SELECT RAISE(ABORT, 'second recovery write failed'); END;`);
    const failure = f.attempt(() => f.store.recoverOrphanedExecutions());
    expect(f.store.getProviderAttempts(execution.token).map((item) => item.phase)).toEqual([
      'TERMINAL',
      'RUNNING',
    ]);
    expect(f.store.getSession('session')?.executionPhase).toBe('RUNNING');
    f.db.exec('DROP TRIGGER recovery_fault');
    const count = f.store.recoverOrphanedExecutions();
    const repeated = f.store.recoverOrphanedExecutions();
    expect(count).toBe(1);
    expect(repeated).toBe(0);
    return { failure, count, repeated, attempts: f.store.getProviderAttempts(execution.token) };
  });
});

it('preserves caller-installed recovery interception rather than caching owner methods', () => {
  const f = fixture();
  const execution = f.store.beginExecution('session', 'one');
  f.store.beginProviderAttempt(execution.token, 'attempt');
  const spy = vi.spyOn(f.store, 'transitionProviderAttempt').mockImplementation(() => {
    throw Error('Owner fault');
  });
  expect(() => f.store.recoverOrphanedExecutions()).toThrow('Owner fault');
  expect(f.store.getSession('session')?.executionPhase).toBe('RUNNING');
  spy.mockRestore();
  expect(f.store.recoverOrphanedExecutions()).toBe(1);
});

it('reopens durable admissions and settles only original orphaned attempts after restart', () => {
  parity((f) => {
    const execution = f.store.beginExecution('session', 'one', 'command', 'fp');
    const attempt = f.store.beginProviderAttempt(execution.token, 'original');
    f.reopen();
    const duplicate = f.store.beginExecution('session', 'one', 'command', 'fp');
    const count = f.store.recoverOrphanedExecutions();
    const retry = f.store.beginProviderAttempt(execution.token, 'original');
    expect(duplicate.duplicate).toBe(true);
    expect(retry.duplicate).toBe(true);
    expect(f.store.getProviderAttempts(execution.token)[0].terminalReason).toBe('ambiguous');
    return { attempt, duplicate, count, retry };
  }, true);
});

it('preserves closed-owner errors and never replaces a closed database', () => {
  const before = fixture(true);
  const after = fixture(false);
  const token = { sessionId: 'session', executionId: 'one', generation: 1 };
  before.store.close();
  after.store.close();
  const run = (f: Fixture) => [
    f.attempt(() => f.store.beginExecution('session', 'one')),
    f.attempt(() => f.store.beginProviderAttempt(token, 'attempt')),
    f.attempt(() => f.store.getExecutionAdmission('session', 'command')),
    f.attempt(() => f.store.transitionExecution(token, 'TERMINAL', 'completed')),
    f.attempt(() => f.store.recoverOrphanedExecutions()),
  ];
  expect(run(after)).toEqual(run(before));
});

it('acquires the immediate owner write lock before a competing connection can claim the session', () => {
  parity((f) => {
    const peer = new EventStore(f.path);
    cleanups.push(() => peer.close());
    const peerDb = (peer as unknown as { db: Database.Database }).db;
    peerDb.function('unixepoch', { varargs: true }, () => 1_800_000_000);
    peerDb.pragma('busy_timeout = 0');
    f.db.pragma('busy_timeout = 0');
    const read = f.store.getExecutionAdmission.bind(f.store);
    let competing: unknown;
    vi.spyOn(f.store, 'getExecutionAdmission').mockImplementation((id, command) => {
      competing = f.attempt(() => peer.beginExecution(id, 'competing', 'competitor', 'peer-fp'));
      return read(id, command);
    });
    const result = f.attempt(() => f.store.beginExecution('session', 'owned', 'command', 'fp'));
    expect(competing).toMatchObject({ error: { code: 'SQLITE_BUSY' } });
    expect(result).toMatchObject({ value: { duplicate: false, token: { executionId: 'owned' } } });
    expect(f.store.getExecutionAdmission('session', 'competitor')).toBeUndefined();
    return { result, competing };
  }, true);
});

it.each(['type', 'config', 'both'])(
  'preserves retained Symposium recovery exclusion by %s',
  (binding) => {
    parity((f) => {
      const ordinary = f.store.beginExecution('session', 'ordinary');
      f.store.upsertSession({ sessionId: 'retained', conversationSource: 'mitzo' });
      const retained = f.store.beginExecution('retained', 'native');
      f.store.beginProviderAttempt(retained.token, 'original-native-attempt');
      // Historical retained configuration remains excluded even when its session type disagrees.
      f.db
        .prepare('UPDATE sessions SET session_type=?, symposium_config=? WHERE session_id=?')
        .run(
          binding === 'config' ? 'chat' : 'symposium',
          binding === 'type' ? null : '{}',
          'retained',
        );
      const count = f.store.recoverOrphanedExecutions({ excludeSymposium: true });
      expect(count).toBe(1);
      expect(f.store.getExecutionTerminalReason(ordinary.token)).toBe('server_restart');
      expect(f.store.getProviderAttempts(retained.token)[0].phase).toBe('RUNNING');
      return { count, retained: f.store.getProviderAttempts(retained.token) };
    });
  },
);

it('retains old-generation provider receipts without authorizing fresh work on their stale token', () => {
  parity((f) => {
    const first = f.store.beginExecution('session', 'first');
    const attempt = f.store.beginProviderAttempt(first.token, 'original');
    f.store.transitionProviderAttempt(attempt.token, 'TERMINAL', 'ambiguous');
    f.store.transitionExecution(first.token, 'TERMINAL', 'server_restart');
    const second = f.store.beginExecution('session', 'second');
    const duplicate = f.store.beginProviderAttempt(first.token, 'original');
    const fresh = f.attempt(() => f.store.beginProviderAttempt(first.token, 'must-not-start'));
    const rebound = f.attempt(() => f.store.beginProviderAttempt(second.token, 'original'));
    const conflict = f.store.transitionProviderAttempt(attempt.token, 'TERMINAL', 'completed');
    expect(duplicate.duplicate).toBe(true);
    expect(fresh).toHaveProperty('error');
    expect(rebound).toHaveProperty('error');
    expect(conflict.status).toBe('conflict');
    return { duplicate, fresh, rebound, conflict };
  });
});

it.each(['unknown', 'unregistered', 'internal'])(
  'preserves %s conversation admission fencing',
  (kind) => {
    parity((f) => {
      let id = 'missing';
      if (kind === 'unregistered') {
        id = 'session';
        f.db.exec(
          "UPDATE sessions SET conversation_source='legacy',is_active=0,prompt_count=0,num_turns=0,initial_prompt=NULL,account_binding=NULL,symposium_config=NULL WHERE session_id='session'",
        );
      }
      if (kind === 'internal') {
        id = 'reserved';
        f.store.registerInternalSdkExecution({
          sdkSessionId: id,
          parentSessionId: 'session',
          operationId: 'operation',
          purpose: 'web_search',
          cwd: '/offline',
        });
      }
      const before = f.snapshot();
      const result = f.attempt(() => f.store.beginExecution(id, 'must-not-start'));
      expect(result).toHaveProperty('error');
      expect(f.snapshot()).toEqual(before);
      return result;
    });
  },
);

it('shares admission validation and canonical error identity with global ingress command claims', () => {
  const f = fixture();
  expect(() => f.store.claimClientCommand('', 'fp')).toThrow(ExecutionAdmissionError);
  f.store.claimClientCommand('command', 'fp');
  f.store.claimClientCommand('command', 'fp');
  expect(() => f.store.claimClientCommand('command', 'different')).toThrow(ExecutionAdmissionError);
  expect(f.db.prepare('SELECT * FROM client_command_claims').all()).toEqual([
    { client_msg_id: 'command', request_fingerprint: 'fp' },
  ]);
});
