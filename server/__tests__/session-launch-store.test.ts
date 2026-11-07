import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionLaunchStore, publicSessionLaunchRecord } from '../session-launch-store.js';
import type { SessionLaunchConfig } from '@mitzo/protocol';

const roots: string[] = [];
const stores: SessionLaunchStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const config = {
  version: 1,
  runtime: {
    version: 1,
    account: { accountId: 'personal', model: 'fixture-model', reasoningEffort: 'high' },
    accountReference: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'v1' },
    agentProfile: { kind: 'builtin', profileId: 'default-mitzo', revision: 1 },
    execution: { location: 'local', targetId: 'mac' },
  },
  mode: 'agent',
  isolation: true,
  repositoryWorkspaceId: null,
  contextBlocks: [],
  extraTools: [],
} as unknown as SessionLaunchConfig;
const proposal = {
  operatorId: 'operator',
  sourceSessionId: 'parent',
  requestId: '00000000-0000-4000-8000-000000000001',
  title: 'Approval notifications',
  prompt: 'Continue the reviewed work.',
  configuration: config,
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'session-launch-'));
  roots.push(root);
  const path = join(root, 'events.db');
  const store = new SessionLaunchStore(path);
  stores.push(store);
  return { store, path };
}
it('recovers exact requests and their parent links across controller restart', () => {
  const { store, path } = fixture();
  const first = store.propose(proposal);
  expect(first.state).toBe('pending');
  expect(first.childSessionId).toBeNull();
  const restarted = new SessionLaunchStore(path);
  stores.push(restarted);
  expect(restarted.propose(proposal)).toEqual(first);
  expect(restarted.forSession('parent', 'operator')).toEqual([first]);
  expect(restarted.forSession('parent', 'other')).toEqual([]);
  expect(() => restarted.get(first.proposalId, 'other')).toThrow(/not found/i);
  expect(() => restarted.propose({ ...proposal, prompt: 'Changed work' })).toThrow(/identity/i);
});
it('freezes user edits and every operation identity before preparation', () => {
  const { store } = fixture();
  const first = store.propose(proposal);
  const edited = {
    title: 'Reviewed title',
    prompt: 'Reviewed handoff',
    configuration: { ...config, mode: 'ask' as const },
  };
  const approved = store.approve(first.proposalId, 'operator', edited, first.revision);
  expect(approved).toMatchObject({ ...edited, state: 'starting', revision: first.revision + 1 });
  expect(approved.allocationId).toBeTruthy();
  expect(approved.commandId).toBeTruthy();
  expect(store.approve(first.proposalId, 'operator', edited, first.revision)).toEqual(approved);
  expect(() =>
    store.approve(
      first.proposalId,
      'operator',
      { ...edited, prompt: 'Changed after approval' },
      first.revision,
    ),
  ).toThrow(/approved|identity/i);
  const prepared = store.markPrepared(first.proposalId, 'child', 'preparation');
  expect(store.forSession('child', 'operator')).toEqual([prepared]);
  expect(() => store.markPrepared(first.proposalId, 'different-child', 'preparation')).toThrow(
    /identity/i,
  );
});
it('allows only pending cancellation and retains uncertain dispatch without retrying', () => {
  const { store } = fixture();
  const first = store.propose(proposal);
  const cancelled = store.cancel(first.proposalId, 'operator', first.revision);
  expect(cancelled.state).toBe('cancelled');
  expect(() => store.approve(first.proposalId, 'operator', proposal, cancelled.revision)).toThrow(
    /cancelled/i,
  );
  const second = store.propose({ ...proposal, requestId: '00000000-0000-4000-8000-000000000002' });
  store.approve(second.proposalId, 'operator', proposal, second.revision);
  store.markPrepared(second.proposalId, 'child', 'preparation');
  const uncertain = store.fail(second.proposalId, 'Dispatch acknowledgement lost', true);
  expect(uncertain.state).toBe('uncertain');
  expect(store.propose({ ...proposal, requestId: '00000000-0000-4000-8000-000000000002' })).toEqual(
    uncertain,
  );
  expect(() => store.cancel(second.proposalId, 'operator', uncertain.revision)).toThrow(/pending/i);
});
it('retains the original default snapshot across retries and rejects changed original input', () => {
  const { store } = fixture();
  const originalInput = {
    requestId: proposal.requestId,
    title: proposal.title,
    prompt: proposal.prompt,
  };
  const first = store.propose({ ...proposal, originalInput });
  expect(
    store.propose({ ...proposal, configuration: { ...config, mode: 'ask' }, originalInput }),
  ).toEqual(first);
  expect(() =>
    store.propose({
      ...proposal,
      originalInput: { ...originalInput, prompt: 'Different instruction' },
    }),
  ).toThrow(/identity/i);
  expect(store.forRequest('parent', 'operator', proposal.requestId)).toEqual(first);
  expect(publicSessionLaunchRecord(first)).not.toHaveProperty('commandId');
  expect(publicSessionLaunchRecord(first)).not.toHaveProperty('allocationId');
});
it('applies a default change once in the approval transaction and refuses stale approval effects', () => {
  const { store } = fixture();
  const first = store.propose(proposal);
  let calls = 0;
  const callback = (database: import('better-sqlite3').Database) => {
    calls++;
    database.exec('CREATE TABLE IF NOT EXISTS approval_fixture (value TEXT)');
    database.prepare('INSERT INTO approval_fixture VALUES (?)').run('saved');
  };
  const edits = { title: first.title, prompt: first.prompt, configuration: first.configuration };
  expect(() =>
    store.approve(first.proposalId, 'operator', edits, first.revision + 1, callback),
  ).toThrow(/revision/i);
  expect(calls).toBe(0);
  const approved = store.approve(first.proposalId, 'operator', edits, first.revision, callback);
  expect(store.approve(first.proposalId, 'operator', edits, first.revision, callback)).toEqual(
    approved,
  );
  expect(calls).toBe(1);
});
it('rolls approval and default writes back together when the atomic effect fails', () => {
  const { store } = fixture();
  const first = store.propose(proposal);
  const edits = { title: first.title, prompt: first.prompt, configuration: first.configuration };
  expect(() =>
    store.approve(first.proposalId, 'operator', edits, first.revision, (database) => {
      database.exec('CREATE TABLE approval_rollback_fixture (value TEXT)');
      throw Error('Default revision changed');
    }),
  ).toThrow('Default revision changed');
  expect(store.get(first.proposalId, 'operator')).toEqual(first);
  store.approve(first.proposalId, 'operator', edits, first.revision, (database) => {
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE name='approval_rollback_fixture'")
        .get(),
    ).toBeUndefined();
  });
});
