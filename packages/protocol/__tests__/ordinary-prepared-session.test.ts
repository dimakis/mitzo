import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/event-store.js';
const binding = {
  version: 2,
  account: { accountId: 'account', provider: 'openai-codex', profileRevision: 'v1' },
  harness: { implementation: 'codex' },
  execution: { location: 'local', targetId: 'mac', targetRevision: 'v1' },
} as const;
const selection = {
  version: 1,
  agent: { profileId: 'agent', revision: 1 },
  context: { source: 'none', revision: null },
  permission: { mode: 'agent', revision: 0 },
  model: 'fixture',
  thinking: null,
} as const;
const meta = {
  sessionId: 'session',
  repositoryWorkspaceId: 'workspace',
  cwd: '/task',
  accountBinding: { ...binding.account, accountLabel: 'Fixture', model: 'fixture' },
  selectedModel: 'fixture',
  mode: 'agent' as const,
  reasoningEffort: null,
};
const preparation = {
  allocationOperationId: 'allocation',
  preparationFingerprint: 'a'.repeat(64),
  settings: { binding, selection, repositoryWorkspaceId: 'workspace' },
};
const command = {
  clientMsgId: 'prompt',
  requestFingerprint: 'prompt-fingerprint',
  selection,
  payload: { text: 'hello' },
};
const stores: EventStore[] = [];
const roots: string[] = [];
const open = (path = ':memory:') => {
  const store = new EventStore(path);
  stores.push(store);
  return store;
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('allocates durable distinct ordinary identity without a command, execution, or event through exact retries and restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'prepared-session-'));
  roots.push(root);
  const path = join(root, 'events.db');
  const first = open(path);
  const second = open(path);
  const receipt = first.prepareOrdinarySession(meta, preparation);
  expect(receipt).toMatchObject({
    allocationOperationId: 'allocation',
    sessionId: 'session',
    workspaceId: 'workspace',
    firstCommandId: null,
  });
  expect(second.prepareOrdinarySession(meta, preparation)).toEqual(receipt);
  expect(open(path).getOrdinarySessionPreparation('allocation')).toEqual(receipt);
  expect(first.getSessionRuntimeBinding('session')).toEqual(binding);
  expect(first.getOrdinaryInitialCommandId('session')).toBeUndefined();
  expect(first.getSendCommand('allocation')).toBeUndefined();
  expect(first.getEventsAfter('session', 0)).toEqual([]);
  expect(first.getExecutionAdmission('session', 'allocation')).toBeUndefined();
  expect(() => first.admitOrdinaryLocalCommand(meta, binding, command)).toThrow(/new session/i);
  expect(() => first.admitOrdinaryLocalContinuation(meta, binding, command)).toThrow();
});
it.each(['ask', 'agent', 'auto'] as const)(
  'refuses inherited permission revisions before allocating a fresh %s session',
  (mode) => {
    const store = open();
    const freshMeta = { ...meta, mode };
    const fresh = {
      ...preparation,
      settings: {
        ...preparation.settings,
        selection: { ...selection, permission: { mode, revision: 0 } },
      },
    };
    expect(() =>
      store.prepareOrdinarySession(freshMeta, {
        ...fresh,
        settings: {
          ...fresh.settings,
          selection: { ...fresh.settings.selection, permission: { mode, revision: 7 } },
        },
      }),
    ).toThrow(/fresh permission/i);
    expect(store.getSession(meta.sessionId)).toBeNull();
    expect(store.getSessionRuntimeBinding(meta.sessionId)).toBeUndefined();
    expect(store.getOrdinarySessionPreparation(preparation.allocationOperationId)).toBeUndefined();
    expect(store.getSendCommand(preparation.allocationOperationId)).toBeUndefined();
    expect(store.getEventsAfter(meta.sessionId, 0)).toEqual([]);
    const receipt = store.prepareOrdinarySession(freshMeta, fresh);
    expect(receipt.settings.selection.permission).toEqual({ mode, revision: 0 });
    expect(receipt.firstCommandId).toBeNull();
  },
);
it('explicit first command uses the prepared session once and retains uncertainty without fake continuation', () => {
  const store = open();
  store.prepareOrdinarySession(meta, preparation);
  expect(store.admitPreparedOrdinaryCommand('allocation', meta, binding, command).duplicate).toBe(
    false,
  );
  expect(store.getSendCommand('prompt')?.sessionId).toBe('session');
  expect(store.claimOrdinaryLocalCommandDispatch('prompt')).toBe(true);
  expect(store.admitPreparedOrdinaryCommand('allocation', meta, binding, command).duplicate).toBe(
    true,
  );
  expect(store.claimOrdinaryLocalCommandDispatch('prompt')).toBe(false);
  expect(store.getOrdinarySessionPreparation('allocation')?.firstCommandId).toBe('prompt');
  expect(() =>
    store.admitPreparedOrdinaryCommand('allocation', meta, binding, {
      ...command,
      clientMsgId: 'other',
    }),
  ).toThrow();
  expect(() =>
    store.admitPreparedOrdinaryCommand('allocation', meta, binding, {
      ...command,
      payload: { text: 'changed' },
    }),
  ).toThrow();
});
it('refuses drift, ordinary identity adoption, workspace/session aliasing, and queue-based harnesses', () => {
  const store = open();
  store.prepareOrdinarySession(meta, preparation);
  expect(() => store.prepareOrdinarySession({ ...meta, cwd: '/other' }, preparation)).toThrow();
  expect(() =>
    store.prepareOrdinarySession(meta, { ...preparation, allocationOperationId: 'other' }),
  ).toThrow();
  expect(() =>
    store.admitPreparedOrdinaryCommand('allocation', { ...meta, cwd: '/other' }, binding, command),
  ).toThrow();
  expect(() =>
    store.admitPreparedOrdinaryCommand('allocation', meta, binding, {
      ...command,
      selection: { ...selection, permission: { mode: 'auto', revision: 0 } },
    }),
  ).toThrow();
  expect(() =>
    store.prepareOrdinarySession({ ...meta, sessionId: 'workspace' }, preparation),
  ).toThrow();
  const legacy = { ...meta, sessionId: 'legacy', repositoryWorkspaceId: 'legacy-workspace' };
  store.upsertSession(legacy);
  expect(() =>
    store.prepareOrdinarySession(legacy, {
      ...preparation,
      allocationOperationId: 'legacy',
      settings: { ...preparation.settings, repositoryWorkspaceId: 'legacy-workspace' },
    }),
  ).toThrow();
  expect(() =>
    store.prepareOrdinarySession(
      { ...meta, sessionId: 'responses' },
      {
        ...preparation,
        allocationOperationId: 'responses',
        settings: {
          ...preparation.settings,
          binding: { ...binding, harness: { implementation: 'responses' } },
        },
      },
    ),
  ).toThrow();
});

it('serializes a first command across competing stores and reopens uncertainty without another send', () => {
  const root = mkdtempSync(join(tmpdir(), 'prepared-command-'));
  roots.push(root);
  const path = join(root, 'events.db');
  const first = open(path);
  const second = open(path);
  first.prepareOrdinarySession(meta, preparation);
  expect(first.admitPreparedOrdinaryCommand('allocation', meta, binding, command).duplicate).toBe(
    false,
  );
  expect(second.admitPreparedOrdinaryCommand('allocation', meta, binding, command).duplicate).toBe(
    true,
  );
  expect(first.claimOrdinaryLocalCommandDispatch('prompt')).toBe(true);
  const restored = open(path);
  expect(
    restored.admitPreparedOrdinaryCommand('allocation', meta, binding, command).duplicate,
  ).toBe(true);
  expect(restored.claimOrdinaryLocalCommandDispatch('prompt')).toBe(false);
  expect(() =>
    second.admitPreparedOrdinaryCommand('allocation', meta, binding, {
      ...command,
      clientMsgId: 'replacement',
    }),
  ).toThrow();
  expect(restored.getOrdinaryInitialCommandId('session')).toBe('prompt');
  expect(restored.getSendCommand('replacement')).toBeUndefined();
});
