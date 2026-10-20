import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventStore } from '../src/event-store.js';

const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function fixture(prepared = true) {
  const store = new EventStore(':memory:');
  stores.push(store);
  const binding = {
    version: 2,
    account: { accountId: 'offline', provider: 'openai-codex', profileRevision: 'r1' },
    harness: { implementation: 'codex' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'r1' },
  } as const;
  const selection = {
    version: 1,
    agent: { profileId: 'agent', revision: 1 },
    context: { source: 'none', revision: null },
    permission: { mode: 'agent', revision: 0 },
    model: 'offline-fixture',
    thinking: null,
  } as const;
  const settings = { binding, selection, repositoryWorkspaceId: 'workspace' };
  const meta = {
    sessionId: 'fresh',
    repositoryWorkspaceId: 'workspace',
    cwd: '/task',
    accountBinding: { ...binding.account, accountLabel: 'Offline', model: 'offline-fixture' },
    selectedModel: 'offline-fixture',
    mode: 'agent' as const,
    reasoningEffort: null,
  };
  const group = randomUUID();
  store.upsertSession({ sessionId: 'source', conversationSource: 'mitzo' });
  store.upsertSession({ sessionId: 'other', conversationSource: 'mitzo' });
  store.collaborationConversation.begin(group, { requestId: randomUUID(), sessionId: 'source' });
  const snapshot = store.collaborationConversation.saveSnapshot(group, {
    requestId: randomUUID(),
    sourceConversationId: 'source',
    boundary: { sequence: 0, messageId: null },
    mode: 'selected',
    purpose: 'Review',
    joiningBrief: 'Original private brief',
    messages: [],
    artifacts: [],
    summary: null,
    capacity: {
      status: 'ready',
      assessments: [
        {
          settings,
          availableTokens: 100,
          estimatedTokens: 10,
          estimatorRevision: 'offline-fixture',
        },
      ],
    },
  });
  const pending = store.collaborationConversation.prepareJoin(group, {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    name: 'Same display name',
    settings,
    snapshot: { snapshotId: snapshot.snapshotId, sha256: snapshot.sha256 },
  });
  const command = {
    clientMsgId: 'explicit-first',
    requestFingerprint: 'offline-command',
    selection,
    payload: { text: 'Explicit offline command' },
  };
  if (prepared)
    store.prepareOrdinarySession(meta, {
      allocationOperationId: pending.allocationOperationId,
      preparationFingerprint: 'a'.repeat(64),
      settings,
    });
  else
    store.admitOrdinaryLocalCommand(meta, binding, {
      ...command,
      clientMsgId: pending.allocationOperationId,
    });
  const allocated = store.collaborationConversation.recordAllocation(group, pending.joinId, {
    operationId: pending.allocationOperationId,
    sessionId: meta.sessionId,
    settings,
  });
  store.setSessionCollaboration(group, {
    expectedRevision: 1,
    participantSessionIds: ['source', 'other'],
  });
  const approval = {
    requestId: randomUUID(),
    expectedMembershipRevision: 2,
    snapshot: structuredClone(allocated.snapshot),
  };
  return { store, group, allocated, approval, meta, binding, command };
}

it('links an unused prepared session with exact original review, default privacy and the explicit new revision', () => {
  const { store, group, allocated, approval } = fixture();
  const linked = store.collaborationConversation.reconcileJoin(group, allocated.joinId, approval);
  expect(linked).toEqual({ ...allocated, state: 'linked', linkedFromRevision: 2 });
  expect(store.getSessionCollaboration(group)).toMatchObject({
    revision: 3,
    participantSessionIds: ['fresh', 'other', 'source'],
  });
  expect(
    store.collaborationConversation.view(group).policies.find((p) => p.sessionId === 'fresh'),
  ).toMatchObject({ readsFutureDiscussion: false, repliesByDefault: false });
  expect(store.getOrdinaryInitialCommandId('fresh')).toBeUndefined();
});

