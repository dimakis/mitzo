// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MitzoApiClient } from '@mitzo/client';
import { COLLABORATION_EXECUTION_DISABLED, createOrdinaryFreshPermission } from '@mitzo/protocol';
import { joiningTargetHarness } from '../../test-utils/conversation-joining-target-harness';
import { joiningReviewFixture } from '../../preview/conversation-joining-fixture';
import { useConversationJoiningReview } from '../../hooks/useConversationJoiningReview';
import { createPreparedConversationJoiningOwner } from '../conversation-joining-prepared-owner';
import { prepareConversationJoiningTarget } from '../conversation-joining-target-owner';
import { sha256Hex } from '../browser-crypto';
import * as auth from '../api-fetch';

const group = '00000000-0000-4000-8000-000000000010';
beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  auth.markAuthLost();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, authSessionId: 'target-owner-login' })),
  );
  await auth.restoreCookieAuthentication();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Actual client + preparation/review adapters/hook, recording HTTP boundaries.
 * Capacity is always UNVERIFIED. This is not server/native or model qualification. */
function harness() {
  const h = joiningTargetHarness();
  let lost = false;
  let repository: string | null = 'dimakis/mitzo';
  const transcript = {
    sourceConversationId: 'source-chat',
    boundary: joiningReviewFixture().snapshot.boundary,
    messages: joiningReviewFixture().snapshot.messages,
  };
  h.extra((path, init) => {
    if (path === '/api/sessions/source-chat/messages') return Response.json(transcript);
    if (path.endsWith('/conversation'))
      return Response.json({
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
      });
    if (!path.endsWith('/reviews')) return undefined;
    const { clientId, ...input } = JSON.parse(init!.body as string);
    expect(clientId).toBe('live-client');
    const retained = h.journal.read();
    expect(retained?.version).toBe(2);
    if (retained?.version !== 2 || retained.application.state !== 'captured')
      throw Error('Intent not captured before POST');
    expect(input).toEqual(retained.application.input);
    if (lost) {
      lost = false;
      throw Error('Review response lost');
    }
    const result = joiningReviewFixture({
      snapshotId: input.selection.requestId,
      sha256: sha256Hex(input.selection.joiningBrief),
      boundary: input.selection.boundary,
      mode: input.selection.mode,
      messages: transcript.messages.filter(
        (m) =>
          m.sequence <= input.selection.boundary.sequence &&
          (input.selection.mode !== 'selected' || input.selection.messageIds.includes(m.messageId)),
      ),
      artifacts: [],
      purpose: input.selection.purpose,
      joiningBrief: input.selection.joiningBrief,
      capacity: { status: 'unverified', reason: 'No native capacity fixture installed' },
    });
    result.settings = {
      binding: h.runtime,
      selection: {
        version: 1,
        agent: input.target.agent,
        context: { source: 'none', revision: null },
        permission: createOrdinaryFreshPermission(input.target.permissionMode),
        model: input.target.model,
        thinking: input.target.reasoningEffort,
      },
      repositoryWorkspaceId: input.target.repositoryWorkspaceId,
    };
    result.expectedMembershipRevision = input.selection.expectedMembershipRevision;
    result.artifactLabels = [];
    return Response.json(result);
  });
  const create = () =>
    createPreparedConversationJoiningOwner({
      api: new MitzoApiClient(auth.apiFetch),
      sourceConversationId: 'source-chat',
      collaborationId: group,
      getClientId: () => 'live-client',
      getVerifiedAuthScope: auth.currentVerifiedAuthSessionId,
      getRepository: () => repository,
      isCurrent: h.options.isCurrent,
    });
  return {
    ...h,
    create,
    owner: create(),
    loseReview: () => {
      lost = true;
    },
    repository: (value: string | null) => {
      repository = value;
    },
    append: () => {
      transcript.messages.push({
        ...structuredClone(transcript.messages[0]),
        messageId: 'message-two',
        sequence: 9,
      });
      transcript.boundary = { sequence: 9, messageId: 'message-two' };
    },
  };
}

