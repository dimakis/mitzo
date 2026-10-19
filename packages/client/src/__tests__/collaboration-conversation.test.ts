import { expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { CollaborationApiClient, CollaborationApiError } from '../collaboration-api.js';
import {
  createCollaborationProjection,
  applyCollaborationEvents,
} from '../collaboration-projection.js';
import { COLLABORATION_EXECUTION_DISABLED, CollaborationViewSchema } from '@mitzo/protocol';
import type { CollaborationEvent, CollaborationMessage, CollaborationJoin } from '@mitzo/protocol';

const group = '00000000-0000-4000-8000-000000000001';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const settings = {
  binding: {
    version: 2,
    account: { accountId: 'fixture', provider: 'openai-codex', profileRevision: 'r1' },
    harness: { implementation: 'codex' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'r1' },
  },
  selection: {
    version: 1,
    agent: { profileId: 'default', revision: 1 },
    context: { source: 'none', revision: null },
    permission: { mode: 'agent', revision: 0 },
    model: 'offline-fixture',
    thinking: null,
  },
  repositoryWorkspaceId: 'workspace',
} as const;
const view = () =>
  CollaborationViewSchema.parse({
    version: 1,
    collaborationId: group,
    membershipRevision: 1,
    participantSessionIds: ['one', 'two'],
    unavailableParticipantSessionIds: [],
    cursor: 0,
    policySequence: 0,
    policies: ['one', 'two'].map((sessionId) => ({
      version: 1,
      sessionId,
      revision: 0,
      membershipRevision: 1,
      effectiveFromSequence: 0,
      readsFutureDiscussion: false,
      repliesByDefault: false,
    })),
    messages: [],
    hasEarlierMessages: false,
    joins: [],
    execution: COLLABORATION_EXECUTION_DISABLED,
  });
const event = (sequence: number, change: CollaborationEvent['change']): CollaborationEvent => ({
  version: 1,
  collaborationId: group,
  eventId: uuid(sequence + 100),
  sequence,
  change,
});
const page = (...events: CollaborationEvent[]) => ({
  events,
  cursor: events.at(-1)?.sequence ?? 0,
  highWatermark: events.at(-1)?.sequence ?? 0,
  hasMore: false,
});
const message: CollaborationMessage = {
  version: 1,
  messageId: uuid(2),
  projectionId: uuid(3),
  sequence: 1,
  author: 'operator',
  source: null,
  replyToDeliveryId: null,
  text: 'Review',
  membershipRevision: 1,
  policySequence: 0,
  policyRevisions: { one: 0, two: 0 },
  responders: ['one', 'two'],
  readers: ['one', 'two'],
  snapshot: null,
  settings: { one: settings, two: settings },
  deliveries: ['one', 'two'].map((sessionId, index) => ({
    version: 1,
    deliveryId: uuid(index + 4),
    sessionId,
    purpose: 'reply',
    revision: 0,
    status: 'pending',
    commandId: null,
    reason: null,
  })),
};
const join: CollaborationJoin = {
  version: 1,
  joinId: uuid(8),
  name: 'Reviewer',
  membershipRevision: 1,
  settings,
  snapshot: { snapshotId: uuid(9), sha256: 'a'.repeat(64) },
  allocationOperationId: uuid(10),
  state: 'pending_preparation',
  sessionId: null,
  linkedFromRevision: null,
  execution: COLLABORATION_EXECUTION_DISABLED,
};

it('uses authenticated typed API requests, validates responses and preserves disabled reasons', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(view()), { status: 200 }));
  const api = new CollaborationApiClient(fetch);
  expect(await api.view(group)).toEqual(view());
  expect(fetch).toHaveBeenCalledWith(
    `/api/session-collaborations/${group}/conversation`,
    expect.objectContaining({ credentials: 'include' }),
  );
  fetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        code: 'execution_unavailable',
        error: COLLABORATION_EXECUTION_DISABLED.reason,
      }),
      { status: 503 },
    ),
  );
  await expect(
    api.send(group, {
      requestId: uuid(20),
      expectedMembershipRevision: 1,
      expectedPolicySequence: 0,
      text: 'Hello',
      responders: { kind: 'selected', sessionIds: ['two'] },
      snapshot: null,
    }),
  ).rejects.toMatchObject({ status: 503, code: 'execution_unavailable' });
  expect(JSON.parse(fetch.mock.calls.at(-1)![1].body).responders.sessionIds).toEqual(['two']);
  fetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ untrusted: 'wrong response' }), { status: 200 }),
  );
  await expect(api.view(group)).rejects.toThrow();
  expect(new CollaborationApiError(409, 'conflict', 'Changed').status).toBe(409);
});

