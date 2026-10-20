import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createJoiningFixture as fixture,
  cleanupJoiningFixtures,
} from './fixtures/collaboration-joining.js';

afterEach(cleanupJoiningFixtures);

async function conflict() {
  const f = await fixture();
  const prepare = vi.spyOn(f.workspaces, 'prepareOrdinarySession');
  f.authority.authorizeJoin
    .mockImplementationOnce(async () => {})
    .mockImplementationOnce(async () => {
      f.store.upsertSession({ sessionId: 'other', conversationSource: 'mitzo' });
      f.store.setSessionCollaboration(f.group, {
        expectedRevision: 1,
        participantSessionIds: ['other', 'source'],
      });
    });
  await expect(f.owner().confirm('operator', f.group, f.input, f.signal)).rejects.toThrow();
  const allocated = f.store.collaborationConversation.view(f.group).joins[0];
  expect(allocated.state).toBe('allocated');
  expect(prepare).toHaveBeenCalledTimes(1);
  const approval = {
    requestId: randomUUID(),
    expectedMembershipRevision: 2,
    snapshot: structuredClone(allocated.snapshot),
  };
  return { f, allocated, approval };
}

function admitFirstCommand(
  f: Awaited<ReturnType<typeof fixture>>,
  join: Awaited<ReturnType<typeof conflict>>['allocated'],
) {
  const session = f.store.getSession(join.sessionId!)!;
  const meta = {
    sessionId: session.sessionId,
    repositoryWorkspaceId: session.repositoryWorkspaceId,
    cwd: session.cwd,
    accountBinding: session.accountBinding,
    agentProfile: session.agentProfile,
    selectedModel: session.selectedModel,
    reasoningEffort: session.reasoningEffort,
    mode: session.mode,
  };
  f.store.admitPreparedOrdinaryCommand(join.allocationOperationId, meta, join.settings.binding, {
    clientMsgId: 'first-command',
    requestFingerprint: 'first-command-fingerprint',
    selection: join.settings.selection,
    payload: { text: 'Explicit offline command' },
  });
}

it('explicitly reconciles changed membership after restart using the original silent allocation and frozen review', async () => {
  const { f, allocated, approval } = await conflict();
  f.reopen();
  f.resolvePreparation.mockClear();
  await expect(
    f.owner().recover('operator', f.group, allocated.joinId, f.signal),
  ).rejects.toThrow();
  f.resolvePreparation.mockRejectedValue(new Error('must not allocate again'));
  const joined = await f
    .owner()
    .reconcile('operator', f.group, allocated.joinId, approval, f.signal);
  expect(joined).toEqual({ ...allocated, state: 'linked', linkedFromRevision: 2 });
  expect(f.authority.authorizeReconciliation).toHaveBeenCalledWith(
    {
      operatorId: 'operator',
      collaborationId: f.group,
      join: allocated,
      membership: {
        version: 1,
        collaborationId: f.group,
        revision: 2,
        participantSessionIds: ['other', 'source'],
      },
      approval,
    },
    f.signal,
  );
  expect(f.resolvePreparation).not.toHaveBeenCalled();
  expect(f.store.listSessions()).toHaveLength(3);
  expect(f.store.getOrdinaryInitialCommandId(joined.sessionId!)).toBeUndefined();
  expect(
    f.store.getOrdinarySessionPreparation(joined.allocationOperationId)?.firstCommandId,
  ).toBeNull();
  expect(
    f.store.collaborationConversation.getSnapshot(f.group, joined.snapshot.snapshotId)
      ?.joiningBrief,
  ).toBe('Check recovery');
  expect(
    f.store.collaborationConversation
      .view(f.group)
      .policies.find((p) => p.sessionId === joined.sessionId),
  ).toMatchObject({ readsFutureDiscussion: false, repliesByDefault: false });
  expect(await f.owner().confirm('operator', f.group, f.input, f.signal)).toEqual(joined);
});

it('reauthorizes exact saved reconciliation retries observationally after a first command, restart and later membership', async () => {
  const { f, allocated, approval } = await conflict();
  const joined = await f
    .owner()
    .reconcile('operator', f.group, allocated.joinId, approval, f.signal);
  admitFirstCommand(f, joined);
  f.store.setSessionCollaboration(f.group, {
    expectedRevision: 3,
    participantSessionIds: ['source', joined.sessionId!],
  });
  f.reopen();
  const before = f.store.collaborationConversation.events(f.group).highWatermark;
  expect(await f.owner().reconcile('operator', f.group, joined.joinId, approval, f.signal)).toEqual(
    joined,
  );
  expect(f.authority.authorizeReconciliation).toHaveBeenCalledTimes(2);
  expect(f.store.collaborationConversation.events(f.group).highWatermark).toBe(before);
  await expect(
    f
      .owner()
      .reconcile(
        'operator',
        f.group,
        joined.joinId,
        { ...approval, requestId: randomUUID() },
        f.signal,
      ),
  ).rejects.toThrow();
  await expect(
    f
      .owner()
      .reconcile(
        'operator',
        f.group,
        joined.joinId,
        { ...approval, expectedMembershipRevision: 4 },
        f.signal,
      ),
  ).rejects.toThrow();
  f.authority.authorizeReconciliation.mockRejectedValueOnce(new Error('source revoked'));
  await expect(
    f.owner().reconcile('operator', f.group, joined.joinId, approval, f.signal),
  ).rejects.toThrow('source revoked');
  expect(await f.owner().confirm('operator', f.group, f.input, f.signal)).toEqual(joined);
  expect(f.store.listSessions()).toHaveLength(3);
});

