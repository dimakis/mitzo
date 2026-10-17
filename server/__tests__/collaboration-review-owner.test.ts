import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { OrdinaryCollaborationReview } from '../collaboration-review-owner.js';
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
