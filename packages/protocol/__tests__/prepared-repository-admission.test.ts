import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/event-store.js';
import { OrdinaryLocalResponsesCommandAdmissionSchema } from '../src/ordinary-local-admission.js';
import { OrdinaryOpenShellCommandAdmissionSchema } from '../src/ordinary-openshell-admission.js';
import { OrdinaryLocalVertexCommandAdmissionSchema } from '../src/ordinary-local-vertex-admission.js';
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
const roots: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(path = ':memory:') {
  const store = new EventStore(path);
  stores.push(store);
  store.admitOrdinaryLocalCommand(meta, binding, original);
  store.claimOrdinaryLocalCommandDispatch('original');
  store.completeOrdinaryLocalCommand('original');
  return store;
}
it.each([false, true])(
  'does not reuse pre-transition prompt context for a prepared repository child (reserved: %s)',
  (reservedBeforeHold) => {
    const store = fixture();
    const child = reservedBeforeHold
      ? store.reservePreparedRepositoryContinuation('session', transition)
      : undefined;
    if (child)
      store.suspendUntransferredPreparedRepositoryContinuation(
        'session',
        transition.source,
        transition.oldWorkspace,
        transition.preparationId,
      );
    const originalReceipt = store.getOrdinaryLocalCommandAdmission('original');
    const childReceipt = child && store.getSendCommand(child.childCommandId);
    const handover = {
      sessionId: 'session',
      operationId: 'role-handover',
      fingerprint: 'a'.repeat(64),
      expectedEpoch: 0,
    };
    store.contextTransitions.begin(handover);
    expect(() => store.reservePreparedRepositoryContinuation('session', transition)).toThrow(
      /transition/i,
    );
    store.contextTransitions.release(handover, 'aborted', () => undefined);
    expect(() => store.reservePreparedRepositoryContinuation('session', transition)).toThrow(
      /stale/i,
    );
    expect(store.getOrdinaryLocalCommandAdmission('original')).toEqual(originalReceipt);
    if (child) expect(store.getSendCommand(child.childCommandId)).toEqual(childReceipt);
    expect(store.getSession('session')?.cwd).toBe('/old');
  },
);
it('reserves one deterministic uncertain child before mutation and atomically commits only its exact old→new primary', () => {
  const store = fixture();
  const before = store.getOrdinaryLocalCommandAdmission('original');
  const reserved = store.reservePreparedRepositoryContinuation('session', transition);
  expect(reserved.fresh).toBe(true);
  expect(reserved.admission.state).toBe('uncertain');
  expect(
    store.observePreparedRepositoryBootstrapAdmission(reserved.childCommandId, 'original'),
  ).toEqual(before);
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
  expect(
    store.observePreparedRepositoryBootstrapAdmission(reserved.childCommandId, 'original'),
  ).toEqual(before);
  expect(store.getOrdinaryLocalCommandAdmission(reserved.childCommandId)?.state).toBe('uncertain');
  store.finalizePreparedRepositoryContinuation(
    'session',
    reserved.childCommandId,
    transition,
    () => {},
  );
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

it('inherits the actual source epoch while preserving an older prepared primary as workspace lineage', () => {
  const store = fixture();
  const primary = store.reservePreparedRepositoryContinuation('session', transition);
  store.commitPreparedRepositoryContinuation('session', primary.childCommandId, transition);
  store.finalizePreparedRepositoryContinuation(
    'session',
    primary.childCommandId,
    transition,
    () => {},
  );
  const handover = {
    sessionId: 'session',
    operationId: 'context-change',
    fingerprint: 'a'.repeat(64),
    expectedEpoch: 0,
  };
  store.contextTransitions.begin(handover);
  store.contextTransitions.release(handover, 'aborted', () => undefined);
  const nextMeta = { ...meta, repositoryWorkspaceId: 'new', cwd: '/new' };
  store.withOrdinaryContextAdmission('session', 1, () =>
    store.admitPreparedRepositoryPrimaryContinuation(
      nextMeta,
      binding,
      { ...original, clientMsgId: 'source1', requestFingerprint: 'source1' },
      primary.childCommandId,
    ),
  );
  store.claimOrdinaryLocalCommandDispatch('source1');
  store.completeOrdinaryLocalCommand('source1');
  store.withOrdinaryDerivedCommandContext('session', 'source1', () =>
    store.admitPreparedRepositoryPrimaryContinuation(
      nextMeta,
      binding,
      { ...original, clientMsgId: 'derived1', requestFingerprint: 'derived1' },
      primary.childCommandId,
    ),
  );
  expect(store.contextTransitions.readCommand(primary.childCommandId)?.epoch).toBe(0);
  expect(store.contextTransitions.readCommand('derived1')?.epoch).toBe(1);
  expect(
    store.getOrdinaryLocalCommandExecutionAdmission('derived1')?.preparedRepositoryPrimaryCommandId,
  ).toBe(primary.childCommandId);
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
      source: { ...transition.source, resultSha256: '0'.repeat(64) },
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

it('retains durable uncertainty across process death after metadata commit without a catch/finally repair', () => {
  const root = mkdtempSync(join(tmpdir(), 'prepared-primary-cold-'));
  roots.push(root);
  const path = join(root, 'events.db');
  const first = fixture(path);
  const reserved = first.reservePreparedRepositoryContinuation('session', transition);
  first.commitPreparedRepositoryContinuation('session', reserved.childCommandId, transition);
  const cold = new EventStore(path);
  stores.push(cold);
  expect(cold.getSession('session')?.cwd).toBe('/new');
  expect(cold.getOrdinaryLocalCommandAdmission(reserved.childCommandId)?.state).toBe('uncertain');
  expect(cold.claimOrdinaryLocalCommandDispatch(reserved.childCommandId)).toBe(false);
  expect(() => cold.completeOrdinaryLocalCommand(reserved.childCommandId)).toThrow();
  expect(cold.getOrdinaryLocalCommandAdmission(reserved.childCommandId)?.state).toBe('uncertain');
  expect(cold.hasUncertainOrdinaryCommand('session')).toBe(true);
  expect(() =>
    cold.admitPreparedRepositoryPrimaryContinuation(
      { ...meta, cwd: '/new', repositoryWorkspaceId: 'new' },
      binding,
      { ...original, clientMsgId: 'cold-followup', requestFingerprint: 'cold-followup' },
      reserved.childCommandId,
    ),
  ).toThrow();
  expect(cold.getSendCommand('cold-followup')).toBeUndefined();
  expect(cold.getSendCommand('original')?.payload).toEqual(original.payload);
});

it('preserves pending draft settings and rebound execution settings across database reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'prepared-settings-cold-'));
  roots.push(root);
  const path = join(root, 'events.db');
  const first = fixture(path);
  first.append('session', 'user_message', { messageId: 'original', text: original.payload.text });
  first.append('session', 'message_start', { messageId: 'retained-reply' });
  const history = first.getSessionEvents('session');
  const previous = first.getOrdinaryConversationSettings('session');
  const origin = first.getOrdinaryLocalCommandAdmission('original');
  const reserved = first.reservePreparedRepositoryContinuation('session', transition);
  first.close();
  const cold = new EventStore(path);
  stores.push(cold);
  expect(cold.getOrdinaryConversationSettings('session')).toEqual(previous);
  expect(cold.getLatestOrdinaryCommandAdmission('session')).toEqual(origin);
  expect(cold.getSessionEvents('session')).toEqual(history);
  expect(() => cold.getOrdinaryLocalCommandAdmission(reserved.childCommandId)).toThrow();
  expect(cold.claimOrdinaryLocalCommandDispatch('original')).toBe(false);
  expect(cold.hasUncertainOrdinaryCommand('session')).toBe(true);
  cold.suspendUntransferredPreparedRepositoryContinuation(
    'session',
    transition.source,
    transition.oldWorkspace,
    transition.preparationId,
  );
  const resume = {
    ...original,
    clientMsgId: 'durable-resume',
    requestFingerprint: 'durable-resume',
  };
  cold.admitOrdinaryLocalContinuation(meta, binding, resume);
  cold.claimOrdinaryLocalCommandDispatch(resume.clientMsgId);
  cold.completeOrdinaryLocalCommand(resume.clientMsgId);
  const originalResume = cold.getOrdinaryLocalCommandAdmission(resume.clientMsgId);
  cold.reservePreparedRepositoryContinuation('session', transition);
  cold.commitPreparedRepositoryContinuation('session', reserved.childCommandId, transition);
  cold.rebindPreparedRepositoryQueuedCommands('session', reserved.childCommandId, transition, [
    resume.clientMsgId,
  ]);
  const execution = cold.getOrdinaryCommandExecutionAdmission(resume.clientMsgId);
  cold.close();
  const reopened = new EventStore(path);
  stores.push(reopened);
  expect(reopened.getLatestOrdinaryCommandAdmission('session')).toEqual(execution);
  expect(
    reopened.getPreparedRepositoryCommandAdmissionEvidence(
      resume.clientMsgId,
      reserved.childCommandId,
    ),
  ).toEqual(originalResume);
  expect(reopened.getSendCommand(resume.clientMsgId)?.payload).toEqual(resume.payload);
  expect(reopened.getSessionEvents('session')).toEqual(history);
  expect(reopened.hasUncertainOrdinaryCommand('session')).toBe(true);
  expect(reopened.claimOrdinaryLocalCommandDispatch(reserved.childCommandId)).toBe(false);
});

it('observes the same immutable bootstrap across two private adoptions separated by an explicit follow-up', () => {
  const store = fixture();
  const origin = store.getOrdinaryLocalCommandAdmission('original');
  const first = store.reservePreparedRepositoryContinuation('session', transition);
  store.commitPreparedRepositoryContinuation('session', first.childCommandId, transition);
  store.finalizePreparedRepositoryContinuation(
    'session',
    first.childCommandId,
    transition,
    () => {},
  );
  const nextMeta = { ...meta, repositoryWorkspaceId: 'new', cwd: '/new' };
  store.admitPreparedRepositoryPrimaryContinuation(
    nextMeta,
    binding,
    {
      ...original,
      clientMsgId: 'followup',
      requestFingerprint: 'followup-fingerprint',
      payload: {
        text: 'Prepare the second repository',
        intent: 'Second explicit task',
        systemPrompt: 'Selected instructions',
      },
    },
    first.childCommandId,
  );
  expect(
    store.getOrdinaryLocalCommandAdmission('followup')?.preparedRepositoryPrimaryCommandId,
  ).toBe(first.childCommandId);
  expect(store.claimOrdinaryLocalCommandDispatch('followup')).toBe(true);
  store.completeOrdinaryLocalCommand('followup');
  const secondTransition = {
    priorPrimaryCommandId: undefined as string | undefined,
    ...transition,
    preparationId: '3dbdc62d-20ab-4144-b210-c55bc7f39cda',
    source: {
      ...transition.source,
      commandId: 'followup',
      turnId: 'second-turn',
      callId: 'second-prepare',
    },
    oldWorkspace: { kind: 'repository' as const, id: 'new', directory: '/new' },
    newWorkspace: { ...transition.newWorkspace, id: 'old', directory: '/old' },
  };
  expect(() => store.reservePreparedRepositoryContinuation('session', secondTransition)).toThrow();
  expect(() =>
    store.reservePreparedRepositoryContinuation('session', {
      ...secondTransition,
      priorPrimaryCommandId: 'original',
    }),
  ).toThrow();
  const second = store.reservePreparedRepositoryContinuation('session', {
    ...secondTransition,
    priorPrimaryCommandId: first.childCommandId,
  });
  secondTransition.priorPrimaryCommandId = first.childCommandId;
  expect(
    store.observePreparedRepositoryBootstrapAdmission(second.childCommandId, 'original'),
  ).toEqual(origin);
  store.commitPreparedRepositoryContinuation('session', second.childCommandId, secondTransition);
  expect(
    store.observePreparedRepositoryBootstrapAdmission(second.childCommandId, 'original'),
  ).toEqual(origin);
  store.finalizePreparedRepositoryContinuation(
    'session',
    second.childCommandId,
    secondTransition,
    () => {},
  );
  expect(
    store.observePreparedRepositoryBootstrapAdmission(second.childCommandId, 'original'),
  ).toEqual(origin);
  // Returning to the exact original workspace does not rewrite its historical receipt.
  expect(store.getOrdinaryLocalCommandAdmission('original')).toEqual(origin);
  let primaryCommandId = second.childCommandId;
  let currentId = 'old',
    currentDirectory = '/old';
  for (const [index, nextId, nextDirectory] of [
    [3, 'new', '/new'],
    [4, 'old', '/old'],
  ] as const) {
    const followup = `followup-${index}`;
    store.admitPreparedRepositoryPrimaryContinuation(
      { ...meta, repositoryWorkspaceId: currentId, cwd: currentDirectory },
      binding,
      {
        ...original,
        clientMsgId: followup,
        requestFingerprint: followup,
        payload: { ...original.payload, text: `Explicit revisit ${index}` },
      },
      primaryCommandId,
    );
    store.claimOrdinaryLocalCommandDispatch(followup);
    store.completeOrdinaryLocalCommand(followup);
    const revisit = {
      ...transition,
      priorPrimaryCommandId: primaryCommandId,
      preparationId:
        index === 3
          ? '48345612-504a-4158-ae53-531484ec0fb4'
          : '35922981-96d9-474e-a8ac-5f7b8307669c',
      source: {
        ...transition.source,
        commandId: followup,
        turnId: `turn-${index}`,
        callId: `prepare-${index}`,
      },
      oldWorkspace: { kind: 'repository' as const, id: currentId, directory: currentDirectory },
      newWorkspace: { ...transition.newWorkspace, id: nextId, directory: nextDirectory },
    };
    expect(() =>
      store.reservePreparedRepositoryContinuation('session', {
        ...revisit,
        priorPrimaryCommandId: first.childCommandId,
      }),
    ).toThrow();
    const reserved = store.reservePreparedRepositoryContinuation('session', revisit);
    store.commitPreparedRepositoryContinuation('session', reserved.childCommandId, revisit);
    store.finalizePreparedRepositoryContinuation(
      'session',
      reserved.childCommandId,
      revisit,
      () => {},
    );
    expect(
      store.observePreparedRepositoryBootstrapAdmission(reserved.childCommandId, 'original'),
    ).toEqual(origin);
    primaryCommandId = reserved.childCommandId;
    currentId = nextId;
    currentDirectory = nextDirectory;
  }
  const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
  const row = (id: string) =>
    (
      db.prepare('SELECT rowid FROM send_commands WHERE client_msg_id=?').get(id) as {
        rowid: number;
      }
    ).rowid;
  const parentOrder = row(first.childCommandId),
    sourceOrder = row('followup');
  db.prepare('UPDATE send_commands SET rowid=1000 WHERE client_msg_id=?').run(first.childCommandId);
  db.prepare('UPDATE send_commands SET rowid=? WHERE client_msg_id=?').run(parentOrder, 'followup');
  db.prepare('UPDATE send_commands SET rowid=? WHERE client_msg_id=?').run(
    sourceOrder,
    first.childCommandId,
  );
  // A later primary row cannot retroactively attest an already admitted source.
  expect(() =>
    store.observePreparedRepositoryBootstrapAdmission(second.childCommandId, 'original'),
  ).toThrow();
  db.prepare('UPDATE send_commands SET rowid=1000 WHERE client_msg_id=?').run(first.childCommandId);
  db.prepare('UPDATE send_commands SET rowid=? WHERE client_msg_id=?').run(sourceOrder, 'followup');
  db.prepare('UPDATE send_commands SET rowid=? WHERE client_msg_id=?').run(
    parentOrder,
    first.childCommandId,
  );
  store.markPreparedRepositoryContinuationUncertain(first.childCommandId);
  expect(() =>
    store.observePreparedRepositoryBootstrapAdmission(second.childCommandId, 'original'),
  ).toThrow();
});

it('keeps native primary receipt markers outside API, OpenShell and Vertex admissions', () => {
  const store = fixture();
  const source = store.getOrdinaryLocalCommandAdmission('original')!;
  expect(source.preparedRepositoryPrimaryCommandId).toBeUndefined();
  for (const [schema, provider, implementation, location, cwd] of [
    [OrdinaryLocalResponsesCommandAdmissionSchema, 'openai', 'responses', 'local', '/old'],
    [
      OrdinaryOpenShellCommandAdmissionSchema,
      'openai-codex',
      'codex',
      'openshell',
      '/sandbox/workspaces/offline',
    ],
    [OrdinaryLocalVertexCommandAdmissionSchema, 'anthropic-vertex', 'claude-sdk', 'local', '/old'],
  ] as const) {
    const input = {
      ...source,
      binding: {
        ...source.binding,
        account: { ...source.binding.account, provider },
        harness: { implementation },
        execution: { ...source.binding.execution, location },
      },
      workspace: { ...source.workspace, cwd },
    };
    expect(schema.safeParse(input).success).toBe(true);
    expect(
      schema.safeParse({ ...input, preparedRepositoryPrimaryCommandId: 'native-primary' }).success,
    ).toBe(false);
    expect(schema.safeParse({ ...input, preparedRepositoryTransition: transition }).success).toBe(
      false,
    );
  }
});

function coldPrimaryFixture() {
  const store = fixture();
  const primary = store.reservePreparedRepositoryContinuation('session', transition);
  store.commitPreparedRepositoryContinuation('session', primary.childCommandId, transition);
  store.finalizePreparedRepositoryContinuation(
    'session',
    primary.childCommandId,
    transition,
    () => {},
  );
  store.admitPreparedRepositoryPrimaryContinuation(
    { ...meta, repositoryWorkspaceId: 'new', cwd: '/new' },
    binding,
    { ...original, clientMsgId: 'cold', requestFingerprint: 'cold-fingerprint' },
    primary.childCommandId,
  );
  store.claimOrdinaryLocalCommandDispatch('cold');
  store.completeOrdinaryLocalCommand('cold');
  const next = {
    ...transition,
    preparationId: '3dbdc62d-20ab-4144-b210-c55bc7f39cda',
    priorPrimaryCommandId: primary.childCommandId,
    source: {
      ...transition.source,
      commandId: 'cold',
      turnId: 'cold-turn',
      callId: 'cold-prepare',
    },
    oldWorkspace: { kind: 'repository' as const, id: 'new', directory: '/new' },
    newWorkspace: { ...transition.newWorkspace, id: 'third', directory: '/third' },
  };
  const child = store.reservePreparedRepositoryContinuation('session', next);
  return { store, primary, child, next };
}
it('observes the exact fresh cold bootstrap across a later Prepare without weakening original-origin equality', () => {
  const { store, primary, child, next } = coldPrimaryFixture();
  const cold = store.getOrdinaryLocalCommandAdmission('cold');
  const observed = store.observePreparedRepositoryColdBootstrapAdmission(
    child.childCommandId,
    'cold',
    primary.childCommandId,
  );
  expect(observed).toEqual(cold);
  expect(Object.isFrozen(observed)).toBe(true);
  expect(Object.isFrozen(observed.workspace)).toBe(true);
  expect(() =>
    store.observePreparedRepositoryBootstrapAdmission(child.childCommandId, 'cold'),
  ).toThrow();
  store.commitPreparedRepositoryContinuation('session', child.childCommandId, next);
  store.finalizePreparedRepositoryContinuation('session', child.childCommandId, next, () => {});
  expect(
    store.observePreparedRepositoryColdBootstrapAdmission(
      child.childCommandId,
      'cold',
      primary.childCommandId,
    ),
  ).toEqual(cold);
  expect(() => store.getOrdinaryLocalCommandAdmission('original')).toThrow();
});
it.each([
  'anchor',
  'bootstrap',
  'uncertain-anchor',
  'uncertain-bootstrap',
  'session',
  'binding',
  'pointer',
  'order',
] as const)('refuses a changed %s in cold bootstrap observation', (change) => {
  const { store, primary, child } = coldPrimaryFixture();
  const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
  const update = (id: string, mutate: (value: Record<string, unknown>) => void) => {
    const row = db
      .prepare('SELECT ordinary_admission FROM send_commands WHERE client_msg_id=?')
      .get(id) as { ordinary_admission: string };
    const value = JSON.parse(row.ordinary_admission);
    mutate(value);
    db.prepare('UPDATE send_commands SET ordinary_admission=? WHERE client_msg_id=?').run(
      JSON.stringify(value),
      id,
    );
  };
  if (change === 'uncertain-anchor')
    update(primary.childCommandId, (a) => {
      a.state = 'uncertain';
    });
  if (change === 'uncertain-bootstrap')
    update('cold', (a) => {
      a.state = 'uncertain';
    });
  if (change === 'pointer')
    update('cold', (a) => {
      a.preparedRepositoryPrimaryCommandId = 'original';
    });
  if (change === 'binding')
    update('cold', (a) => {
      a.binding = { ...binding, account: { ...binding.account, accountId: 'other' } };
    });
  if (change === 'session')
    db.prepare('UPDATE send_commands SET session_id=? WHERE client_msg_id=?').run('other', 'cold');
  if (change === 'order')
    db.prepare('UPDATE send_commands SET rowid=1000 WHERE client_msg_id=?').run('cold');
  expect(() =>
    store.observePreparedRepositoryColdBootstrapAdmission(
      child.childCommandId,
      change === 'bootstrap' ? 'original' : 'cold',
      change === 'anchor' ? child.childCommandId : primary.childCommandId,
    ),
  ).toThrow();
});

it('appends a prepared-workspace execution admission while preserving explicit input and original admission evidence', () => {
  const store = fixture();
  const followup = {
    ...original,
    clientMsgId: 'followup',
    requestFingerprint: 'followup-fingerprint',
    selection: { ...selection, thinking: 'low' },
    payload: {
      ...original.payload,
      text: 'Stop the old task and explain the edits',
      intent: 'New explicit steering',
    },
  };
  store.admitOrdinaryLocalContinuation({ ...meta, reasoningEffort: 'low' }, binding, followup);
  store.claimOrdinaryLocalCommandDispatch(followup.clientMsgId);
  store.completeOrdinaryLocalCommand(followup.clientMsgId);
  const historical = store.getOrdinaryLocalCommandAdmission(followup.clientMsgId);
  const reserved = store.reservePreparedRepositoryContinuation('session', transition);
  store.commitPreparedRepositoryContinuation('session', reserved.childCommandId, transition);
  store.rebindPreparedRepositoryQueuedCommands('session', reserved.childCommandId, transition, [
    'followup',
  ]);
  expect(
    store.getPreparedRepositoryCommandAdmissionEvidence('followup', reserved.childCommandId),
  ).toEqual(historical);
  expect(store.getSendCommand('followup')?.payload).toEqual(followup.payload);
  expect(store.getOrdinaryLocalCommandExecutionAdmission('followup')).toMatchObject({
    state: 'consumed',
    workspace: { workspaceId: 'new', cwd: '/new' },
    selection: followup.selection,
    preparedRepositoryPrimaryCommandId: reserved.childCommandId,
  });
  expect(() =>
    store.rebindPreparedRepositoryQueuedCommands('session', reserved.childCommandId, transition, [
      'followup',
    ]),
  ).not.toThrow();
  expect(() =>
    store.rebindPreparedRepositoryQueuedCommands('session', reserved.childCommandId, transition, [
      'missing',
    ]),
  ).toThrow();
});

it('observes a resumed bootstrap when a later message prepares the first repository transfer', () => {
  const store = fixture();
  const followup = {
    ...original,
    clientMsgId: 'prepare-in-followup',
    requestFingerprint: 'followup-fingerprint',
    payload: { ...original.payload, text: 'Create the new project now' },
  };
  store.admitOrdinaryLocalContinuation(meta, binding, followup);
  store.claimOrdinaryLocalCommandDispatch(followup.clientMsgId);
  store.completeOrdinaryLocalCommand(followup.clientMsgId);
  const reserved = store.reservePreparedRepositoryContinuation('session', {
    ...transition,
    source: { ...transition.source, commandId: followup.clientMsgId },
  });
  expect(
    store.observePreparedRepositoryResumedBootstrapAdmission(
      reserved.childCommandId,
      original.clientMsgId,
    ),
  ).toEqual(store.getOrdinaryLocalCommandAdmission(original.clientMsgId));
  expect(store.getSession('session')?.cwd).toBe('/old');
  const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
  const bootstrap = store.getOrdinaryLocalCommandAdmission(original.clientMsgId)!;
  for (const invalid of [
    { ...bootstrap, state: 'uncertain' },
    { ...bootstrap, workspace: { workspaceId: 'other', cwd: '/other' } },
  ]) {
    db.prepare('UPDATE send_commands SET ordinary_admission=? WHERE client_msg_id=?').run(
      JSON.stringify(invalid),
      original.clientMsgId,
    );
    expect(() =>
      store.observePreparedRepositoryResumedBootstrapAdmission(
        reserved.childCommandId,
        original.clientMsgId,
      ),
    ).toThrow();
  }
});

it('observes a fresh cold bootstrap between the original prepared source and its later workspace transition', () => {
  const store = fixture();
  const initial = store.reservePreparedRepositoryContinuation('session', transition);
  expect(
    store.observeUntransferredPreparedRepositoryContinuation(
      'session',
      transition.source,
      transition.oldWorkspace,
      transition.preparationId,
    )?.childCommandId,
  ).toBe(initial.childCommandId);
  expect(store.observePreparedRepositoryContinuation(initial.childCommandId).state).toBe(
    'uncertain',
  );
  expect(() =>
    store.observeUntransferredPreparedRepositoryContinuation(
      'session',
      transition.source,
      transition.oldWorkspace,
      'foreign-preparation',
    ),
  ).toThrow();
  expect(() =>
    store.observeUntransferredPreparedRepositoryContinuation(
      'session',
      transition.source,
      { ...transition.oldWorkspace, id: 'foreign-workspace' },
      transition.preparationId,
    ),
  ).toThrow();
  const database = (store as unknown as { db: import('better-sqlite3').Database }).db;
  for (const id of [transition.source.commandId, initial.childCommandId]) {
    database
      .prepare('UPDATE send_commands SET error=? WHERE client_msg_id=?')
      .run('Retained failure', id);
    expect(() =>
      store.observeUntransferredPreparedRepositoryContinuation(
        'session',
        transition.source,
        transition.oldWorkspace,
        transition.preparationId,
      ),
    ).toThrow();
    database.prepare('UPDATE send_commands SET error=NULL WHERE client_msg_id=?').run(id);
  }
  store.admitOrdinaryLocalCommand({ ...meta, sessionId: 'foreign-session' }, binding, {
    ...original,
    clientMsgId: 'foreign-command',
    requestFingerprint: 'foreign-fingerprint',
  });
  database
    .prepare('UPDATE send_commands SET session_id=? WHERE client_msg_id=?')
    .run('foreign-session', transition.source.commandId);
  expect(() =>
    store.observeUntransferredPreparedRepositoryContinuation(
      'session',
      transition.source,
      transition.oldWorkspace,
      transition.preparationId,
    ),
  ).toThrow();
  database
    .prepare('UPDATE send_commands SET session_id=? WHERE client_msg_id=?')
    .run('session', transition.source.commandId);
  const retained = store.observePreparedRepositoryContinuation(initial.childCommandId);
  database
    .prepare('UPDATE send_commands SET ordinary_admission=? WHERE client_msg_id=?')
    .run(
      JSON.stringify({ ...retained, selection: { ...retained.selection, model: 'changed-model' } }),
      initial.childCommandId,
    );
  expect(() =>
    store.observeUntransferredPreparedRepositoryContinuation(
      'session',
      transition.source,
      transition.oldWorkspace,
      transition.preparationId,
    ),
  ).toThrow();
  database
    .prepare('UPDATE send_commands SET ordinary_admission=? WHERE client_msg_id=?')
    .run(JSON.stringify(retained), initial.childCommandId);
  const startupError =
    'Recovery required: historical command workspace differs from the current conversation. Original uncertain admission retained; do not replay before reconciliation.';
  store.failSendCommand(initial.childCommandId, startupError);
  store.failSendCommand(transition.source.commandId, startupError);
  expect(() =>
    store.observeUntransferredPreparedRepositoryContinuation(
      'session',
      transition.source,
      transition.oldWorkspace,
      transition.preparationId,
    ),
  ).toThrow();
  database
    .prepare('UPDATE send_commands SET error=NULL WHERE client_msg_id=?')
    .run(transition.source.commandId);
  expect(
    store.observeUntransferredPreparedRepositoryContinuation(
      'session',
      transition.source,
      transition.oldWorkspace,
      transition.preparationId,
    )?.childCommandId,
  ).toBe(initial.childCommandId);
  expect(store.getSendCommand(initial.childCommandId)?.error).toBe(startupError);
  database
    .prepare('UPDATE send_commands SET ordinary_admission=? WHERE client_msg_id=?')
    .run(JSON.stringify({ ...retained, state: 'reserved' }), initial.childCommandId);
  expect(() =>
    store.suspendUntransferredPreparedRepositoryContinuation(
      'session',
      transition.source,
      transition.oldWorkspace,
      transition.preparationId,
    ),
  ).toThrow();
  expect(store.getSendCommand(initial.childCommandId)?.error).toBe(startupError);
  expect(store.getEventsOfType('session', 'command_preparation_recovered')).toEqual([]);
  database
    .prepare('UPDATE send_commands SET ordinary_admission=? WHERE client_msg_id=?')
    .run(JSON.stringify(retained), initial.childCommandId);
  for (let repeat = 0; repeat < 2; repeat++)
    store.suspendUntransferredPreparedRepositoryContinuation(
      'session',
      transition.source,
      transition.oldWorkspace,
      transition.preparationId,
    );
  expect(store.getSendCommand(initial.childCommandId)?.error).toBeNull();
  expect(
    store.getEventsOfType('session', 'command_preparation_recovered').map((e) => e.payload),
  ).toEqual([
    {
      commandId: initial.childCommandId,
      preparationId: transition.preparationId,
      sourceCommandId: transition.source.commandId,
      reason: 'untransferred_prepared_repository',
      previousError: startupError,
    },
  ]);
  const resume = {
    ...original,
    clientMsgId: 'fresh-resume',
    requestFingerprint: 'resume-fingerprint',
    payload: { ...original.payload, text: 'Resume this retained task' },
  };
  store.admitOrdinaryLocalContinuation(meta, binding, resume);
  store.claimOrdinaryLocalCommandDispatch(resume.clientMsgId);
  store.completeOrdinaryLocalCommand(resume.clientMsgId);
  const expected = store.getOrdinaryLocalCommandAdmission(resume.clientMsgId);
  const reserved = store.reservePreparedRepositoryContinuation('session', transition);
  expect(reserved.childCommandId).toBe(initial.childCommandId);
  expect(
    store.observePreparedRepositoryResumedBootstrapAdmission(
      reserved.childCommandId,
      resume.clientMsgId,
    ),
  ).toEqual(expected);
  expect(() =>
    store.observePreparedRepositoryBootstrapAdmission(reserved.childCommandId, resume.clientMsgId),
  ).toThrow();
  store.commitPreparedRepositoryContinuation('session', reserved.childCommandId, transition);
  store.rebindPreparedRepositoryQueuedCommands('session', reserved.childCommandId, transition, [
    resume.clientMsgId,
  ]);
  expect(store.getLatestOrdinaryCommandAdmission('session')).toEqual(
    store.getOrdinaryCommandExecutionAdmission(resume.clientMsgId),
  );
  expect(() => store.getOrdinaryCommandAdmission(resume.clientMsgId)).toThrow(
    'does not match durable session identity',
  );
  expect(
    store.getPreparedRepositoryCommandAdmissionEvidence(
      resume.clientMsgId,
      reserved.childCommandId,
    ),
  ).toEqual(expected);
  const assertRuntimeChangeRefused = () => {
    database.prepare('UPDATE sessions SET runtime_binding=? WHERE session_id=?').run(
      JSON.stringify({
        ...binding,
        execution: { ...binding.execution, targetRevision: 'changed-target' },
      }),
      'session',
    );
    try {
      expect(() => store.getLatestOrdinaryCommandAdmission('session')).toThrow(
        'Explicit command execution selection changed',
      );
      expect(() => store.getOrdinaryLocalCommandExecutionAdmission(resume.clientMsgId)).toThrow(
        'Explicit command execution selection changed',
      );
    } finally {
      database
        .prepare('UPDATE sessions SET runtime_binding=? WHERE session_id=?')
        .run(JSON.stringify(binding), 'session');
    }
  };
  assertRuntimeChangeRefused();
  const nextTransition = {
    ...transition,
    preparationId: '3dbdc62d-20ab-4144-b210-c55bc7f39cda',
    priorPrimaryCommandId: reserved.childCommandId,
    source: {
      ...transition.source,
      commandId: resume.clientMsgId,
      turnId: 'second-resumed-turn',
      callId: 'second-prepare',
    },
    oldWorkspace: { kind: 'repository' as const, id: 'new', directory: '/new' },
    newWorkspace: { ...transition.newWorkspace, id: 'third', directory: '/third' },
  };
  store.finalizePreparedRepositoryContinuation(
    'session',
    reserved.childCommandId,
    transition,
    () => {},
  );
  const next = store.reservePreparedRepositoryContinuation('session', nextTransition);
  expect(store.getLatestOrdinaryCommandAdmission('session')).toEqual(
    store.getOrdinaryCommandExecutionAdmission(resume.clientMsgId),
  );
  expect(store.observePreparedRepositoryContinuation(next.childCommandId).state).toBe('uncertain');
  expect(store.hasUncertainOrdinaryCommand('session')).toBe(true);
  expect(() => store.claimOrdinaryLocalCommandDispatch(next.childCommandId)).toThrow();
  expect(store.getSendCommand(resume.clientMsgId)?.payload).toEqual(resume.payload);
  assertRuntimeChangeRefused();
  database
    .prepare('DELETE FROM ordinary_execution_admissions WHERE command_id=?')
    .run(resume.clientMsgId);
  expect(() => store.getLatestOrdinaryCommandAdmission('session')).toThrow(
    'does not match durable session identity',
  );
});