it('retains an ordinary preview before observational capture and preserves unverified capacity through actual typed review', async () => {
  const h = harness();
  const hook = renderHook(() => useConversationJoiningReview(h.owner));
  expect(h.transport).not.toHaveBeenCalled();
  await act(() => hook.result.current.prepare(h.request.setup, h.request.joiningBrief));
  expect(hook.result.current.error).toBeNull();
  expect(hook.result.current.review?.snapshot.capacity.status).toBe('unverified');
  expect(hook.result.current.canConfirm).toBe(false);
  const target = h.journal.readTarget()!;
  const record = h.journal.read()!;
  expect(record.version).toBe(2);
  if (record.version !== 2 || record.application.state !== 'captured') throw Error('Not captured');
  expect(record.application.input.target.repositoryWorkspaceId).toBe(target.preview.requestId);
  expect(record.application.input.target.permissionMode).toBe(target.draft.settings.mode);
  const paths = h.transport.mock.calls.map(
    ([url]) => new URL(url, 'https://offline.invalid').pathname,
  );
  expect(paths).not.toContain(`/api/repository-workspaces/${target.preview.requestId}/prepare`);
  expect(paths.indexOf('/api/repository-workspaces/preview')).toBeLessThan(
    paths.indexOf('/api/sessions/source-chat/messages'),
  );
  expect(h.resources.get(target.preview.requestId)?.state).toBe('preview');
  await act(() => hook.result.current.confirm());
  expect(h.transport.mock.calls.some(([url]) => url.includes('/joins'))).toBe(false);
});

it.each(['preview-before', 'preview-after'] as const)(
  'recovers %s through a remounted actual owner without allocating a source',
  async (loss) => {
    const h = harness();
    h.lose(loss);
    const first = renderHook(() => useConversationJoiningReview(h.owner));
    await act(() => first.result.current.prepare(h.request.setup, h.request.joiningBrief));
    const original = h.journal.readTarget()!;
    expect(first.result.current.error).toBeTruthy();
    first.unmount();
    const restored = renderHook(() => useConversationJoiningReview(h.create()));
    await act(() =>
      restored.result.current.prepare(h.request.setup, 'Do not replace the original brief'),
    );
    expect(restored.result.current.error).toBeNull();
    expect(restored.result.current.brief).toBe(h.request.joiningBrief);
    expect(h.journal.readTarget()!.preview).toEqual(original.preview);
    expect(h.journal.readTarget()!.draft.id).toBe(original.draft.id);
    expect(h.posts().filter(([url]) => url.endsWith('/preview'))).toHaveLength(
      loss === 'preview-before' ? 2 : 1,
    );
    if (loss === 'preview-before') {
      const previews = h.posts().filter(([url]) => url.endsWith('/preview'));
      expect(previews[1][1]!.body).toBe(previews[0][1]!.body);
    }
    expect(h.posts().filter(([url]) => url.endsWith('/prepare'))).toHaveLength(0);
    expect(restored.result.current.canConfirm).toBe(false);
  },
);

it('replays only the exact captured review after loss and reload without preparing or recapturing its source', async () => {
  const h = harness();
  h.loseReview();
  const first = renderHook(() => useConversationJoiningReview(h.owner));
  await act(() => first.result.current.prepare(h.request.setup, h.request.joiningBrief));
  const before = h.transport.mock.calls.filter(([url]) => url.endsWith('/reviews'));
  expect(before).toHaveLength(1);
  const original = before[0][1]!.body;
  const preparedCount = h.posts().filter(([url]) => !url.endsWith('/reviews')).length;
  const sourceReads = h.transport.mock.calls.filter(
    ([url]) => url.includes('/api/sessions/') || url.endsWith('/conversation'),
  ).length;
  first.unmount();
  const restored = renderHook(() => useConversationJoiningReview(h.create()));
  await act(() => restored.result.current.prepare(h.request.setup, 'Changed metadata seed'));
  expect(restored.result.current.error).toBeNull();
  expect(h.transport.mock.calls.filter(([url]) => url.endsWith('/reviews'))[1][1]!.body).toBe(
    original,
  );
  expect(h.posts().filter(([url]) => !url.endsWith('/reviews'))).toHaveLength(preparedCount);
  expect(
    h.transport.mock.calls.filter(
      ([url]) => url.includes('/api/sessions/') || url.endsWith('/conversation'),
    ),
  ).toHaveLength(sourceReads);
});

