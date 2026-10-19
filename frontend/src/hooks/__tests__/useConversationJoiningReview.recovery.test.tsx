// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { COLLABORATION_EXECUTION_DISABLED, type CollaborationJoinInput } from '@mitzo/protocol';
import { useConversationJoiningReview } from '../useConversationJoiningReview';
import {
  joiningReviewFixture,
  joiningSetupFixture,
} from '../../preview/conversation-joining-fixture';
import type { LegacyConversationJoiningOwner as ConversationJoiningOwner } from '../../lib/conversation-joining-review';
import { markAuthLost, restoreCookieAuthentication } from '../../lib/api-fetch';

beforeEach(async () => {
  markAuthLost();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, authSessionId: 'offline-login' })),
  );
  await restoreCookieAuthentication();
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function joiningReceipt(input: CollaborationJoinInput) {
  return {
    version: 1 as const,
    joinId: '00000000-0000-4000-8000-000000000010',
    name: input.name,
    membershipRevision: input.expectedMembershipRevision,
    settings: input.settings,
    snapshot: input.snapshot,
    allocationOperationId: '00000000-0000-4000-8000-000000000011',
    state: 'pending_preparation' as const,
    sessionId: null,
    linkedFromRevision: null,
    execution: COLLABORATION_EXECUTION_DISABLED,
  };
}

function owner() {
  return {
    sourceConversationId: 'source-chat',
    review: vi.fn<ConversationJoiningOwner['review']>(async () => joiningReviewFixture()),
    confirm: vi.fn<ConversationJoiningOwner['confirm']>(async (input) => joiningReceipt(input)),
    recover: vi.fn<ConversationJoiningOwner['recover']>(),
  } satisfies ConversationJoiningOwner;
}

it('preserves the original confirmation after a lost response and route remount', async () => {
  const port = owner();
  port.confirm.mockRejectedValueOnce(new Error('Server committed; response lost'));
  const first = renderHook(() => useConversationJoiningReview(port));
  await act(() => first.result.current.prepare(joiningSetupFixture()));
  await act(() => first.result.current.confirm());
  const original = structuredClone(first.result.current.submission!);
  expect(first.result.current.uncertain).toBe(true);
  first.unmount();

  const reopened = renderHook(() => useConversationJoiningReview({ ...port }));
  expect(reopened.result.current.submission).toEqual(original);
  expect(reopened.result.current.locked).toBe(true);
  await act(() => reopened.result.current.prepare(joiningSetupFixture()));
  await act(() => reopened.result.current.confirm());
  expect(port.review).toHaveBeenCalledTimes(1);
  expect(port.confirm.mock.calls[1][0]).toEqual(original);
});

it('replays a lost review through its original request after remount', async () => {
  const port = owner();
  port.review.mockRejectedValueOnce(new Error('Saved review response lost'));
  const first = renderHook(() => useConversationJoiningReview(port));
  await act(() => first.result.current.prepare(joiningSetupFixture()));
  const original = structuredClone(port.review.mock.calls[0][0]);
  first.unmount();

  const reopened = renderHook(() => useConversationJoiningReview({ ...port }));
  expect(reopened.result.current.canConfirm).toBe(false);
  expect(port.review).toHaveBeenCalledTimes(1);
  await act(() => reopened.result.current.prepare(joiningSetupFixture()));
  expect(port.review.mock.calls[1][0]).toEqual(original);
  expect(reopened.result.current.canConfirm).toBe(true);
});

it('restores an edited brief and exact refreeze request with equivalent setup key ordering', async () => {
  const port = owner();
  const first = renderHook(() => useConversationJoiningReview(port));
  const setup = joiningSetupFixture();
  await act(() => first.result.current.prepare(setup));
  port.review.mockRejectedValueOnce(new Error('Saved refreeze response lost'));
  await act(() => first.result.current.editBrief('Keep this exact edited joining brief.'));
  const original = structuredClone(port.review.mock.calls[1][0]);
  first.unmount();
  port.review.mockResolvedValueOnce(
    joiningReviewFixture({
      joiningBrief: original.joiningBrief!,
      snapshotId: '00000000-0000-4000-8000-000000000002',
      sha256: 'b'.repeat(64),
    }),
  );
  const reopened = renderHook(() => useConversationJoiningReview({ ...port }));
  expect(reopened.result.current.brief).toBe(original.joiningBrief);
  await act(() =>
    reopened.result.current.prepare({
      ...setup,
      selection: {
        reasoningEffort: setup.selection!.reasoningEffort,
        model: setup.selection!.model,
        accountId: setup.selection!.accountId,
      },
    }),
  );
  expect(port.review.mock.calls[2][0]).toEqual(original);
  expect(reopened.result.current.canConfirm).toBe(true);
});

it('recovers the retained join before allowing another confirmation or setup', async () => {
  const port = owner();
  const first = renderHook(() => useConversationJoiningReview(port));
  await act(() => first.result.current.prepare(joiningSetupFixture()));
  await act(() => first.result.current.confirm());
  const original = structuredClone(first.result.current.submission!);
  const retained = structuredClone(first.result.current.join!);
  first.unmount();
  const reopened = renderHook(() => useConversationJoiningReview({ ...port }));
  expect(reopened.result.current.join).toEqual(retained);
  await act(() => reopened.result.current.prepare({ ...joiningSetupFixture(), name: 'Other' }));
  await act(() => reopened.result.current.confirm());
  expect(port.confirm).toHaveBeenCalledTimes(1);
  expect(port.review).toHaveBeenCalledTimes(1);
  port.recover.mockResolvedValueOnce({
    ...joiningReceipt(original),
    state: 'allocated',
    sessionId: 'original-allocated-chat',
  });
  await act(() => reopened.result.current.recover());
  expect(port.recover).toHaveBeenCalledWith(retained.joinId, expect.any(AbortSignal));
  expect(reopened.result.current.join?.sessionId).toBe('original-allocated-chat');
  act(() => expect(reopened.result.current.startNew()).toBe(false));
});

