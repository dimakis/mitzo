import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';

const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  const store = new EventStore(':memory:');
  stores.push(store);
  const binding = {
    version: 2 as const,
    account: {
      accountId: 'account',
      provider: 'openai-codex' as const,
      profileRevision: 'profile',
    },
    harness: { implementation: 'codex' as const },
    execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'target' },
  };
  const selection = {
    version: 1 as const,
    agent: { profileId: 'agent', revision: 1 },
    context: { source: 'none' as const, revision: null },
    permission: { mode: 'agent' as const, revision: 0 },
    model: 'fixture',
    thinking: null,
  };
  const meta = {
    sessionId: 'session',
    repositoryWorkspaceId: 'original',
    cwd: '/offline/original',
    accountBinding: { ...binding.account, accountLabel: 'Offline', model: 'fixture' },
    mode: 'agent' as const,
    selectedModel: 'fixture',
    reasoningEffort: null,
  };
  const input = (id: string) => ({
    clientMsgId: id,
    payload: { text: id, systemPrompt: 'Offline retained agent' },
    selection,
    requestFingerprint: `fingerprint-${id}`,
  });
  store.admitOrdinaryLocalCommand(meta, binding, input('initial'));
  store.claimOrdinaryLocalCommandDispatch('initial');
  store.completeOrdinaryLocalCommand('initial');
  let primary: string | undefined;
  const adopt = (queued: string[] = []) => {
    const current = store.getSession('session')!;
    const transition = {
      version: 1 as const,
      preparationId: randomUUID(),
      runtimeId: 'runtime',
      ...(primary ? { priorPrimaryCommandId: primary } : {}),
      source: {
        commandId: primary ?? 'initial',
        attempt: 1,
        threadId: 'thread',
        turnId: 'turn',
        generation: 0,
        callId: randomUUID(),
        requestHash: 'a'.repeat(64),
        resultSha256: 'b'.repeat(64),
      },
      oldWorkspace: {
        kind: 'repository' as const,
        id: current.repositoryWorkspaceId!,
        directory: current.cwd!,
      },
      newWorkspace: {
        kind: 'repository' as const,
        id: randomUUID(),
        directory: `/offline/${randomUUID()}`,
        featureBranch: 'mitzo/branch',
        baseOid: 'c'.repeat(40),
        taskIdentitySha256: 'd'.repeat(64),
      },
      consumedScopeSha256: 'e'.repeat(64),
      materializedRecordSha256: 'f'.repeat(64),
    };
    const child = store.reservePreparedRepositoryContinuation('session', transition);
    store.commitPreparedRepositoryContinuation('session', child.childCommandId, transition);
    store.rebindPreparedRepositoryQueuedCommands(
      'session',
      child.childCommandId,
      transition,
      queued,
    );
    store.finalizePreparedRepositoryContinuation(
      'session',
      child.childCommandId,
      transition,
      () => {},
    );
    primary = child.childCommandId;
    return primary;
  };
  adopt();
  const scope = (id: string, wireFingerprint = '1'.repeat(64)) => ({
    sessionId: 'session',
    commandId: id,
    wireFingerprint,
    bridge: store.preparedRepositoryWireTarget('session', 'original', primary!),
    historicalCapabilityRevision: 'known-capability',
  });
  const admit = (id: string) =>
    store.admitPreparedRepositoryPrimaryContinuation(
      store.getSession('session')!,
      binding,
      input(id),
      primary!,
    );
  return { store, binding, selection, adopt, scope, admit };
}

it('stores exact original wire and execution admission atomically and observes without admitting', async () => {
  const f = fixture(),
    scope = f.scope('late');
  expect(f.store.observePostAdoptionWireAdmission('late', scope.wireFingerprint)).toBeUndefined();
  const assertCurrent = vi.fn();
  await f.store.withOrdinaryCommandWireAdmission(scope, assertCurrent, async () => f.admit('late'));
  expect(assertCurrent).toHaveBeenCalledOnce();
  expect(f.store.observePostAdoptionWireAdmission('late', scope.wireFingerprint)).toMatchObject({
    ...scope,
    executionAdmission: { state: 'reserved', workspace: scope.bridge.executionWorkspace },
  });
  expect(() => f.store.observePostAdoptionWireAdmission('late', '2'.repeat(64))).toThrow(
    'identity',
  );
  await expect(
    f.store.withOrdinaryCommandWireAdmission(
      { ...scope, wireFingerprint: '2'.repeat(64) },
      () => {},
      async () => f.admit('late'),
    ),
  ).rejects.toThrow('wire changed');
  expect(f.store.getSendCommand('late')?.payload).toEqual({
    text: 'late',
    systemPrompt: 'Offline retained agent',
  });
});

it('deduplicates an exact reserved retry but rejects a second wire for the same command', async () => {
  const f = fixture(),
    scope = f.scope('late');
  const run = () =>
    f.store.withOrdinaryCommandWireAdmission(
      scope,
      () => {},
      async () => f.admit('late'),
    );
  expect((await run()).duplicate).toBe(false);
  expect((await run()).duplicate).toBe(true);
  const observed = f.store.observePostAdoptionWireAdmission('late', scope.wireFingerprint);
  expect(observed?.executionAdmission.state).toBe('reserved');
  await expect(
    f.store.withOrdinaryCommandWireAdmission(
      { ...scope, wireFingerprint: '3'.repeat(64) },
      () => {},
      async () => f.admit('late'),
    ),
  ).rejects.toThrow();
});

