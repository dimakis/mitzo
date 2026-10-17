import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { OrdinaryCollaborationReview } from '../collaboration-review-owner.js';
import type { CollaborationCapacityAdapter } from '../collaboration-context-compiler.js';
import { createCollaborationContextSource } from '../collaboration-context-source.js';
import type { CollaborationSettings } from '@mitzo/protocol';

const settings: CollaborationSettings = {
  binding: {
    version: 2,
    account: { accountId: 'offline', provider: 'openai-codex', profileRevision: 'r1' },
    harness: { implementation: 'codex' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'r1' },
  },
  selection: {
    version: 1,
    agent: { profileId: 'default-mitzo', revision: 1, kind: 'builtin' },
    context: { source: 'none', revision: null },
    permission: { mode: 'agent', revision: 0 },
    model: 'offline-fixture',
    thinking: null,
  },
  repositoryWorkspaceId: 'reserved-workspace',
};
let store: EventStore, root: string, group: string, boundary: number;
const authorize = vi.fn(async (_operator: string, _session: string) => {});
function owner() {
  return new OrdinaryCollaborationReview({
    store,
    source: (operatorId: string) =>
      createCollaborationContextSource({
        store,
        authorizeConversation: (id) => authorize(operatorId, id),
      }),
  });
}
function input() {
  return {
    operatorId: 'operator',
    selection: {
      requestId: randomUUID(),
      expectedMembershipRevision: 1,
      sourceConversationId: 'source',
      boundary: { sequence: boundary, messageId: 'question' },
      mode: 'conversation_so_far' as const,
      messageIds: [],
      artifacts: [],
      purpose: 'Review ordinary code',
      joiningBrief: 'Check recovery.',
    },
    settings: [settings],
  };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ordinary-review-'));
  store = new EventStore(join(root, 'events.db'));
  group = randomUUID();
  store.upsertSession({ sessionId: 'source', conversationSource: 'mitzo' });
  store.collaborationConversation.begin(group, { requestId: randomUUID(), sessionId: 'source' });
  boundary = store.append('source', 'user_message', {
    messageId: 'question',
    text: 'Visible question',
  });
  authorize.mockReset().mockImplementation(async () => {});
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

it('compiles the real visible-source owner without allocating a session, queue or command', async () => {
  const review = await owner().review(group, input());
  expect(review.messages).toHaveLength(1);
  expect(review.messages[0].blocks[0].content).toBe('Visible question');
  expect(review.capacity.status).toBe('unverified');
  expect(authorize).toHaveBeenCalledWith('operator', 'source');
  expect(store.listSessions()).toHaveLength(1);
  expect(store.getOrdinaryInitialCommandId('source')).toBeUndefined();
  expect(store.collaborationConversation.view(group).joins).toEqual([]);
});

it('recovers the exact completed request after lost response and restart before compiling mutable sources', async () => {
  const request = input();
  const first = await owner().review(group, request);
  store.close();
  store = new EventStore(join(root, 'events.db'));
  authorize.mockClear().mockRejectedValue(new Error('access changed'));
  const replay = await owner().review(group, request);
  expect(replay).toEqual(first);
  expect(authorize).not.toHaveBeenCalled();
  // Recovery returns immutable evidence; confirmation still needs a fresh authorization fence.
  expect(store.collaborationConversation.view(group).cursor).toBe(1);
});

it('concurrent compilations of the same review request produce one immutable snapshot', async () => {
  const request = input();
  const [first, second] = await Promise.all([
    owner().review(group, request),
    owner().review(group, request),
  ]);
  expect(second).toEqual(first);
  expect(store.collaborationConversation.view(group).cursor).toBe(1);
});

it.each(['operator', 'brief', 'settings', 'source', 'membership'] as const)(
  'refuses changed %s under the same request identity before source access',
  async (field) => {
    const request = input();
    await owner().review(group, request);
    authorize.mockClear();
    const changed = structuredClone(request);
    if (field === 'operator') changed.operatorId = 'another-operator';
    if (field === 'brief') changed.selection.joiningBrief = 'Different brief';
    if (field === 'settings') changed.settings[0].selection.permission.revision++;
    if (field === 'source') changed.selection.boundary.sequence++;
    if (field === 'membership') changed.selection.expectedMembershipRevision++;
    await expect(owner().review(group, changed)).rejects.toMatchObject({
      code: 'request_conflict',
    });
    expect(authorize).not.toHaveBeenCalled();
  },
);

it('retains the original intent when compilation fails and retries its exact source pins', async () => {
  const request = input();
  authorize.mockRejectedValueOnce(new Error('temporarily unavailable'));
  await expect(owner().review(group, request)).rejects.toThrow('temporarily unavailable');
  store.append('source', 'user_message', { messageId: 'later', text: 'Later discussion' });
  const review = await owner().review(group, request);
  expect(review.boundary).toEqual(request.selection.boundary);
  expect(review.messages.map((m) => m.messageId)).toEqual(['question']);
});

it('does not reserve stale membership or an unrelated source discussion', async () => {
  const request = input();
  await expect(
    owner().review(group, {
      ...request,
      selection: { ...request.selection, expectedMembershipRevision: 0 },
    }),
  ).rejects.toMatchObject({ code: 'conflict' });
  await expect(
    owner().review(group, {
      ...request,
      selection: { ...request.selection, sourceConversationId: 'unrelated' },
    }),
  ).rejects.toMatchObject({ code: 'unknown_recipient' });
  expect(authorize).not.toHaveBeenCalled();
});

it('keeps unverified capacity unable to confirm a join', async () => {
  const request = input();
  const snapshot = await owner().review(group, request);
  expect(() =>
    store.collaborationConversation.prepareJoin(group, {
      requestId: randomUUID(),
      expectedMembershipRevision: 1,
      name: 'Reviewer',
      settings,
      snapshot: { snapshotId: snapshot.snapshotId, sha256: snapshot.sha256 },
    }),
  ).toThrow('capacity_refused');
});

it('keeps equivalent key ordering exact and rejects request IDs used by other mutations', async () => {
  const request = input();
  const first = await owner().review(group, request);
  const reordered = {
    settings: request.settings,
    selection: { ...request.selection, boundary: { messageId: 'question', sequence: boundary } },
    operatorId: request.operatorId,
  };
  expect(await owner().review(group, reordered)).toEqual(first);
  expect(() =>
    store.collaborationConversation.setPolicy(group, {
      requestId: request.selection.requestId,
      expectedMembershipRevision: 1,
      expectedRevision: 0,
      sessionId: 'source',
      readsFutureDiscussion: false,
      repliesByDefault: false,
    }),
  ).toThrow('request_conflict');
});

it('atomically retains private native witness with exact review and recovers it without recounting', async () => {
  const measure = vi.fn(
    async ({
      settings,
      contextSha256,
    }: Parameters<CollaborationCapacityAdapter['measure']>[0]) => ({
      kind: 'nativePreparedRequest' as const,
      scope: 'reviewContext' as const,
      settings,
      contextSha256,
      inputTokens: 20,
      maxOutputTokens: 10,
      contextWindowTokens: 30,
      nativeWitness: {
        preparationId: 'private-preparation',
        requestIdentity: 'a'.repeat(64),
        witnessId: 'private-witness',
      },
    }),
  );
  const reviewOwner = () =>
    new OrdinaryCollaborationReview({
      store,
      source: (operatorId) =>
        createCollaborationContextSource({
          store,
          authorizeConversation: (id) => authorize(operatorId, id),
        }),
      capacity: { measure },
    });
  const request = input();
  const first = await reviewOwner().review(group, request);
  const retained = store.collaborationConversation.getReviewCapacityWitnesses(
    group,
    first.snapshotId,
  );
  expect(retained).toHaveLength(1);
  expect(retained[0]).toMatchObject({
    assessment: first.capacity.status === 'ready' && first.capacity.assessments[0],
    nativeWitness: { preparationId: 'private-preparation', witnessId: 'private-witness' },
  });
  expect(JSON.stringify(first)).not.toMatch(
    /private-preparation|private-witness|nativeWitness|nativeOperationId|collaboration-review:/,
  );
  store.close();
  store = new EventStore(join(root, 'events.db'));
  expect(await reviewOwner().review(group, request)).toEqual(first);
  expect(
    store.collaborationConversation.getReviewCapacityWitnesses(group, first.snapshotId),
  ).toEqual(retained);
  expect(measure).toHaveBeenCalledOnce();
  expect(JSON.stringify(store.collaborationConversation.view(group))).not.toContain(
    'private-witness',
  );
});

it('does not manufacture native authority for historical saved snapshots', async () => {
  const snapshot = await owner().review(group, input());
  expect(
    store.collaborationConversation.getReviewCapacityWitnesses(group, snapshot.snapshotId),
  ).toEqual([]);
});

function nativeOwner() {
  return new OrdinaryCollaborationReview({
    store,
    source: (operatorId) =>
      createCollaborationContextSource({
        store,
        authorizeConversation: (id) => authorize(operatorId, id),
      }),
    capacity: {
      measure: async ({ settings, contextSha256 }) => ({
        kind: 'nativePreparedRequest',
        scope: 'reviewContext',
        settings,
        contextSha256,
        inputTokens: 20,
        maxOutputTokens: 10,
        contextWindowTokens: 30,
        nativeWitness: {
          preparationId: 'private-preparation',
          requestIdentity: 'a'.repeat(64),
          witnessId: 'private-witness',
        },
      }),
    },
  });
}

it('keeps concurrent native compilations attached to the one winning immutable assessment', async () => {
  const request = input();
  const [first, second] = await Promise.all([
    nativeOwner().review(group, request),
    nativeOwner().review(group, request),
  ]);
  expect(second).toEqual(first);
  const retained = store.collaborationConversation.getReviewCapacityWitnesses(
    group,
    first.snapshotId,
  );
  expect(retained).toHaveLength(1);
  expect(retained[0].assessment).toEqual(
    first.capacity.status === 'ready' && first.capacity.assessments[0],
  );
  expect(store.collaborationConversation.view(group).cursor).toBe(1);
});

it.each(['context', 'count', 'measurement', 'scope', 'settings', 'operation'] as const)(
  'rejects corrupted private %s association instead of renewing authority',
  async (field) => {
    const snapshot = await nativeOwner().review(group, input());
    const db = new Database(join(root, 'events.db'));
    try {
      const row = db
        .prepare("SELECT body FROM collaboration_records WHERE kind='review-capacity-witnesses'")
        .get() as { body: string };
      const record = JSON.parse(row.body);
      const witness = record.witnesses[0];
      if (field === 'context') witness.contextSha256 = 'b'.repeat(64);
      if (field === 'count') witness.assessment.inputTokens--;
      if (field === 'measurement') witness.assessment.measurementId = randomUUID();
      if (field === 'scope') witness.assessment.scope = 'command';
      if (field === 'operation')
        witness.nativeOperationId = `collaboration-review:${'b'.repeat(64)}`;
      if (field === 'settings') witness.assessment.settings.selection.model = 'changed';
      db.prepare(
        "UPDATE collaboration_records SET body=? WHERE kind='review-capacity-witnesses'",
      ).run(JSON.stringify(record));
      expect(() =>
        store.collaborationConversation.getReviewCapacityWitnesses(group, snapshot.snapshotId),
      ).toThrow();
      expect(store.collaborationConversation.getSnapshot(group, snapshot.snapshotId)).toEqual(
        snapshot,
      );
    } finally {
      db.close();
    }
  },
);

it('rejects a mismatched witness before saving either snapshot or completed review', async () => {
  const request = input();
  store.collaborationConversation.reserveReviewCompilation(group, request);
  const snapshot = await nativeOwner().review(group, input());
  const witnesses = store.collaborationConversation.getReviewCapacityWitnesses(
    group,
    snapshot.snapshotId,
  );
  const content: Record<string, unknown> = { ...snapshot };
  delete content.version;
  delete content.snapshotId;
  delete content.sha256;
  const draft = { ...content, requestId: request.selection.requestId };
  witnesses[0].contextSha256 = createHash('sha256').update('different context').digest('hex');
  const before = store.collaborationConversation.view(group).cursor;
  expect(() =>
    store.collaborationConversation.completeReviewCompilation(
      group,
      request.selection.requestId,
      draft,
      witnesses,
    ),
  ).toThrow('snapshot_changed');
  expect(
    store.collaborationConversation.reserveReviewCompilation(group, request).snapshotId,
  ).toBeNull();
  expect(store.collaborationConversation.view(group).cursor).toBe(before);
});

it('recovers the original unavailable review without retrying a newly supported route', async () => {
  const measure = vi.fn(
    async ({
      settings,
      contextSha256,
    }: Parameters<CollaborationCapacityAdapter['measure']>[0]) => ({
      kind: 'unavailable' as const,
      settings,
      contextSha256,
      status: 'unverified' as const,
      reason: 'Selected native route is unavailable.',
    }),
  );
  const unavailable = new OrdinaryCollaborationReview({
    store,
    source: (operatorId) =>
      createCollaborationContextSource({
        store,
        authorizeConversation: (id) => authorize(operatorId, id),
      }),
    capacity: { measure },
  });
  const request = input();
  const first = await unavailable.review(group, request);
  expect(first.capacity.status).toBe('unverified');
  expect(await nativeOwner().review(group, request)).toEqual(first);
  expect(measure).toHaveBeenCalledOnce();
  expect(
    store.collaborationConversation.getReviewCapacityWitnesses(group, first.snapshotId),
  ).toEqual([]);
});

it('passes the original native operation across unfinished restart and concurrent review attempts', async () => {
  const measure = vi.fn<CollaborationCapacityAdapter['measure']>(
    async ({ settings, contextSha256 }) => ({
      kind: 'nativePreparedRequest',
      scope: 'reviewContext',
      settings,
      contextSha256,
      inputTokens: 20,
      maxOutputTokens: 10,
      contextWindowTokens: 30,
      nativeWitness: {
        preparationId: 'private-preparation',
        requestIdentity: 'a'.repeat(64),
        witnessId: 'private-witness',
      },
    }),
  );
  const create = () =>
    new OrdinaryCollaborationReview({
      store,
      source: (operatorId) =>
        createCollaborationContextSource({
          store,
          authorizeConversation: (id) => authorize(operatorId, id),
        }),
      capacity: { measure },
    });
  const request = input();
  measure.mockRejectedValueOnce(Error('lost measurement response'));
  await expect(create().review(group, request)).rejects.toThrow('lost measurement response');
  store.close();
  store = new EventStore(join(root, 'events.db'));
  await create().review(group, request);
  const first = measure.mock.calls[0][0].nativeOperationId;
  expect(first).toMatch(/^collaboration-review:[a-f0-9]{64}$/);
  expect(measure.mock.calls[1][0].nativeOperationId).toBe(first);
  const concurrent = input();
  await Promise.all([create().review(group, concurrent), create().review(group, concurrent)]);
  expect(measure.mock.calls[2][0].nativeOperationId).toBe(
    measure.mock.calls[3][0].nativeOperationId,
  );
  expect(measure.mock.calls[2][0].nativeOperationId).not.toBe(first);
});

it('isolates native operation by original group, operator and selected recipient settings', async () => {
  const measure = vi.fn<CollaborationCapacityAdapter['measure']>(
    async ({ settings, contextSha256 }) => ({
      kind: 'nativePreparedRequest',
      scope: 'reviewContext',
      settings,
      contextSha256,
      inputTokens: 20,
      maxOutputTokens: 10,
      contextWindowTokens: 30,
      nativeWitness: {
        preparationId: 'private-preparation',
        requestIdentity: 'a'.repeat(64),
        witnessId: 'private-witness',
      },
    }),
  );
  const create = () =>
    new OrdinaryCollaborationReview({
      store,
      source: (operatorId) =>
        createCollaborationContextSource({
          store,
          authorizeConversation: (id) => authorize(operatorId, id),
        }),
      capacity: { measure },
    });
  const request = input();
  await create().review(group, request);
  const original = measure.mock.calls[0][0].nativeOperationId;
  const otherGroup = randomUUID();
  store.close();
  store = new EventStore(':memory:');
  store.upsertSession({ sessionId: 'source', conversationSource: 'mitzo' });
  store.collaborationConversation.begin(otherGroup, {
    requestId: randomUUID(),
    sessionId: 'source',
  });
  store.append('source', 'user_message', { messageId: 'question', text: 'Visible question' });
  await create().review(otherGroup, request);
  expect(measure.mock.calls[1][0].nativeOperationId).not.toBe(original);
  store.close();
  store = new EventStore(':memory:');
  store.upsertSession({ sessionId: 'source', conversationSource: 'mitzo' });
  store.collaborationConversation.begin(group, { requestId: randomUUID(), sessionId: 'source' });
  store.append('source', 'user_message', { messageId: 'question', text: 'Visible question' });
  await create().review(group, {
    ...request,
    operatorId: 'another-operator',
    settings: [
      settings,
      { ...settings, selection: { ...settings.selection, model: 'another-model' } },
    ],
  });
  expect(measure.mock.calls[2][0].nativeOperationId).not.toBe(original);
  expect(measure.mock.calls[2][0].nativeOperationId).not.toBe(
    measure.mock.calls[3][0].nativeOperationId,
  );
});