it('refuses a used silent preparation at the new link CAS without replacing its session', async () => {
  const { f, allocated, approval } = await conflict();
  admitFirstCommand(f, allocated);
  expect(
    f.store.getOrdinarySessionPreparation(allocated.allocationOperationId)?.firstCommandId,
  ).toBe('first-command');
  await expect(
    f.owner().reconcile('operator', f.group, allocated.joinId, approval, f.signal),
  ).rejects.toThrow();
  expect(f.store.collaborationConversation.getJoin(f.group, allocated.joinId)).toEqual(allocated);
  expect(f.store.getSessionCollaboration(f.group)?.revision).toBe(2);
  expect(f.store.listSessions()).toHaveLength(3);
});

it('checks preparation freshness and current membership after asynchronous reconciliation authorization', async () => {
  const { f, allocated, approval } = await conflict();
  f.authority.authorizeReconciliation.mockImplementationOnce(async () => {
    admitFirstCommand(f, allocated);
  });
  await expect(
    f.owner().reconcile('operator', f.group, allocated.joinId, approval, f.signal),
  ).rejects.toThrow();
  expect(
    f.store.getOrdinarySessionPreparation(allocated.allocationOperationId)?.firstCommandId,
  ).toBe('first-command');
  expect(f.store.collaborationConversation.getJoin(f.group, allocated.joinId)).toEqual(allocated);
});

it('does not authorize a future roster guessed by the caller even if it becomes current during an await', async () => {
  const { f, allocated, approval } = await conflict();
  f.authority.authorizeReconciliation.mockImplementationOnce(async () => {
    f.store.setSessionCollaboration(f.group, {
      expectedRevision: 2,
      participantSessionIds: ['source'],
    });
  });
  await expect(
    f.owner().reconcile(
      'operator',
      f.group,
      allocated.joinId,
      {
        ...approval,
        expectedMembershipRevision: 3,
      },
      f.signal,
    ),
  ).rejects.toThrow('conflict');
  expect(f.authority.authorizeReconciliation).not.toHaveBeenCalled();
  expect(f.store.collaborationConversation.getJoin(f.group, allocated.joinId)).toEqual(allocated);
});

it('refuses late membership change, retaining allocation until another explicit approval', async () => {
  const { f, allocated, approval } = await conflict();
  f.authority.authorizeReconciliation.mockImplementationOnce(async () => {
    f.store.setSessionCollaboration(f.group, {
      expectedRevision: 2,
      participantSessionIds: ['source'],
    });
  });
  await expect(
    f.owner().reconcile('operator', f.group, allocated.joinId, approval, f.signal),
  ).rejects.toThrow();
  expect(f.store.collaborationConversation.getJoin(f.group, allocated.joinId)).toEqual(allocated);
  const joined = await f
    .owner()
    .reconcile(
      'operator',
      f.group,
      allocated.joinId,
      { ...approval, requestId: randomUUID(), expectedMembershipRevision: 3 },
      f.signal,
    );
  expect(joined).toEqual({ ...allocated, state: 'linked', linkedFromRevision: 3 });
  expect(f.store.listSessions()).toHaveLength(3);
});

it('rejects snapshot replacement, extra settings/identity claims, denied actors and cancellation without linking', async () => {
  const { f, allocated, approval } = await conflict();
  for (const changed of [
    { ...approval, snapshot: { ...approval.snapshot, sha256: 'b'.repeat(64) } },
    { ...approval, snapshot: { ...approval.snapshot, snapshotId: randomUUID() } },
    { ...approval, settings: f.input.settings },
    { ...approval, sessionId: randomUUID() },
    { ...approval, allocationOperationId: randomUUID() },
  ])
    await expect(
      f.owner().reconcile('operator', f.group, allocated.joinId, changed, f.signal),
    ).rejects.toThrow();
  f.authority.authorizeReconciliation.mockRejectedValueOnce(new Error('actor denied'));
  await expect(
    f.owner().reconcile('wrong-operator', f.group, allocated.joinId, approval, f.signal),
  ).rejects.toThrow('actor denied');
  const controller = new AbortController();
  f.authority.authorizeReconciliation.mockImplementationOnce(async () => controller.abort());
  await expect(
    f.owner().reconcile('operator', f.group, allocated.joinId, approval, controller.signal),
  ).rejects.toThrow();
  expect(f.store.collaborationConversation.getJoin(f.group, allocated.joinId)).toEqual(allocated);
  expect(f.store.getSessionCollaboration(f.group)?.revision).toBe(2);
});

it('freezes retained identities and explicit approval against caller and authority mutation across await', async () => {
  const { f, allocated, approval } = await conflict();
  const original = structuredClone(approval);
  f.authority.authorizeReconciliation.mockImplementationOnce(async (passed) => {
    passed.join.settings.selection.model = 'changed';
    passed.join.snapshot.sha256 = 'c'.repeat(64);
    passed.join.sessionId = 'replacement';
    passed.approval.expectedMembershipRevision = 99;
    approval.expectedMembershipRevision = 99;
  });
  expect(
    await f.owner().reconcile('operator', f.group, allocated.joinId, approval, f.signal),
  ).toEqual({
    ...allocated,
    state: 'linked',
    linkedFromRevision: original.expectedMembershipRevision,
  });
});