it('does not restore capacity readiness from a completed retained review', async () => {
  const port = owner();
  const first = renderHook(() => useConversationJoiningReview(port));
  await act(() => first.result.current.prepare(joiningSetupFixture()));
  const original = structuredClone(port.review.mock.calls[0][0]);
  expect(first.result.current.canConfirm).toBe(true);
  first.unmount();
  const reopened = renderHook(() => useConversationJoiningReview(port));
  expect(reopened.result.current.review).toBeNull();
  expect(reopened.result.current.canConfirm).toBe(false);
  await act(() => reopened.result.current.confirm());
  expect(port.confirm).not.toHaveBeenCalled();
  port.review.mockRejectedValueOnce(new Error('Current authority unavailable'));
  await act(() => reopened.result.current.retryReview());
  expect(port.review.mock.calls[1][0]).toEqual(original);
  expect(reopened.result.current.canConfirm).toBe(false);
});

it('crosses no confirmation boundary when retaining its exact request fails', async () => {
  const port = owner();
  const first = renderHook(() => useConversationJoiningReview(port));
  await act(() => first.result.current.prepare(joiningSetupFixture()));
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Quota exceeded');
  });
  await act(() => first.result.current.confirm());
  expect(port.confirm).not.toHaveBeenCalled();
  expect(first.result.current.locked).toBe(true);
  expect(first.result.current.uncertain).toBe(true);
  const original = structuredClone(first.result.current.submission!);
  vi.restoreAllMocks();
  await act(() => first.result.current.confirm());
  expect(port.confirm).toHaveBeenCalledWith(original);
});

it('requires a fresh server linked receipt before retiring a retained linked join', async () => {
  const port = owner();
  port.confirm.mockImplementation(async (input) => ({
    ...joiningReceipt(input),
    state: 'linked',
    sessionId: 'original-allocated-chat',
    linkedFromRevision: input.expectedMembershipRevision,
  }));
  const first = renderHook(() => useConversationJoiningReview(port));
  await act(() => first.result.current.prepare(joiningSetupFixture()));
  await act(() => first.result.current.confirm());
  const linked = first.result.current.join!;
  first.unmount();
  const reopened = renderHook(() => useConversationJoiningReview(port));
  act(() => expect(reopened.result.current.startNew()).toBe(false));
  expect(sessionStorage.length).toBe(1);
  port.recover.mockResolvedValueOnce(linked);
  await act(() => reopened.result.current.recover());
  act(() => expect(reopened.result.current.startNew()).toBe(true));
  expect(sessionStorage.length).toBe(0);
});

it('offers no in-memory joining fallback when an older server supplies no verified session identity', async () => {
  markAuthLost();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true })),
  );
  expect(await restoreCookieAuthentication()).toBe(true);
  const port = owner();
  const first = renderHook(() => useConversationJoiningReview(port));
  await act(() => first.result.current.prepare(joiningSetupFixture()));
  await act(() => first.result.current.confirm());
  expect(first.result.current.locked).toBe(true);
  expect(first.result.current.canConfirm).toBe(false);
  expect(port.review).not.toHaveBeenCalled();
  expect(port.confirm).not.toHaveBeenCalled();
});

it('ignores a late confirmation receipt after the authenticated login is lost', async () => {
  const port = owner();
  let finish!: (join: Awaited<ReturnType<ConversationJoiningOwner['confirm']>>) => void;
  port.confirm.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const onLinked = vi.fn();
  const first = renderHook(() => useConversationJoiningReview(port, onLinked));
  await act(() => first.result.current.prepare(joiningSetupFixture()));
  let pending!: Promise<void>;
  act(() => {
    pending = first.result.current.confirm();
  });
  const original = first.result.current.submission!;
  act(() => markAuthLost());
  await act(async () => {
    finish({
      ...joiningReceipt(original),
      state: 'linked',
      sessionId: 'old-login-chat',
      linkedFromRevision: original.expectedMembershipRevision,
    });
    await pending;
  });
  expect(first.result.current.join).toBeNull();
  expect(first.result.current.locked).toBe(true);
  expect(onLinked).not.toHaveBeenCalled();
  expect(sessionStorage.length).toBe(0);
});

it('does not recover a known join through a corrupt or replaced retained operation', async () => {
  const port = owner();
  const first = renderHook(() => useConversationJoiningReview(port));
  await act(() => first.result.current.prepare(joiningSetupFixture()));
  await act(() => first.result.current.confirm());
  const key = sessionStorage.key(0)!;
  sessionStorage.setItem(key, '{broken');
  await act(() => first.result.current.recover());
  expect(port.recover).not.toHaveBeenCalled();
  expect(first.result.current.join?.state).toBe('pending_preparation');
  expect(sessionStorage.getItem(key)).toBe('{broken');
});
