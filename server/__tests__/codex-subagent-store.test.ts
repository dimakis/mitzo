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
