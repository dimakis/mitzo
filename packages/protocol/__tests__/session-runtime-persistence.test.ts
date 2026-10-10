import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/event-store.js';

const binding = {
  version: 1,
  account: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'profile-1' },
  harness: { implementation: 'codex' },
  execution: { location: 'local' },
} as const;
const meta = {
  sessionId: 'new-session',
  accountBinding: {
    ...binding.account,
    accountLabel: 'Personal ChatGPT',
    model: 'luna-test-fixture',
  },
  repositoryWorkspaceId: 'workspace-1',
  cwd: '/isolated/mitzo',
  summary: 'Initial',
};

describe('immutable dormant session runtime persistence', () => {
  let directory: string;
  let file: string;
  let store: EventStore;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mitzo-runtime-binding-'));
    file = join(directory, 'events.db');
    store = new EventStore(file);
  });
  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('distinguishes missing sessions and explicit absent legacy bindings without enrollment', () => {
    store.upsertSession({ sessionId: 'legacy', summary: 'Preserved' });
    expect(store.getSessionRuntimeBinding('missing')).toBeUndefined();
    expect(store.getSessionRuntimeBinding('legacy')).toBeNull();
    expect(() =>
      store.createSessionWithRuntimeBinding({ ...meta, sessionId: 'legacy' }, binding),
    ).toThrow(/legacy|existing/i);
    expect(store.getSession('legacy')?.summary).toBe('Preserved');
    store.close();
    store = new EventStore(file);
    expect(store.getSessionRuntimeBinding('legacy')).toBeNull();
  });

  it('rejects enrollment of a historical conversation without a sessions row', () => {
    store.append(meta.sessionId, 'user_message', { text: 'Historical' });
    expect(() => store.createSessionWithRuntimeBinding(meta, binding)).toThrow(
      /existing|historical/i,
    );
    expect(store.getSessionRuntimeBinding(meta.sessionId)).toBeUndefined();
  });

  it.each(['local', 'openshell'])(
    'preserves %s bindings across metadata updates and reopen',
    (location) => {
      const selected = { ...binding, execution: { location } };
      store.createSessionWithRuntimeBinding(meta, selected);
      store.upsertSession({ sessionId: meta.sessionId, summary: 'Updated', selectedModel: 'new' });
      store.close();
      store = new EventStore(file);
      expect(store.getSessionRuntimeBinding(meta.sessionId)).toEqual(selected);
      expect(store.getSession(meta.sessionId)).toMatchObject({
        summary: 'Updated',
        selectedModel: 'new',
      });
    },
  );

  it('makes exact repeats idempotent without rewriting metadata or timestamps', () => {
    store.createSessionWithRuntimeBinding(meta, binding);
    const before = store.getSession(meta.sessionId);
    store.createSessionWithRuntimeBinding({ ...meta, summary: 'Repeat ignored' }, binding);
    expect(store.getSession(meta.sessionId)).toEqual(before);
  });

  it.each([
    { ...binding, account: { ...binding.account, profileRevision: 'profile-2' } },
    { ...binding, execution: { location: 'openshell' } },
  ])('rejects runtime rebinding without altering metadata', (changed) => {
    store.createSessionWithRuntimeBinding(meta, binding);
    expect(() => store.createSessionWithRuntimeBinding(meta, changed)).toThrow();
    expect(store.getSessionRuntimeBinding(meta.sessionId)).toEqual(binding);
  });

  it.each([
    { ...meta, accountBinding: { ...meta.accountBinding, accountId: 'work' } },
    { ...meta, accountBinding: { ...meta.accountBinding, provider: 'openai' } },
    { ...meta, accountBinding: { ...meta.accountBinding, profileRevision: 'profile-2' } },
    { ...meta, accountBinding: null },
    { ...meta, repositoryWorkspaceId: null },
    { ...meta, cwd: '' },
  ])('rejects inconsistent creation atomically: %j', (changed) => {
    expect(() => store.createSessionWithRuntimeBinding(changed, binding)).toThrow();
    expect(store.getSession(meta.sessionId)).toBeNull();
    expect(store.getSessionRuntimeBinding(meta.sessionId)).toBeUndefined();
  });

  it.each([
    { accountBinding: { ...meta.accountBinding, accountId: 'work' } },
    { accountBinding: { ...meta.accountBinding, provider: 'openai' } },
    { accountBinding: { ...meta.accountBinding, profileRevision: 'profile-2' } },
    { accountBinding: null },
    { repositoryWorkspaceId: 'workspace-2' },
    { repositoryWorkspaceId: null },
    { cwd: '/other/workspace' },
    { cwd: null },
  ])('rejects identity drift through ordinary metadata updates: %j', (changed) => {
    store.createSessionWithRuntimeBinding(meta, binding);
    const before = store.getSession(meta.sessionId);
    expect(() =>
      store.upsertSession({ sessionId: meta.sessionId, summary: 'Must not apply', ...changed }),
    ).toThrow();
    expect(store.getSession(meta.sessionId)).toEqual(before);
    expect(store.getSessionRuntimeBinding(meta.sessionId)).toEqual(binding);
  });

  it.each(['{broken-json', JSON.stringify({ ...binding, version: 2 }), '{}', 'null'])(
    'fails closed for corrupt or unsupported durable bindings: %s',
    (raw) => {
      store.createSessionWithRuntimeBinding(meta, binding);
      const db = new Database(file);
      db.prepare('UPDATE sessions SET runtime_binding = ? WHERE session_id = ?').run(
        raw,
        meta.sessionId,
      );
      db.close();
      expect(() => store.getSessionRuntimeBinding(meta.sessionId)).toThrow();
      expect(() => store.createSessionWithRuntimeBinding(meta, binding)).toThrow();
      expect(() =>
        store.upsertSession({ sessionId: meta.sessionId, summary: 'No repair' }),
      ).toThrow();
    },
  );

  it('cross-checks durable account identity when reading', () => {
    store.createSessionWithRuntimeBinding(meta, binding);
    const db = new Database(file);
    db.prepare('UPDATE sessions SET account_binding = ? WHERE session_id = ?').run(
      JSON.stringify({ ...meta.accountBinding, accountId: 'work' }),
      meta.sessionId,
    );
    db.close();
    expect(() => store.getSessionRuntimeBinding(meta.sessionId)).toThrow();
    expect(() =>
      store.upsertSession({ sessionId: meta.sessionId, summary: 'No laundering' }),
    ).toThrow();
  });

  it('rolls back session creation if binding persistence fails', () => {
    const db = new Database(file);
    db.exec(`CREATE TRIGGER reject_runtime BEFORE UPDATE OF runtime_binding ON sessions
      BEGIN SELECT RAISE(ABORT, 'runtime write failed'); END`);
    db.close();
    expect(() => store.createSessionWithRuntimeBinding(meta, binding)).toThrow(
      /runtime write failed/,
    );
    expect(store.getSession(meta.sessionId)).toBeNull();
  });

  it('allows exact creation retries across independent stores and rejects competing bindings', () => {
    const competing = new EventStore(file);
    try {
      store.createSessionWithRuntimeBinding(meta, binding);
      competing.createSessionWithRuntimeBinding({ ...meta, summary: 'Ignored retry' }, binding);
      expect(() =>
        competing.createSessionWithRuntimeBinding(meta, {
          ...binding,
          execution: { location: 'openshell' },
        }),
      ).toThrow(/cannot be replaced/);
      expect(competing.getSession(meta.sessionId)).toEqual(store.getSession(meta.sessionId));
      expect(store.getSession(meta.sessionId)?.summary).toBe('Initial');
      expect(competing.getSessionRuntimeBinding(meta.sessionId)).toEqual(binding);
    } finally {
      competing.close();
    }
  });

  it.each([{ sessionType: 'symposium' }, { symposiumConfig: '{}' }, { symposiumRevision: 1 }])(
    'rejects Symposium metadata in ordinary runtime allocation: %j',
    (fields) => {
      expect(() =>
        store.createSessionWithRuntimeBinding({ ...meta, ...fields } as never, binding),
      ).toThrow(/ordinary/i);
      expect(store.getSessionRuntimeBinding(meta.sessionId)).toBeUndefined();
    },
  );

  it('rejects direct Symposium conversion for runtime-bound ordinary sessions', () => {
    store.createSessionWithRuntimeBinding(meta, binding);
    const config = {
      version: 1,
      revision: 1,
      state: 'draft',
      seats: ['primary', 'reviewer'].map((role) => ({
        id: role,
        role,
        name: role,
        model: 'fixture',
        systemPrompt: '',
        color: '#112233',
      })),
      turnRules: { mode: 'directed', maxTurns: 2 },
      interceptMode: 'manual',
    };
    expect(() => store.setSymposiumConfig(meta.sessionId, config)).toThrow(
      /runtime-bound ordinary/i,
    );
    expect(store.getSession(meta.sessionId)?.sessionType).toBe('chat');
    expect(store.getSessionRuntimeBinding(meta.sessionId)).toEqual(binding);
  });

  it('checks ordinary runtime binding after acquiring the Symposium write transaction', () => {
    const competing = new EventStore(file);
    const connection = (store as unknown as { db: Database.Database }).db;
    const transaction = connection.transaction.bind(connection);
    // Deterministically interleave another process's successful creation at the
    // transaction acquisition boundary, after any unfenced preliminary reads.
    const interception = vi.spyOn(connection, 'transaction').mockImplementationOnce(((
      callback: () => unknown,
    ) => {
      competing.createSessionWithRuntimeBinding(meta, binding);
      return transaction(callback);
    }) as typeof connection.transaction);
    try {
      const config = {
        version: 1,
        revision: 1,
        state: 'draft',
        seats: ['primary', 'reviewer'].map((role) => ({
          id: role,
          role,
          name: role,
          model: 'fixture',
          systemPrompt: '',
          color: '#112233',
        })),
        turnRules: { mode: 'directed', maxTurns: 2 },
        interceptMode: 'manual',
      };
      expect(() => store.setSymposiumConfig(meta.sessionId, config)).toThrow(
        /runtime-bound ordinary/i,
      );
      expect(store.getSession(meta.sessionId)?.sessionType).toBe('chat');
      expect(competing.getSessionRuntimeBinding(meta.sessionId)).toEqual(binding);
    } finally {
      interception.mockRestore();
      competing.close();
    }
  });

  it('rejects direct Symposium account transfer for runtime-bound ordinary sessions', () => {
    store.createSessionWithRuntimeBinding(meta, binding);
    expect(() =>
      store.transferSymposiumAnchor({
        sessionId: meta.sessionId,
        fromSeatId: 'primary',
        toSeatId: 'reviewer',
        expectedRevision: 1,
        expectedGeneration: 1,
        actor: 'fixture',
        reason: 'fixture',
        idempotencyKey: 'fixture',
      }),
    ).toThrow(/runtime-bound ordinary/i);
    expect(store.getSessionRuntimeBinding(meta.sessionId)).toEqual(binding);
  });

  it('refuses a runtime-bound record that conflicts with an internal execution identity', () => {
    store.createSessionWithRuntimeBinding(meta, binding);
    const db = new Database(file);
    db.prepare(
      `INSERT INTO internal_sdk_executions
      (sdk_session_id, parent_session_id, operation_id, purpose, cwd) VALUES (?, ?, ?, ?, ?)`,
    ).run(meta.sessionId, 'parent', 'operation', 'web_search', '/internal');
    db.close();
    expect(() => store.getSessionRuntimeBinding(meta.sessionId)).toThrow(/internal/i);
    expect(() => store.createSessionWithRuntimeBinding(meta, binding)).toThrow(/internal/i);
  });

  it.each(["session_type = 'symposium'", "symposium_config = '{}'", 'symposium_revision = 1'])(
    'fails closed for mixed ordinary/Symposium state: %s',
    (change) => {
      store.createSessionWithRuntimeBinding(meta, binding);
      const db = new Database(file);
      db.exec(`UPDATE sessions SET ${change}`);
      db.close();
      expect(() => store.getSessionRuntimeBinding(meta.sessionId)).toThrow();
      expect(() => store.createSessionWithRuntimeBinding(meta, binding)).toThrow();
      expect(() =>
        store.upsertSession({ sessionId: meta.sessionId, summary: 'No mixed state' }),
      ).toThrow();
    },
  );

  it('does not allow runtime enrollment through generic metadata upserts', () => {
    expect(() => store.upsertSession({ ...meta, runtimeBinding: binding } as never)).toThrow();
    expect(store.getSession(meta.sessionId)).toBeNull();
  });
});
