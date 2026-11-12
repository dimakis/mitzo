import { callbackOutcome, retainCallbackOutcome } from '../turn-callbacks.js';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { CodexSubagentStore } from '../codex-subagent-store.js';

const databases: Database.Database[] = [];
const scope = { conversationId: 'conversation', bindingRevision: 'account-revision' };
const child = {
  threadId: 'child',
  rootThreadId: 'parent',
  parentThreadId: 'parent',
  commandId: 'command',
  policyRevision: 'policy',
  name: 'Edge cases',
  task: 'Check empty queries',
  model: 'fixture',
  state: 'working' as const,
  turnId: 'child-turn',
  blocks: [],
  revision: 1,
};
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  return { db, store: new CodexSubagentStore(db) };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

it('retains child identity and output across store reconstruction without crossing accounts', () => {
  const { db, store } = fixture();
  store.save(scope, child);
  expect(new CodexSubagentStore(db).list(scope)).toEqual([child]);
  expect(store.list({ ...scope, bindingRevision: 'another-account' })).toEqual([]);
  expect(store.list({ ...scope, conversationId: 'another-conversation' })).toEqual([]);
  expect(() => store.save(scope, { ...child, parentThreadId: 'impostor' })).toThrow('identity');
});

it('claims a child tool once and fences its thread, turn, name and argument hash', () => {
  const { store } = fixture();
  store.save(scope, child);
  const call = {
    threadId: 'child',
    turnId: 'child-turn',
    callId: 'call',
    tool: 'Read',
    requestHash: 'hash',
  };
  expect(store.claimTool(scope, call)).toBe(true);
  expect(store.claimTool(scope, call)).toBe(false);
  expect(() => store.claimTool(scope, { ...call, turnId: 'successor' })).toThrow('identity');
  expect(() => store.claimTool(scope, { ...call, requestHash: 'different' })).toThrow('identity');
  expect(() => store.claimTool(scope, { ...call, threadId: 'other-child' })).toThrow();
});

it('replays a recorded tool result but never reexecutes an uncertain attempt', () => {
  const { store } = fixture();
  store.save(scope, child);
  const call = {
    threadId: 'child',
    turnId: 'child-turn',
    callId: 'call',
    tool: 'Read',
    requestHash: 'hash',
  };
  store.claimTool(scope, call);
  expect(store.toolResult(scope, call)).toBeUndefined();
  store.finishTool(scope, call, { content: 'verified result', isError: false });
  expect(store.toolResult(scope, call)).toEqual({ content: 'verified result', isError: false });
});

it('deduplicates control requests and rejects changed content under an existing request ID', () => {
  const { store } = fixture();
  store.save(scope, child);
  const input = {
    requestId: 'request',
    threadId: 'child',
    action: 'message' as const,
    text: 'Check whitespace',
  };
  expect(store.claimControl(scope, input)).toBeUndefined();
  expect(store.controlResult(scope, input)).toBe('uncertain');
  expect(store.claimControl(scope, input)).toBe('uncertain');
  store.finishControl(scope, input, 'accepted');
  expect(store.controlResult(scope, input)).toBe('accepted');
  expect(store.claimControl(scope, input)).toBe('accepted');
  expect(() => store.claimControl(scope, { ...input, text: 'changed' })).toThrow('identity');
});

it('keeps child discovery and uncertain control or tool receipts visible to deployment quiescence', () => {
  const { store } = fixture();
  store.save(scope, child);
  expect(store.unsettledConversationIds()).toEqual(['conversation']);
  store.save(scope, { ...child, state: 'completed', revision: 2 });
  expect(store.unsettledConversationIds()).toEqual([]);
  const control = {
    requestId: 'lost-control',
    threadId: child.threadId,
    action: 'message' as const,
    text: 'Continue',
  };
  store.claimControl(scope, control);
  expect(store.unsettledConversationIds()).toEqual(['conversation']);
  store.finishControl(scope, control, 'uncertain');
  expect(store.unsettledConversationIds()).toEqual(['conversation']);
});

it.each([
  ['returned failure', { content: 'failure', isError: true }, 'unknown'],
  [
    'explicit unknown success',
    retainCallbackOutcome({ content: 'returned', isError: false }, 'unknown'),
    'unknown',
  ],
  [
    'settled read failure',
    retainCallbackOutcome({ content: 'not found', isError: true }, 'settled'),
    'settled',
  ],
] as const)('retains child effect outcome across reconstruction: %s', (_label, result, outcome) => {
  const { db, store } = fixture();
  store.save(scope, { ...child, state: 'completed' });
  const call = {
    threadId: child.threadId,
    turnId: child.turnId,
    callId: 'original',
    tool: 'Read',
    requestHash: 'hash',
  };
  store.claimTool(scope, call);
  store.finishTool(scope, call, result);
  const reopened = new CodexSubagentStore(db, false);
  expect(callbackOutcome(reopened.toolResult(scope, call))).toBe(outcome);
  expect(reopened.unsettledConversationIds()).toEqual(
    outcome === 'settled' ? [] : ['conversation'],
  );
});