it('consumes private context once, refuses nested/foreign use, and never grants absent capability proof', async () => {
  const f = fixture(),
    scope = f.scope('late'),
    otherStore = fixture().store;
  expect(f.store.qualifiesOrdinaryCommandCapability('late', 'known-capability')).toBe(false);
  await f.store.withOrdinaryCommandWireAdmission(
    scope,
    () => {},
    async () => {
      expect(f.store.qualifiesOrdinaryCommandCapability('foreign', 'known-capability')).toBe(false);
      expect(f.store.qualifiesOrdinaryCommandCapability('late', 'forged-capability')).toBe(false);
      expect(f.store.qualifiesOrdinaryCommandCapability('late', 'known-capability')).toBe(true);
      expect(otherStore.qualifiesOrdinaryCommandCapability('late', 'known-capability')).toBe(false);
      expect(() =>
        f.store.withOrdinaryCommandWireAdmission(
          scope,
          () => {},
          async () => f.admit('late'),
        ),
      ).toThrow('Nested');
      f.admit('late');
      expect(f.store.qualifiesOrdinaryCommandCapability('late', 'known-capability')).toBe(false);
      expect(() => f.admit('late')).toThrow('already consumed');
    },
  );
  await expect(
    f.store.withOrdinaryCommandWireAdmission(
      f.scope('other'),
      () => {},
      async () => f.admit('wrong'),
    ),
  ).rejects.toThrow('command changed');
  expect(f.store.getSendCommand('wrong')).toBeUndefined();
});

it('rechecks canonical lineage and synchronous owner before transaction and rolls back both rows', async () => {
  const f = fixture(),
    scope = f.scope('late');
  await expect(
    f.store.withOrdinaryCommandWireAdmission(
      scope,
      () => {
        throw Error('revoked');
      },
      async () => f.admit('late'),
    ),
  ).rejects.toThrow('revoked');
  expect(f.store.getSendCommand('late')).toBeUndefined();
  expect(f.store.observePostAdoptionWireAdmission('late', scope.wireFingerprint)).toBeUndefined();
  f.adopt();
  await expect(
    f.store.withOrdinaryCommandWireAdmission(
      scope,
      () => {},
      async () => f.admit('late'),
    ),
  ).rejects.toThrow('not current');
  const fresh = f.scope('late');
  await f.store.withOrdinaryCommandWireAdmission(
    fresh,
    () => {},
    async () => f.admit('late'),
  );
  expect(fresh.bridge.requestedWorkspace.workspaceId).toBe('original');
});

it('keeps a consumed bridged receipt after another canonical adoption without retargeting its stored proof', async () => {
  const f = fixture(),
    scope = f.scope('late');
  await f.store.withOrdinaryCommandWireAdmission(
    scope,
    () => {},
    async () => f.admit('late'),
  );
  f.store.claimOrdinaryLocalCommandDispatch('late');
  f.store.completeOrdinaryLocalCommand('late');
  f.adopt(['late']);
  const receipt = f.store.observePostAdoptionWireAdmission('late', scope.wireFingerprint);
  expect(receipt).toMatchObject({
    ...scope,
    executionAdmission: { state: 'consumed', workspace: scope.bridge.executionWorkspace },
  });
  expect(
    f.store.observePreparedRepositoryCommandRouting('late', true)?.execution.workspaceId,
  ).not.toBe(scope.bridge.executionWorkspace.workspaceId);
});

it('does not convert a preexisting uncertain command into new wire authority or admit around uncertainty', async () => {
  const f = fixture();
  f.admit('ambiguous');
  f.store.claimOrdinaryLocalCommandDispatch('ambiguous');
  const original = structuredClone(f.store.getOrdinaryLocalCommandAdmission('ambiguous'));
  await expect(
    f.store.withOrdinaryCommandWireAdmission(
      f.scope('ambiguous'),
      () => {},
      async () => f.admit('ambiguous'),
    ),
  ).rejects.toThrow('cannot become');
  expect(f.store.getOrdinaryLocalCommandAdmission('ambiguous')).toEqual(original);
  await expect(
    f.store.withOrdinaryCommandWireAdmission(
      f.scope('late'),
      () => {},
      async () => f.admit('late'),
    ),
  ).rejects.toThrow('uncertain');
  expect(f.store.getSendCommand('late')).toBeUndefined();
});

it('fails atomically when durable bridge insertion fails, and refuses asynchronous owner callbacks', async () => {
  const f = fixture(),
    scope = f.scope('late');
  await expect(
    f.store.withOrdinaryCommandWireAdmission(
      scope,
      async () => {},
      async () => f.admit('late'),
    ),
  ).rejects.toThrow('Synchronous');
  const db = (f.store as unknown as { db: import('better-sqlite3').Database }).db;
  db.exec(
    "CREATE TRIGGER refuse_bridge BEFORE INSERT ON ordinary_post_adoption_wire_admissions BEGIN SELECT RAISE(ABORT, 'bridge write refused'); END",
  );
  await expect(
    f.store.withOrdinaryCommandWireAdmission(
      scope,
      () => {},
      async () => f.admit('late'),
    ),
  ).rejects.toThrow('bridge write refused');
  expect(f.store.getSendCommand('late')).toBeUndefined();
  expect(f.store.observePostAdoptionWireAdmission('late', scope.wireFingerprint)).toBeUndefined();
});
