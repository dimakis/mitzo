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

it('preserves current draft settings and retained history while the new-workspace child is only reserved', () => {
  const root = mkdtempSync(join(tmpdir(), 'prepared-settings-cold-'));
  roots.push(root);
  const path = join(root, 'events.db');
  const first = fixture(path);
  first.append('session', 'user_message', { messageId: 'original', text: original.payload.text });
  first.append('session', 'message_start', { messageId: 'retained-reply' });
  const history = first.getSessionEvents('session');
  const previous = first.getOrdinaryConversationSettings('session');
  const reserved = first.reservePreparedRepositoryContinuation('session', transition);
  const cold = new EventStore(path);
  stores.push(cold);
  expect(cold.getOrdinaryConversationSettings('session')).toEqual(previous);
  expect(cold.getLatestOrdinaryCommandAdmission('session')).toEqual(
    first.getOrdinaryLocalCommandAdmission('original'),
  );
  expect(cold.getSessionEvents('session')).toEqual(history);
  expect(() => cold.getOrdinaryLocalCommandAdmission(reserved.childCommandId)).toThrow();
  expect(cold.claimOrdinaryLocalCommandDispatch('original')).toBe(false);
  expect(cold.hasUncertainOrdinaryCommand('session')).toBe(true);
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
