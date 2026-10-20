import { afterEach, expect, it, vi } from 'vitest';
import { EventStore } from '@mitzo/protocol/event-store';
import { MitzoApiClient } from '@mitzo/client';
import { COLLABORATION_EXECUTION_DISABLED, type CollaborationView } from '@mitzo/protocol';
import { createConversationJoiningApplicationOwner } from '../conversation-joining-application-owner';
import { joiningSetupFixture } from '../../preview/conversation-joining-fixture';
import type { ConversationJoiningReviewRequest } from '../conversation-joining-review';

const stores: EventStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
const group = '00000000-0000-4000-8000-000000000010';
const request: ConversationJoiningReviewRequest = {
  requestId: '00000000-0000-4000-8000-000000000020',
  joiningBrief: '  Preserve the exact source and edited brief.\n  ',
  setup: {
    ...joiningSetupFixture(),
    messageIds: ['question'],
    artifacts: [],
    repositoryWorkspaceId: 'selected-workspace',
    permissionMode: 'ask',
  },
};
function harness() {
  const store = new EventStore(':memory:');
  stores.push(store);
  store.upsertSession({ sessionId: 'source-chat', conversationSource: 'mitzo' });
  store.append('source-chat', 'user_message', { messageId: 'question', text: 'Exact question.' });
  store.append('source-chat', 'message_start', { messageId: 'answer' });
  store.append('source-chat', 'block_start', {
    messageId: 'answer',
    blockId: 'text',
    blockType: 'text',
  });
  store.append('source-chat', 'block_delta', {
    messageId: 'answer',
    blockId: 'text',
    delta: 'Exact answer.',
  });
  store.append('source-chat', 'block_end', { messageId: 'answer', blockId: 'text' });
  const completed = store.append('source-chat', 'message_end', { messageId: 'answer' });
  const through = store.append('source-chat', 'ordinary_reply_source', {
    version: 1,
    messageId: 'answer',
    commandId: 'retained-command',
    providerTurnId: 'retained-provider-turn',
  });
  const view: CollaborationView = {
    version: 1,
    collaborationId: group,
    membershipRevision: 1,
    participantSessionIds: ['source-chat'],
    unavailableParticipantSessionIds: [],
    cursor: 0,
    policySequence: 0,
    policies: [],
    messages: [],
    hasEarlierMessages: false,
    joins: [],
    execution: COLLABORATION_EXECUTION_DISABLED,
  };
  // Only HTTP transport/view metadata are fixtures. Transcript and boundary are
  // always read from the actual EventStore; no boundary rewriting or projection.
  const transport = vi.fn(async (url: string, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    if (url.endsWith('?transcript=durable'))
      return Response.json(store.getDurableSessionTranscript('source-chat'));
    if (url.endsWith('/conversation')) return Response.json(view);
    if (url.endsWith('/reviews'))
      return Response.json(
        { error: 'No execution owner in this test', code: 'execution_unavailable' },
        { status: 503 },
      );
    throw Error(`Unexpected request: ${url}`);
  });
  const owner = createConversationJoiningApplicationOwner({
    api: new MitzoApiClient(transport),
    sourceConversationId: 'source-chat',
    collaborationId: group,
    getClientId: () => 'current-connection',
    getVerifiedAuthScope: () => 'current-login',
  });
  return { store, owner, transport, view, completed, through };
}