it('recovers and reconciles only explicit retained identities using one authenticated request and the caller signal', async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(join)));
  const api = new CollaborationApiClient(fetch);
  const signal = new AbortController().signal;
  expect(await api.recoverJoin(group, join.joinId, signal)).toEqual(join);
  expect(fetch).toHaveBeenLastCalledWith(
    `/api/session-collaborations/${group}/joins/${join.joinId}/recover`,
    {
      credentials: 'include',
      signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
  );
  const input = { requestId: uuid(30), expectedMembershipRevision: 2, snapshot: join.snapshot };
  expect(await api.reconcileJoin(group, join.joinId, input, signal)).toEqual(join);
  expect(fetch).toHaveBeenLastCalledWith(
    `/api/session-collaborations/${group}/joins/${join.joinId}/reconcile`,
    {
      credentials: 'include',
      signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('does not fetch invalid recovery/reconciliation identities or extra authority claims', async () => {
  const fetch = vi.fn();
  const api = new CollaborationApiClient(fetch);
  const input = { requestId: uuid(30), expectedMembershipRevision: 2, snapshot: join.snapshot };
  expect(() => api.recoverJoin(group, 'invalid')).toThrow(ZodError);
  expect(() => api.reconcileJoin('invalid', join.joinId, input)).toThrow(ZodError);
  expect(() => api.reconcileJoin(group, 'invalid', input)).toThrow(ZodError);
  expect(() =>
    api.reconcileJoin(group, join.joinId, { ...input, expectedMembershipRevision: -1 }),
  ).toThrow(ZodError);
  expect(() =>
    api.reconcileJoin(group, join.joinId, { ...input, operatorId: 'spoofed' } as typeof input),
  ).toThrow(ZodError);
  expect(fetch).not.toHaveBeenCalled();
});

it('preserves uncertainty without automatic retries and validates recovery/reconciliation responses', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError('lost response'));
  const api = new CollaborationApiClient(fetch);
  const input = { requestId: uuid(30), expectedMembershipRevision: 2, snapshot: join.snapshot };
  await expect(api.reconcileJoin(group, join.joinId, input)).rejects.toThrow('lost response');
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ ...join, providerThreadId: 'private' })),
  );
  await expect(api.reconcileJoin(group, join.joinId, input)).rejects.toThrow();
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ malformed: true })));
  await expect(api.recoverJoin(group, join.joinId)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('applies partial recipient outcomes and exact duplicate replay without touching ordinary chat state', () => {
  const initial = createCollaborationProjection(view());
  const one = {
    ...message.deliveries[0],
    status: 'delivered',
    commandId: 'ordinary-one',
    revision: 1,
  } as const;
  const two = {
    ...message.deliveries[1],
    status: 'uncertain',
    commandId: 'ordinary-two',
    reason: 'Await owner reconciliation',
    revision: 1,
  } as const;
  const replay = page(
    event(1, { kind: 'message', message }),
    event(2, { kind: 'delivery', messageId: message.messageId, delivery: one }),
    event(3, { kind: 'delivery', messageId: message.messageId, delivery: two }),
  );
  const result = applyCollaborationEvents(initial, replay);
  expect(result.needsRefresh).toBe(false);
  expect(result.view.messages[0].deliveries.map((d) => d.status)).toEqual([
    'delivered',
    'uncertain',
  ]);
  expect(applyCollaborationEvents(result, replay)).toEqual(result);
  expect(applyCollaborationEvents(result, page(replay.events[0]))).toEqual(result);
  expect(initial.view.messages).toEqual([]);
  expect(result.view.execution.enabled).toBe(false);
});

it('refuses gaps, conflicting duplicates, other-group events and forged receipt references', () => {
  const initial = createCollaborationProjection(view());
  expect(
    applyCollaborationEvents(initial, page(event(2, { kind: 'message', message }))).needsRefresh,
  ).toBe(true);
  const accepted = applyCollaborationEvents(initial, page(event(1, { kind: 'message', message })));
  expect(
    applyCollaborationEvents(
      accepted,
      page({ ...event(1, { kind: 'message', message }), eventId: uuid(999) }),
    ).needsRefresh,
  ).toBe(true);
  expect(
    applyCollaborationEvents(
      initial,
      page({ ...event(1, { kind: 'message', message }), collaborationId: uuid(999) }),
    ).needsRefresh,
  ).toBe(true);
  expect(
    applyCollaborationEvents(
      initial,
      page(
        event(1, {
          kind: 'delivery',
          messageId: message.messageId,
          delivery: message.deliveries[0],
        }),
      ),
    ).needsRefresh,
  ).toBe(true);
});

it('projects pending, allocated and linked joins with real IDs and preserves frozen configuration', () => {
  let state = createCollaborationProjection(view());
  state = applyCollaborationEvents(state, page(event(1, { kind: 'join', join })));
  expect(state.view.joins[0].sessionId).toBeNull();
  state = applyCollaborationEvents(
    state,
    page(event(2, { kind: 'join', join: { ...join, state: 'allocated', sessionId: 'real' } })),
  );
  expect(state.view.joins[0]).toMatchObject({ state: 'allocated', sessionId: 'real', settings });
  const membership = {
    version: 1,
    collaborationId: group,
    revision: 2,
    participantSessionIds: ['one', 'real', 'two'],
  } as const;
  state = applyCollaborationEvents(
    state,
    page(
      event(3, {
        kind: 'membership',
        membership: { ...membership, participantSessionIds: [...membership.participantSessionIds] },
        policies: [],
      }),
      event(4, {
        kind: 'join',
        join: { ...join, state: 'linked', sessionId: 'real', linkedFromRevision: 1 },
      }),
    ),
  );
  expect(state.view.participantSessionIds).toContain('real');
  expect(state.view.membershipRevision).toBe(2);
  expect(state.view.joins).toEqual([]);
  expect(state.needsRefresh).toBe(false);
});

it('retains unavailable recipients and updates inline reader/default policy without invoking execution', () => {
  const initial = view();
  initial.unavailableParticipantSessionIds = ['two'];
  const state = applyCollaborationEvents(
    createCollaborationProjection(initial),
    page(
      event(1, {
        kind: 'policy',
        policy: {
          ...initial.policies[0],
          revision: 1,
          readsFutureDiscussion: true,
          repliesByDefault: false,
          effectiveFromSequence: 2,
        },
      }),
    ),
  );
  expect(state.view.policySequence).toBe(1);
  expect(state.view.policies[0]).toMatchObject({
    readsFutureDiscussion: true,
    repliesByDefault: false,
  });
  expect(state.view.unavailableParticipantSessionIds).toEqual(['two']);
  expect(state.view.execution).toEqual(COLLABORATION_EXECUTION_DISABLED);
});
