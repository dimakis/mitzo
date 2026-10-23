import { afterEach, expect, it } from 'vitest';
import { EventStore } from '../src/event-store.js';
const binding = {
  version: 2,
  account: { accountId: 'account', provider: 'openai-codex', profileRevision: 'profile' },
  harness: { implementation: 'codex' },
  execution: { location: 'local', targetId: 'mac', targetRevision: 'target' },
} as const;
const meta = {
  sessionId: 'session',
  repositoryWorkspaceId: 'old',
  cwd: '/old',
  accountBinding: { ...binding.account, accountLabel: 'Offline', model: 'fixture' },
};
const selection = {
  version: 1,
  agent: { profileId: 'agent', revision: 1 },
  context: { source: 'none', revision: null },
  permission: { mode: 'agent', revision: 0 },
  model: 'fixture',
  thinking: null,
} as const;
const original = {
  clientMsgId: 'original',
  requestFingerprint: 'original-fingerprint',
  selection,
  payload: {
    text: 'Original user request',
    intent: 'Original authorized task',
    systemPrompt: 'Selected instructions',
  },
};
const transition = {
  version: 1 as const,
  preparationId: '34af2bdf-5fb4-4de0-b083-cf188163d891',
  runtimeId: 'runtime',
  source: {
    commandId: 'original',
    attempt: 1,
    threadId: 'thread',
    turnId: 'turn',
    generation: 0,
    callId: 'prepare',
    requestHash: 'a'.repeat(64),
    resultSha256: 'b'.repeat(64),
  },
  oldWorkspace: { kind: 'repository' as const, id: 'old', directory: '/old' },
  newWorkspace: {
    kind: 'repository' as const,
    id: 'new',
    directory: '/new',
    featureBranch: 'task/branch',
    baseOid: 'c'.repeat(40),
    taskIdentitySha256: 'd'.repeat(64),
  },
  consumedScopeSha256: 'e'.repeat(64),
  materializedRecordSha256: 'f'.repeat(64),
};
const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  const store = new EventStore(':memory:');
  stores.push(store);
  store.admitOrdinaryLocalCommand(meta, binding, original);
  store.claimOrdinaryLocalCommandDispatch('original');
  store.completeOrdinaryLocalCommand('original');
  return store;
}
it('reserves one deterministic uncertain child before mutation and atomically commits only its exact old→new primary', () => {
  const store = fixture();
  const before = store.getOrdinaryLocalCommandAdmission('original');
  const reserved = store.reservePreparedRepositoryContinuation('session', transition);
  expect(reserved.fresh).toBe(true);
  expect(reserved.admission.state).toBe('uncertain');
  expect(store.getSession('session')?.cwd).toBe('/old');
  expect(store.hasUncertainOrdinaryCommand('session')).toBe(true);
  expect(store.reservePreparedRepositoryContinuation('session', transition)).toMatchObject({
    fresh: false,
    childCommandId: reserved.childCommandId,
  });
  expect(reserved.payload).toMatchObject({
    intent: 'Original authorized task',
    systemPrompt: 'Selected instructions',
  });
  expect(reserved.payload.text).not.toBe(original.payload.text);
  expect(() => store.getOrdinaryLocalCommandAdmission(reserved.childCommandId)).toThrow();
  store.commitPreparedRepositoryContinuation('session', reserved.childCommandId, transition);
  expect(store.getSession('session')).toMatchObject({
    repositoryWorkspaceId: 'new',
    cwd: '/new',
    accountBinding: meta.accountBinding,
  });
  expect(store.getSession('session')?.ordinaryWorkspaceId).toBeUndefined();
  expect(store.getOrdinaryLocalCommandAdmission(reserved.childCommandId)).toMatchObject({
    state: 'consumed',
    preparedRepositoryTransition: transition,
  });
  expect(store.getPreparedRepositorySourceAdmission(reserved.childCommandId)).toEqual(before);
  expect(store.getSendCommand('original')?.payload).toEqual(original.payload);
  expect(store.claimOrdinaryLocalCommandDispatch(reserved.childCommandId)).toBe(false);
  expect(() =>
    store.commitPreparedRepositoryContinuation('session', reserved.childCommandId, transition),
  ).toThrow();
});

it('leaves an incomplete transition uncertain and prevents a second operation or changed proof', () => {
  const store = fixture();
  const reserved = store.reservePreparedRepositoryContinuation('session', transition);
  expect(store.getSession('session')?.cwd).toBe('/old');
  expect(() =>
    store.reservePreparedRepositoryContinuation('session', {
      ...transition,
      preparationId: '8f1aa667-2770-40d7-baa7-f192a322bd9d',
    }),
  ).toThrow();
  expect(() =>
    store.commitPreparedRepositoryContinuation('session', reserved.childCommandId, {
      ...transition,
      resultSha256: '0'.repeat(64),
    }),
  ).toThrow();
  expect(store.hasUncertainOrdinaryCommand('session')).toBe(true);
  expect(store.getSession('session')?.cwd).toBe('/old');
});

it('does not weaken the generic ordinary workspace equality or admit a legacy route', () => {
  const store = fixture();
  expect(() =>
    store.admitOrdinaryLocalContinuation(
      { ...meta, cwd: '/new', repositoryWorkspaceId: 'new' },
      binding,
      { ...original, clientMsgId: 'other', requestFingerprint: 'other' },
    ),
  ).toThrow();
  expect(() =>
    store.reservePreparedRepositoryContinuation('session', {
      ...transition,
      oldWorkspace: { ...transition.oldWorkspace, directory: '/forged' },
    }),
  ).toThrow();
  expect(() => store.reservePreparedRepositoryContinuation('missing', transition)).toThrow();
  expect(store.hasUncertainOrdinaryCommand('session')).toBe(false);
});

it('retains operation uncertainty after metadata commit if native enqueue cannot complete', () => {
  const store = fixture();
  const reserved = store.reservePreparedRepositoryContinuation('session', transition);
  store.commitPreparedRepositoryContinuation('session', reserved.childCommandId, transition);
  store.markPreparedRepositoryContinuationUncertain(reserved.childCommandId);
  expect(store.getOrdinaryLocalCommandAdmission(reserved.childCommandId)?.state).toBe('uncertain');
  expect(store.hasUncertainOrdinaryCommand('session')).toBe(true);
  expect(store.claimOrdinaryLocalCommandDispatch(reserved.childCommandId)).toBe(false);
  expect(() =>
    store.admitPreparedRepositoryPrimaryContinuation(
      { ...meta, cwd: '/new', repositoryWorkspaceId: 'new' },
      binding,
      { ...original, clientMsgId: 'later', requestFingerprint: 'later' },
      reserved.childCommandId,
    ),
  ).toThrow();
});