it('captures the actual event highwater after trailing metadata without replacing its visible-message anchor', async () => {
  const h = harness();
  const events = h.store.getSessionEvents('source-chat');
  const source = h.store.getDurableSessionTranscript('source-chat');
  expect(source.boundary).toEqual({ sequence: h.through, messageId: 'answer' });
  expect(source.messages.at(-1)!.sequence).toBe(h.completed);
  expect(h.through).toBeGreaterThan(h.completed);
  const captured = await h.owner.captureReview(
    structuredClone(request),
    new AbortController().signal,
  );
  expect(captured.selection.boundary).toEqual(source.boundary);
  expect(captured.selection.messageIds).toEqual(['question']);
  expect(captured.selection.joiningBrief).toBe(request.joiningBrief);
  expect(captured.target).toMatchObject({
    accountId: 'offline-account',
    model: 'offline-fixture',
    repositoryWorkspaceId: 'selected-workspace',
    permissionMode: 'ask',
  });
  await expect(h.owner.review(captured, new AbortController().signal)).rejects.toMatchObject({
    status: 503,
    code: 'execution_unavailable',
  });
  const post = h.transport.mock.calls.find(([url]) => url.endsWith('/reviews'))!;
  expect(JSON.parse(post[1]!.body as string)).toEqual({
    ...captured,
    clientId: 'current-connection',
  });
  expect(h.store.getSessionEvents('source-chat')).toEqual(events);
  expect(h.store.getDurableSessionTranscript('source-chat')).toEqual(source);
});

it('refreezes the original event cursor and exact brief after genuine later messages and metadata append', async () => {
  const h = harness();
  const source = h.store.getDurableSessionTranscript('source-chat');
  h.store.append('source-chat', 'user_message', {
    messageId: 'later',
    text: 'After the frozen source.',
  });
  h.store.append('source-chat', 'ordinary_reply_source', {
    version: 1,
    messageId: 'later',
    commandId: 'later-command',
  });
  const current = h.store.getDurableSessionTranscript('source-chat');
  expect(current.boundary.sequence).toBeGreaterThan(source.boundary.sequence);
  const captured = await h.owner.captureReview(
    {
      ...structuredClone(request),
      joiningBrief: '  Exact refreeze edit.\n ',
      previousSnapshot: {
        snapshotId: '00000000-0000-4000-8000-000000000030',
        sha256: 'c'.repeat(64),
      },
      previousSource: { boundary: source.boundary, expectedMembershipRevision: 1 },
    },
    new AbortController().signal,
  );
  expect(captured.selection.boundary).toEqual(source.boundary);
  expect(captured.selection.messageIds).toEqual(['question']);
  expect(captured.selection.joiningBrief).toBe('  Exact refreeze edit.\n ');
  expect(captured.selection.expectedMembershipRevision).toBe(1);
  expect(h.store.getDurableSessionTranscript('source-chat')).toEqual(current);
  expect(h.transport.mock.calls.some(([url]) => url.endsWith('/reviews'))).toBe(false);
});

it.each([
  'earlier-anchor',
  'absent-anchor',
  'future-cursor',
  'later-selection',
  'membership',
] as const)('still refuses %s when refreezing a genuine event-cursor prefix', async (change) => {
  const h = harness();
  const source = h.store.getDurableSessionTranscript('source-chat');
  h.store.append('source-chat', 'user_message', { messageId: 'later', text: 'Later source.' });
  const attempt = {
    ...structuredClone(request),
    previousSnapshot: {
      snapshotId: '00000000-0000-4000-8000-000000000030',
      sha256: 'c'.repeat(64),
    },
    previousSource: { boundary: structuredClone(source.boundary), expectedMembershipRevision: 1 },
  };
  if (change === 'earlier-anchor') attempt.previousSource.boundary.messageId = 'question';
  if (change === 'absent-anchor') attempt.previousSource.boundary.messageId = 'absent';
  if (change === 'future-cursor')
    attempt.previousSource.boundary.sequence =
      h.store.getDurableSessionTranscript('source-chat').boundary.sequence + 1;
  if (change === 'later-selection') attempt.setup.messageIds = ['later'];
  if (change === 'membership') h.view.membershipRevision++;
  await expect(h.owner.captureReview(attempt, new AbortController().signal)).rejects.toThrow(
    'Application review owner unavailable',
  );
  expect(h.transport.mock.calls.some(([url]) => url.endsWith('/reviews'))).toBe(false);
});