it('recovers the original review after changed execution setup is rejected during uncertain preparation', async () => {
  const h = harness();
  h.lose('prepare-before');
  // An older explicit preparation remains unresolved; observational Review
  // must not replay it or replace its original UUID/draft.
  await expect(prepareConversationJoiningTarget(h.options)).rejects.toThrow();
  const flow = renderHook(() => useConversationJoiningReview(h.owner));
  await act(() => flow.result.current.prepare(h.request.setup, h.request.joiningBrief));
  const original = h.journal.read()!;
  const count = h.transport.mock.calls.length;
  await act(() =>
    flow.result.current.prepare({ ...h.request.setup, runOn: 'openshell' }, 'New intent'),
  );
  expect(h.transport).toHaveBeenCalledTimes(count);
  expect(h.journal.read()!.reviewRequest).toEqual(original.reviewRequest);
  const retained = h.journal.readTarget()!;
  const resource = h.resources.get(retained.preview.requestId)!;
  resource.state = 'ready';
  resource.ordinaryRuntime = structuredClone(h.runtime);
  await act(() => flow.result.current.retryReview());
  expect(flow.result.current.error).toBeNull();
  expect(flow.result.current.setup?.runOn).toBe('local');
  expect(h.journal.read()!.reviewRequest).toEqual(original.reviewRequest);
  expect(h.transport.mock.calls.filter(([url]) => url.endsWith('/reviews'))).toHaveLength(1);
  expect(hookCapacity(flow.result.current)).toBe('unverified');
});

it('keeps capture observational and refuses to reconstruct a target without the original explicit staging action', async () => {
  const h = harness();
  await expect(h.owner.captureReview(h.request, new AbortController().signal)).rejects.toThrow();
  expect(h.transport).not.toHaveBeenCalled();
});

it('refreezes a brief at its original source boundary when the durable conversation grows, without preparing again', async () => {
  const h = harness();
  const flow = renderHook(() => useConversationJoiningReview(h.owner));
  await act(() =>
    flow.result.current.prepare(
      { ...h.request.setup, context: 'conversation_so_far' },
      h.request.joiningBrief,
    ),
  );
  expect(flow.result.current.error).toBeNull();
  const original = structuredClone(flow.result.current.review!.snapshot);
  const originalTarget = structuredClone(h.journal.readTarget()!);
  const prepared = h.posts().filter(([url]) => /\/(preview|prepare)$/.test(url)).length;
  h.append();
  await act(() => flow.result.current.editBrief('Preserve the exact reviewed source.'));
  expect(flow.result.current.error).toBeNull();
  expect(flow.result.current.review!.snapshot.boundary).toEqual(original.boundary);
  expect(flow.result.current.review!.snapshot.messages).toEqual(original.messages);
  expect(h.journal.read()!.reviewRequest.previousSource).toEqual({
    boundary: original.boundary,
    expectedMembershipRevision: 1,
  });
  expect(h.posts().filter(([url]) => /\/(preview|prepare)$/.test(url))).toHaveLength(prepared);
  expect(h.journal.readTarget()!.preview).toEqual(originalTarget.preview);
  expect(h.journal.readTarget()!.draft.id).toBe(originalTarget.draft.id);
  expect(h.resources.get(originalTarget.preview.requestId)?.state).toBe('preview');
  expect(h.posts().filter(([url]) => url.endsWith('/prepare'))).toHaveLength(0);
  expect(flow.result.current.canConfirm).toBe(false);
});

function hookCapacity(flow: ReturnType<typeof useConversationJoiningReview>) {
  return flow.review?.snapshot.capacity.status;
}

it.each(['workspace', 'permission', 'repository', 'unresolved'] as const)(
  'refuses a stored captured review whose fresh target has a conflicting %s',
  async (field) => {
    const h = harness();
    const flow = renderHook(() => useConversationJoiningReview(h.owner));
    await act(() =>
      flow.result.current.prepare(
        { ...h.request.setup, sourceRepository: 'dimakis/mitzo' },
        h.request.joiningBrief,
      ),
    );
    expect(flow.result.current.error).toBeNull();
    const key = Object.keys(sessionStorage).find((key) =>
      key.startsWith(auth.CONVERSATION_JOINING_RECOVERY_PREFIX),
    )!;
    const stored = JSON.parse(sessionStorage.getItem(key)!);
    if (field === 'workspace')
      stored.review.application.input.target.repositoryWorkspaceId = 'another-workspace';
    if (field === 'permission') stored.review.application.input.target.permissionMode = 'auto';
    if (field === 'repository')
      stored.review.reviewRequest.setup.sourceRepository = 'other/repository';
    if (field === 'unresolved') stored.target.phase = 'prepare_pending';
    sessionStorage.setItem(key, JSON.stringify(stored));
    const calls = h.transport.mock.calls.length;
    expect(() => h.journal.read()).toThrow('Captured fresh target identity conflicts');
    await act(() => flow.result.current.confirm());
    expect(h.transport).toHaveBeenCalledTimes(calls);
  },
);
