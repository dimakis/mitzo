import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import { NativeResponsesStore } from '../native-responses-store.js';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
const account = {
  accountId: 'api',
  provider: 'openai' as const,
  profileRevision: 'profile',
  model: 'first',
  accountLabel: 'API',
};
const runtime = {
  version: 2 as const,
  account: { accountId: 'api', provider: 'openai' as const, profileRevision: 'profile' },
  harness: { implementation: 'responses' as const },
  execution: { location: 'local' as const, targetId: 'mac-api', targetRevision: 'route' },
};
const selection = {
  version: 1 as const,
  agent: { profileId: 'agent', revision: 1 },
  context: { source: 'none' as const, revision: null },
  permission: { mode: 'agent' as const, revision: 0 },
  model: 'first',
  thinking: 'low',
};
const meta = {
  sessionId: 'conversation',
  cwd: '/checkout',
  repositoryWorkspaceId: 'repo',
  accountBinding: account,
  mode: 'agent' as const,
};
const input = (id: string, model = 'first') => ({
  clientMsgId: id,
  requestFingerprint: `fingerprint-${id}`,
  selection: { ...selection, model },
  payload: { text: 'develop' },
});
it('uses the existing command ledger for Responses and keeps Codex receipts strict', () => {
  const events = new EventStore(':memory:');
  events.admitOrdinaryLocalResponsesCommand(meta, runtime, input('first'));
  expect(events.getOrdinaryLocalCommandAdmission('first')).toBeUndefined();
  expect(events.claimOrdinaryLocalResponsesCommandDispatch('first')).toBe(true);
  events.completeOrdinaryLocalResponsesCommand('first');
  const original = events.getSession(meta.sessionId);
  events.admitOrdinaryLocalResponsesContinuation(
    { ...meta, accountBinding: { ...account, model: 'next' } },
    runtime,
    input('next', 'next'),
  );
  expect(events.getSession(meta.sessionId)).toEqual(original);
  expect(events.getOrdinaryLocalResponsesCommandAdmission('next')?.selection.model).toBe('next');
  expect(() => events.admitOrdinaryLocalCommand(meta, runtime, input('wrong'))).toThrow();
  events.close();
});
it('retains exact signed custody and refuses adopting legacy history or changing operators', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-responses-custody-'));
  roots.push(root);
  const path = join(root, 'native.db');
  let store = new NativeResponsesStore(path);
  const custody = {
    version: 1 as const,
    authSessionId: 'signed-login',
    binding: runtime,
    workspace: { workspaceId: 'repo', cwd: '/checkout' },
  };
  store.setOrdinaryCustody('conversation', account, custody);
  store.begin('conversation', account);
  store.save('conversation', account, {
    status: 'idle',
    history: [{ role: 'user', content: 'retained edit' }],
  });
  store.close();
  store = new NativeResponsesStore(path);
  expect(store.readOrdinaryCustody('conversation', account)).toEqual(custody);
  expect(store.load('conversation', account)?.history[0].content).toBe('retained edit');
  expect(() =>
    store.setOrdinaryCustody('conversation', account, { ...custody, authSessionId: 'other' }),
  ).toThrow();
  store.begin('legacy', account);
  expect(() => store.setOrdinaryCustody('legacy', account, custody)).toThrow();
  store.close();
});
it('persists only FIFO identities and never claims an uncertain head or a second active command', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-responses-fifo-'));
  roots.push(root);
  const path = join(root, 'native.db');
  let store = new NativeResponsesStore(path);
  store.setOrdinaryCustody('conversation', account, {
    version: 1,
    authSessionId: 'signed-login',
    binding: runtime,
    workspace: { workspaceId: 'repo', cwd: '/checkout' },
  });
  store.enqueueCommand('conversation', account, 'first');
  store.enqueueCommand('conversation', account, 'future');
  expect(store.claimNextCommand('conversation', account, () => false)).toBeUndefined();
  expect(store.queue('conversation', account).queued).toEqual(['first', 'future']);
  expect(store.claimNextCommand('conversation', account, () => true)).toBe('first');
  expect(store.claimNextCommand('conversation', account, () => true)).toBeUndefined();
  store.finishCommand('conversation', account, 'first');
  store.close();
  store = new NativeResponsesStore(path);
  expect(store.queue('conversation', account)).toMatchObject({ queued: ['future'], active: null });
  expect(() => store.queue('conversation', { ...account, accountId: 'other' })).toThrow();
  expect(store.claimNextCommand('conversation', account, () => true)).toBe('future');
  expect(store.cancelQueuedCommand('conversation', account, 'future')).toBe('not_queued');
  store.finishCommand('conversation', account, 'future');
  store.close();
});

it('keeps SQLite in-memory storage free of literal filesystem artifacts', () => {
  expect(existsSync(':memory:')).toBe(false);
  const memory = new NativeResponsesStore(':memory:');
  memory.setOrdinaryCustody('memory', account, {
    version: 1,
    authSessionId: 'test-owner',
    binding: runtime,
    workspace: { workspaceId: 'repo', cwd: '/checkout' },
  });
  expect(memory.readOrdinaryCustody('memory', account)?.authSessionId).toBe('test-owner');
  memory.close();
  expect(existsSync(':memory:')).toBe(false);
});