const originalCall = {
  threadId: child.threadId,
  turnId: child.turnId,
  callId: 'compatibility',
  tool: 'Read',
  requestHash: 'original-hash',
};
it('preserves the exact retained rollback writer and never retrofits outcome proof onto its result', () => {
  const { db, store } = fixture();
  store.save(scope, { ...child, state: 'completed' });
  expect(db.pragma('table_info(codex_subagent_effects)')).toHaveLength(5);
  // Exact SQL from the retained production release: no column names.
  db.prepare('INSERT OR IGNORE INTO codex_subagent_effects VALUES(?,?,?,?,NULL)').run(
    scope.conversationId,
    scope.bindingRevision,
    'tool:compatibility',
    JSON.stringify(originalCall),
  );
  const result = retainCallbackOutcome(
    { content: 'old returned value', isError: false },
    'settled',
  );
  db.prepare(
    'UPDATE codex_subagent_effects SET result=? WHERE conversation_id=? AND binding_revision=? AND effect_id=?',
  ).run(JSON.stringify(result), scope.conversationId, scope.bindingRevision, 'tool:compatibility');
  expect(callbackOutcome(store.toolResult(scope, originalCall))).toBe('unknown');
  expect(store.unsettledConversationIds()).toEqual(['conversation']);
  expect(() => store.finishTool(scope, originalCall, result)).toThrow('outcome changed');
  expect(db.prepare('SELECT count(*) AS n FROM codex_subagent_effect_outcomes').get()).toEqual({
    n: 0,
  });
});
it.each(['identity', 'result'] as const)(
  'rejects a stale sidecar after original %s bytes change',
  (field) => {
    const { db, store } = fixture();
    store.save(scope, { ...child, state: 'completed' });
    store.claimTool(scope, originalCall);
    const result = retainCallbackOutcome({ content: 'original result', isError: false }, 'settled');
    store.finishTool(scope, originalCall, result);
    store.finishTool(scope, originalCall, result); // Matching proof is idempotent.
    expect(store.unsettledConversationIds()).toEqual([]);
    const call = field === 'identity' ? { ...originalCall, requestHash: 'changed' } : originalCall;
    const value = field === 'identity' ? call : { content: 'changed result', isError: false };
    db.prepare(`UPDATE codex_subagent_effects SET ${field}=?`).run(JSON.stringify(value));
    const reopened = new CodexSubagentStore(db, false);
    expect(callbackOutcome(reopened.toolResult(scope, call))).toBe('unknown');
    expect(reopened.unsettledConversationIds()).toEqual(['conversation']);
    expect(() =>
      reopened.finishTool(
        scope,
        call,
        retainCallbackOutcome({ content: 'changed result', isError: false }, 'settled'),
      ),
    ).toThrow('outcome changed');
  },
);
it('reads a legacy database without creating missing proof or changing its schema', () => {
  const { db, store } = fixture();
  store.save(scope, { ...child, state: 'completed' });
  store.claimTool(scope, originalCall);
  db.prepare('UPDATE codex_subagent_effects SET result=?').run(
    JSON.stringify({ content: 'legacy', isError: false }),
  );
  db.exec('DROP TABLE codex_subagent_effect_outcomes');
  const schema = db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
  db.pragma('query_only=ON');
  const readonly = new CodexSubagentStore(db, false);
  expect(callbackOutcome(readonly.toolResult(scope, originalCall))).toBe('unknown');
  expect(readonly.unsettledConversationIds()).toEqual(['conversation']);
  expect(db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
});
it('commits original result and bound proof atomically', () => {
  const { db, store } = fixture();
  store.save(scope, { ...child, state: 'completed' });
  store.claimTool(scope, originalCall);
  db.exec(
    "CREATE TRIGGER reject_proof BEFORE INSERT ON codex_subagent_effect_outcomes BEGIN SELECT RAISE(ABORT,'proof write failed'); END",
  );
  expect(() =>
    store.finishTool(scope, originalCall, { content: 'result', isError: false }),
  ).toThrow('proof write failed');
  expect(store.pendingTool(scope, originalCall)).toBe(true);
  expect(store.toolResult(scope, originalCall)).toBeUndefined();
});
