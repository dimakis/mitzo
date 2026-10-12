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
        ['sessions', 'execution_admissions', 'provider_attempts', 'events', 'sqlite_sequence'].map(
          (table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()],
        ),
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
            ...(error instanceof ExecutionAdmissionError ? { code: error.code } : {}),
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

it.each(['RUNNING', 'REQUIRES_ACTION', 'STOPPING', 'TERMINAL'] as const)(
  'preserves execution transition matrix from %s',
  (phase) => {
    parity((f) => {
      const { token } = f.store.beginExecution('session', 'one');
      if (phase !== 'RUNNING')
        f.store.transitionExecution(token, phase, phase === 'TERMINAL' ? 'completed' : undefined);
      return (['RUNNING', 'REQUIRES_ACTION', 'STOPPING', 'TERMINAL'] as const).map((next) =>
        f.attempt(() =>
          f.store.transitionExecution(token, next, next === 'TERMINAL' ? 'failed' : undefined),
        ),
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
