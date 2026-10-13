import type Database from 'better-sqlite3';
import Sqlite from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/event-store.js';
import {
  SessionMetadataStore,
  type SessionMetadataOwner,
  type SessionUpsert,
} from '../src/session-metadata-store.js';
import { SessionMetadataBeforeExtraction } from './fixtures/session-metadata-before-extraction.js';

const now = 1_800_000_000_000;
const methods = [
  'getSessionRuntimeBinding',
  'createSessionWithRuntimeBinding',
  'upsertSession',
  'getSession',
  'isSessionHidden',
  'getKnownSessionIds',
  'listSessions',
  'searchSessions',
  'markSessionInactive',
  'hideSession',
  'incrementPromptCount',
  'markManuallyRenamed',
  'updateLastSpeaker',
  'getAttentionSessions',
  'recordUsage',
] as const;
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((f) => f());
  vi.restoreAllMocks();
});
function fixture(before = false, file = false) {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-metadata-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = file ? join(directory, 'events.db') : ':memory:';
  let store: EventStore;
  let internal: {
    db: Database.Database | null;
    stmts: SessionMetadataOwner['statements'];
    assertConversationIdentity(id: string): void;
  };
  let owner: SessionMetadataOwner;
  function install() {
    store = new EventStore(path);
    internal = store as unknown as typeof internal;
    internal.db!.function('unixepoch', { varargs: true }, () => now / 1000);
    owner = {
      database: () => internal.db,
      statements: internal.stmts,
      assertConversationIdentity: (id) => internal.assertConversationIdentity(id),
      getInternalSdkExecution: (id) => store.getInternalSdkExecution(id),
      upsertSession: (meta) => store.upsertSession(meta),
    };
    if (before) {
      const oracle = new SessionMetadataBeforeExtraction(owner);
      for (const method of methods)
        Object.defineProperty(store, method, {
          value: oracle[method].bind(oracle),
          configurable: true,
        });
    }
  }
  install();
  cleanups.push(() => store.close());
  return {
    get store() {
      return store;
    },
    get db() {
      return internal.db!;
    },
    get owner() {
      return owner;
    },
    path,
    reopen() {
      store.close();
      install();
    },
    rows() {
      return ['sessions', 'events', 'internal_sdk_executions'].map((table) =>
        internal.db!.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
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
  const expected = fixture(true, file),
    actual = fixture(false, file);
  expect(run(actual)).toEqual(run(expected));
  expect(actual.rows()).toEqual(expected.rows());
}
const account = {
  accountId: 'personal',
  accountLabel: 'Personal',
  provider: 'openai-codex',
  model: 'luna-fixture',
  profileRevision: 'profile-1',
} as const;
const binding = {
  version: 1,
  account: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'profile-1' },
  harness: { implementation: 'codex' },
  execution: { location: 'local' },
} as const;
const bound = {
  sessionId: 'bound',
  cwd: '/test/workspace',
  repositoryWorkspaceId: 'workspace-1',
  accountBinding: account,
};

it('uses the focused owner without opening or closing another connection', () => {
  const f = fixture();
  const metadata = new SessionMetadataStore(f.owner);
  metadata.upsertSession({ sessionId: 'one', summary: 'kept' });
  expect(f.store.getSession('one')?.summary).toBe('kept');
  expect(f.db.open).toBe(true);
  f.store.close();
  expect(() => metadata.listSessions()).toThrow();
});
it('preserves defaults and missing-row reads', () =>
  parity((f) => {
    expect(f.store.getSession('absent')).toBeNull();
    expect(f.store.getSessionRuntimeBinding('absent')).toBeUndefined();
    f.store.upsertSession({ sessionId: 'one' });
    expect(f.store.getSession('one')).toMatchObject({
      mode: 'agent',
      conversationSource: 'mitzo',
      isActive: true,
      promptCount: 0,
    });
    return f.store.getSession('one');
  }));
const updates: Array<[string, Partial<SessionUpsert>]> = [
  ['summary', { summary: 'new title' }],
  ['branch', { branch: 'feature' }],
  ['cwd', { cwd: '/test/project' }],
  ['mode', { mode: 'ask' }],
  ['active', { isActive: false }],
  ['prompt', { initialPrompt: 'initial' }],
  ['verified', { sdkTranscriptVerified: true }],
  ['goal', { goalId: 'goal' }],
  ['telos', { telosTaskId: 'telos' }],
  ['worktree', { wtId: 'worktree' }],
  ['closed', { closedBy: 'user' }],
  ['agent', { agentName: 'Reviewer' }],
  ['account', { accountBinding: account }],
  ['model', { selectedModel: 'luna-fixture' }],
  ['reasoning', { reasoningEffort: 'low' }],
  ['boot', { bootContext: 'context' }],
  ['source', { conversationSource: 'external_import' }],
  ['workspace', { repositoryWorkspaceId: 'workspace' }],
  ['updated', { updatedAt: 123 }],
  ['clear title', { summary: null }],
  ['clear account', { accountBinding: null }],
  ['clear cwd', { cwd: null }],
];
it.each(updates)('preserves insertion and update of %s', (_name, update) =>
  parity((f) => {
    f.store.upsertSession({ sessionId: 'insert', ...update });
    f.store.upsertSession({ sessionId: 'update', summary: 'initial', createdAt: 12 });
    f.store.upsertSession({ sessionId: 'update', ...update });
    f.store.upsertSession({ sessionId: 'update', createdAt: 999 });
    expect(f.store.getSession('update')?.createdAt).toBe(12);
    return f.store.listSessions();
  }),
);
it('preserves runtime enrollment, exact retries and public upsert hooks', () =>
  parity((f) => {
    const upsert = vi.spyOn(f.store, 'upsertSession');
    f.store.createSessionWithRuntimeBinding(bound, binding);
    expect(upsert).toHaveBeenCalledTimes(1);
    const initial = f.store.getSession('bound');
    f.store.createSessionWithRuntimeBinding({ ...bound, summary: 'ignored on retry' }, binding);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(f.store.getSession('bound')).toEqual(initial);
    return f.store.getSessionRuntimeBinding('bound');
  }));
it.each([
  ['runtime account', { ...bound, accountBinding: { ...account, accountId: 'other' } }],
  ['workspace', { ...bound, repositoryWorkspaceId: 'other' }],
  ['cwd', { ...bound, cwd: '/other' }],
])('refuses replacing %s on a runtime-bound row', (_name, meta) =>
  parity((f) => {
    f.store.createSessionWithRuntimeBinding(bound, binding);
    const initial = f.store.getSession('bound');
    const failed = outcome(() => f.store.upsertSession(meta));
    expect(failed).toHaveProperty('error');
    expect(f.store.getSession('bound')).toEqual(initial);
    return failed;
  }),
);
it('rolls back runtime enrollment if the binding write fails', () =>
  parity((f) => {
    f.db.exec(
      "CREATE TRIGGER reject_binding BEFORE UPDATE OF runtime_binding ON sessions BEGIN SELECT RAISE(ABORT, 'binding refused'); END",
    );
    const failed = outcome(() => f.store.createSessionWithRuntimeBinding(bound, binding));
    expect(f.store.getSession('bound')).toBeNull();
    return failed;
  }));
it('respects outer transactions and nested rollback', () =>
  parity((f) => {
    const before = f.rows();
    expect(() =>
      f.db.transaction(() => {
        f.store.createSessionWithRuntimeBinding(bound, binding);
        f.store.incrementPromptCount('bound');
        throw Error('rollback');
      })(),
    ).toThrow('rollback');
    expect(f.rows()).toEqual(before);
    f.db.transaction(() => {
      f.store.upsertSession({ sessionId: 'kept' });
      expect(() =>
        f.db.transaction(() => {
          f.store.hideSession('kept');
          throw Error('nested');
        })(),
      ).toThrow('nested');
    })();
    expect(f.store.isSessionHidden('kept')).toBe(false);
    return f.store.listSessions();
  }));
it('keeps legacy/historical enrollment and internal execution identities excluded', () =>
  parity((f) => {
    f.store.upsertSession({ sessionId: 'legacy' });
    f.store.append('historic', 'user_message', { text: 'saved' });
    f.store.upsertSession({ sessionId: 'parent' });
    f.store.registerInternalSdkExecution({
      sdkSessionId: 'sdk',
      parentSessionId: 'parent',
      operationId: 'op',
      purpose: 'web_search',
      cwd: '/test/project',
    });
    const failures = [
      outcome(() =>
        f.store.createSessionWithRuntimeBinding({ ...bound, sessionId: 'legacy' }, binding),
      ),
      outcome(() =>
        f.store.createSessionWithRuntimeBinding({ ...bound, sessionId: 'historic' }, binding),
      ),
      outcome(() => f.store.incrementPromptCount('sdk')),
      outcome(() => f.store.upsertSession({ sessionId: 'sdk' })),
    ];
    expect(failures.every((x) => 'error' in x)).toBe(true);
    expect(f.store.getSession('sdk')).toBeNull();
    return failures;
  }));
it('preserves malformed account and fail-closed runtime reads', () =>
  parity((f) => {
    f.store.upsertSession({ sessionId: 'bad' });
    f.db.prepare("UPDATE sessions SET account_binding='bad-json' WHERE session_id='bad'").run();
    expect(f.store.getSession('bad')?.accountBinding?.provider).toBe('unavailable');
    f.store.createSessionWithRuntimeBinding(bound, binding);
    f.db.prepare("UPDATE sessions SET runtime_binding='bad-json' WHERE session_id='bound'").run();
    return [
      f.store.getSession('bad'),
      outcome(() => f.store.getSessionRuntimeBinding('bound')),
      outcome(() => f.store.upsertSession({ sessionId: 'bound', summary: 'refused' })),
    ];
  }));
it('filters registration and hidden rows before list/search limits', () =>
  parity((f) => {
    for (let i = 0; i < 12; i++) {
      const id = `row-${i}`;
      f.store.upsertSession({ sessionId: id, summary: 'searchable', updatedAt: i });
    }
    f.store.hideSession('row-11');
    f.db
      .prepare(
        "UPDATE sessions SET conversation_source='legacy',is_active=0 WHERE session_id='row-10'",
      )
      .run();
    expect(f.store.listSessions(1).map((x) => x.sessionId)).toEqual(['row-9']);
    expect(f.store.searchSessions('searchable', 1).map((x) => x.sessionId)).toEqual(['row-9']);
    return [f.store.listSessions(), f.store.searchSessions('searchable')];
  }));
it('escapes literal search wildcards and prefers message snippets over titles', () =>
  parity((f) => {
    f.store.upsertSession({ sessionId: 'one', summary: 'needle in title', updatedAt: 10 });
    f.store.append('one', 'user_message', { text: 'message needle and 100% _literal_ \\ path' });
    f.store.upsertSession({ sessionId: 'two', summary: 'no match', updatedAt: 20 });
    f.store.append('two', 'thinking_delta', { delta: 'needle hidden thinking' });
    expect(f.store.searchSessions('needle')).toHaveLength(1);
    expect(f.store.searchSessions('needle')[0].snippet).toContain('message needle');
    expect(f.store.searchSessions('   ')).toEqual([]);
    expect(f.store.searchSessions('%')).toHaveLength(1);
    expect(f.store.searchSessions('_literal_')).toHaveLength(1);
    return ['needle', '%', '_literal_', '\\'].map((x) => f.store.searchSessions(x));
  }));
it('batches known IDs past SQLite variable limits while preserving identity filters', () =>
  parity((f) => {
    const ids = Array.from({ length: 1201 }, (_, i) => `id-${i}`);
    for (const id of ids) f.store.upsertSession({ sessionId: id });
    f.store.hideSession(ids[0]);
    f.db
      .prepare("UPDATE sessions SET conversation_source='legacy',is_active=0 WHERE session_id=?")
      .run(ids[500]);
    expect(f.store.getKnownSessionIds([])).toEqual(new Set());
    const known = f.store.getKnownSessionIds([...ids, ids[1], 'absent']);
    expect(known.size).toBe(1200);
    expect(known.has(ids[0])).toBe(true);
    expect(known.has(ids[500])).toBe(false);
    return [...known];
  }));
it('preserves prompt, attention, rename and usage snapshots', () =>
  parity((f) => {
    expect(f.store.incrementPromptCount('one')).toBe(1);
    expect(f.store.incrementPromptCount('one')).toBe(2);
    f.store.markManuallyRenamed('one');
    f.store.updateLastSpeaker('one', 'assistant');
    const usage = {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      totalCostUsd: 0.1,
      numTurns: 1,
      durationMs: 50,
      durationApiMs: 60,
    };
    f.store.recordUsage('one', usage);
    f.store.recordUsage('one', usage);
    expect(f.store.getSession('one')).toMatchObject({
      manuallyRenamed: true,
      inputTokens: 10,
      numTurns: 1,
    });
    expect(f.store.getAttentionSessions()).toHaveLength(1);
    f.store.hideSession('one');
    expect(f.store.getAttentionSessions()).toEqual([]);
    f.store.markSessionInactive('one');
    return f.store.getSession('one');
  }));
it('retains runtime identity and metadata across database reopen', () =>
  parity((f) => {
    f.store.createSessionWithRuntimeBinding(bound, binding);
    f.store.incrementPromptCount('bound');
    f.store.hideSession('bound');
    f.reopen();
    expect(f.store.isSessionHidden('bound')).toBe(true);
    expect(f.store.getSessionRuntimeBinding('bound')).toEqual(binding);
    return f.store.getSession('bound');
  }, true));
it('keeps changes invisible to peer WAL readers until commit', () => {
  const f = fixture(false, true);
  f.store.upsertSession({ sessionId: 'one', summary: 'before' });
  const peer = new Sqlite(f.path);
  cleanups.push(() => peer.close());
  f.db.transaction(() => {
    f.store.upsertSession({ sessionId: 'one', summary: 'after' });
    expect(peer.prepare("SELECT summary FROM sessions WHERE session_id='one'").pluck().get()).toBe(
      'before',
    );
  })();
  expect(peer.prepare("SELECT summary FROM sessions WHERE session_id='one'").pluck().get()).toBe(
    'after',
  );
});

it('takes the runtime enrollment write lock before public upsert hooks run', () => {
  const f = fixture(false, true);
  const peer = new Sqlite(f.path, { timeout: 1 });
  cleanups.push(() => peer.close());
  const original = f.store.upsertSession.bind(f.store);
  let peerError: unknown;
  vi.spyOn(f.store, 'upsertSession').mockImplementation((meta) => {
    peerError = outcome(() =>
      peer.prepare("INSERT INTO sessions (session_id) VALUES ('competitor')").run(),
    );
    return original(meta);
  });
  f.store.createSessionWithRuntimeBinding(bound, binding);
  expect(peerError).toMatchObject({ error: { message: 'database is locked' } });
  expect(f.store.getSessionRuntimeBinding('bound')).toEqual(binding);
  expect(f.store.getSession('competitor')).toBeNull();
});

it('resolves the public internal-execution lookup at call time', () =>
  parity((f) => {
    f.store.upsertSession({ sessionId: 'one' });
    vi.spyOn(f.store, 'getInternalSdkExecution').mockReturnValue({
      sdkSessionId: 'one',
      parentSessionId: 'parent',
      operationId: 'op',
      purpose: 'web_search',
      cwd: '/test/project',
    });
    expect(f.store.getSession('one')).toBeNull();
    return outcome(() => f.store.incrementPromptCount('one'));
  }));