it('returns only exact saved retries after first command and later membership; new linked approvals refuse', () => {
  const { store, group, allocated, approval, meta, binding, command } = fixture();
  const linked = store.collaborationConversation.reconcileJoin(group, allocated.joinId, approval);
  store.admitPreparedOrdinaryCommand(allocated.allocationOperationId, meta, binding, command);
  store.setSessionCollaboration(group, { expectedRevision: 3, participantSessionIds: ['source'] });
  const watermark = store.collaborationConversation.events(group).highWatermark;
  expect(store.collaborationConversation.reconcileJoin(group, allocated.joinId, approval)).toEqual(
    linked,
  );
  expect(() =>
    store.collaborationConversation.reconcileJoin(group, allocated.joinId, {
      ...approval,
      requestId: randomUUID(),
    }),
  ).toThrow('invalid_transition');
  expect(() =>
    store.collaborationConversation.reconcileJoin(group, allocated.joinId, {
      ...approval,
      expectedMembershipRevision: 4,
    }),
  ).toThrow('request_conflict');
  expect(store.collaborationConversation.events(group).highWatermark).toBe(watermark);
});

it('does not grant a legacy first-command allocation the new reconciliation transition', () => {
  const { store, group, allocated, approval } = fixture(false);
  expect(() =>
    store.collaborationConversation.reconcileJoin(group, allocated.joinId, approval),
  ).toThrow('allocation_conflict');
  expect(store.collaborationConversation.getJoin(group, allocated.joinId)).toEqual(allocated);
  // Preserve the historical trusted direct link API and its legacy first-command proof.
  expect(store.collaborationConversation.linkJoin(group, allocated.joinId, 2)).toMatchObject({
    state: 'linked',
    sessionId: 'fresh',
  });
});

it('checks prepared first-command freshness in the same link transaction', () => {
  const { store, group, allocated, approval, meta, binding, command } = fixture();
  store.admitPreparedOrdinaryCommand(allocated.allocationOperationId, meta, binding, command);
  expect(() =>
    store.collaborationConversation.reconcileJoin(group, allocated.joinId, approval),
  ).toThrow('allocation_conflict');
  expect(store.collaborationConversation.getJoin(group, allocated.joinId)).toEqual(allocated);
  expect(store.getSessionCollaboration(group)?.revision).toBe(2);
});

it('refuses drift of the prepared runtime settings without consuming the approval receipt', () => {
  const { store, group, allocated, approval } = fixture();
  store.upsertSession({ sessionId: 'fresh', selectedModel: 'changed-model' });
  expect(() =>
    store.collaborationConversation.reconcileJoin(group, allocated.joinId, approval),
  ).toThrow('Prepared ordinary session changed');
  expect(store.collaborationConversation.getJoin(group, allocated.joinId)).toEqual(allocated);
  expect(store.getSessionCollaboration(group)?.revision).toBe(2);
});

it('refuses a different snapshot even if that snapshot is itself saved with ready capacity', () => {
  const { store, group, allocated, approval } = fixture();
  const original = store.collaborationConversation.getSnapshot(
    group,
    allocated.snapshot.snapshotId,
  )!;
  const { version: _version, snapshotId: _id, sha256: _sha, ...draft } = original;
  const replacement = store.collaborationConversation.saveSnapshot(group, {
    ...draft,
    requestId: randomUUID(),
    joiningBrief: 'Different brief',
  });
  expect(() =>
    store.collaborationConversation.reconcileJoin(group, allocated.joinId, {
      ...approval,
      snapshot: { snapshotId: replacement.snapshotId, sha256: replacement.sha256 },
    }),
  ).toThrow('snapshot_changed');
  expect(store.collaborationConversation.getJoin(group, allocated.joinId)).toEqual(allocated);
  expect(
    store.collaborationConversation.reconcileJoin(group, allocated.joinId, approval),
  ).toMatchObject({ state: 'linked' });
});

it('rolls back membership, privacy policies, join events and request receipt together if linking fails', () => {
  const { store, group, allocated, approval } = fixture();
  const before = store.collaborationConversation.view(group);
  const set = store.setSessionCollaboration.bind(store);
  const fail = vi.spyOn(store, 'setSessionCollaboration').mockImplementationOnce((...args) => {
    set(...args);
    throw new Error('failure after membership CAS');
  });
  expect(() =>
    store.collaborationConversation.reconcileJoin(group, allocated.joinId, approval),
  ).toThrow('failure after membership CAS');
  expect(store.collaborationConversation.view(group)).toEqual(before);
  expect(store.getSessionCollaboration(group)?.revision).toBe(2);
  fail.mockRestore();
  expect(store.collaborationConversation.reconcileJoin(group, allocated.joinId, approval)).toEqual({
    ...allocated,
    state: 'linked',
    linkedFromRevision: 2,
  });
});
