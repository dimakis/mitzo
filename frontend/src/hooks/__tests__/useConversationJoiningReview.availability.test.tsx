// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  COLLABORATION_EXECUTION_DISABLED,
  type CollaborationJoin,
  type CollaborationJoinInput,
} from '@mitzo/protocol';
import { useConversationJoiningReview } from '../useConversationJoiningReview';
import * as auth from '../../lib/api-fetch';
import {
  conversationJoiningRecovery,
  joiningReviewFence,
} from '../../lib/conversation-joining-recovery';
import type { LegacyConversationJoiningOwner as ConversationJoiningOwner } from '../../lib/conversation-joining-review';
import {
  joiningReviewFixture,
  joiningSetupFixture,
} from '../../preview/conversation-joining-fixture';

beforeEach(async () => {
  auth.markAuthLost();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, authSessionId: 'offline-login' })),
  );
  await auth.restoreCookieAuthentication();
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function input(): CollaborationJoinInput {
  const review = joiningReviewFixture();
  return {
    requestId: '00000000-0000-4000-8000-000000000021',
    expectedMembershipRevision: 1,
    name: joiningSetupFixture().name,
    settings: review.settings,
    snapshot: { snapshotId: review.snapshot.snapshotId, sha256: review.snapshot.sha256 },
  };
}
function receipt(state: 'allocated' | 'linked' = 'linked'): CollaborationJoin {
  const selected = input();
  return {
    name: selected.name,
    settings: selected.settings,
    snapshot: selected.snapshot,
    version: 1,
    joinId: '00000000-0000-4000-8000-000000000022',
    allocationOperationId: '00000000-0000-4000-8000-000000000023',
    membershipRevision: selected.expectedMembershipRevision,
    state,
    sessionId: 'original-session',
    linkedFromRevision: state === 'linked' ? 1 : null,
    execution: COLLABORATION_EXECUTION_DISABLED,
  };
}
function owner() {
  return {
    sourceConversationId: 'source-chat',
    review: vi.fn<ConversationJoiningOwner['review']>(async () => joiningReviewFixture()),
    confirm: vi.fn<ConversationJoiningOwner['confirm']>(async () => receipt()),
    recover: vi.fn<ConversationJoiningOwner['recover']>(async () => receipt()),
  } satisfies ConversationJoiningOwner;
}
function seed(kind: 'review' | 'uncertain' | 'allocated' | 'linked') {
  const record = {
    version: 1 as const,
    sourceConversationId: 'source-chat',
    reviewRequest: {
      requestId: '00000000-0000-4000-8000-000000000020',
      setup: joiningSetupFixture(),
    },
    ...(kind === 'review'
      ? {}
      : { acceptedReview: joiningReviewFence(joiningReviewFixture()), submission: input() }),
    ...(kind === 'allocated' || kind === 'linked' ? { join: receipt(kind) } : {}),
  };
  conversationJoiningRecovery('source-chat').save(record, null);
  return record;
}

it.each(['review', 'uncertain', 'linked'] as const)(
  'hydrates a late owner’s original %s journal without network or a fresh request',
  async (kind) => {
    const record = seed(kind);
    const port = owner();
    const hook = renderHook(({ port }) => useConversationJoiningReview(port), {
      initialProps: { port: undefined as ConversationJoiningOwner | undefined },
    });
    hook.rerender({ port });
    expect(hook.result.current.setup).toEqual(record.reviewRequest.setup);
    expect(hook.result.current.restoredSetup).toEqual(record.reviewRequest.setup);
    expect(port.review).not.toHaveBeenCalled();
    expect(port.confirm).not.toHaveBeenCalled();
    expect(port.recover).not.toHaveBeenCalled();
    if (kind === 'review') {
      await act(() => hook.result.current.retryReview());
      expect(port.review.mock.calls[0][0]).toEqual(record.reviewRequest);
    } else if (kind === 'uncertain') {
      await act(() => hook.result.current.confirm());
      expect(port.confirm).toHaveBeenCalledWith(input());
    } else {
      expect(hook.result.current.requiresRecovery).toBe(true);
      act(() => expect(hook.result.current.startNew()).toBe(false));
      await act(() => hook.result.current.recover());
      expect(port.recover).toHaveBeenCalledWith(receipt().joinId, expect.any(AbortSignal));
    }
  },
);

it.each(['review', 'uncertain', 'linked'] as const)(
  'adopts the original %s journal once proof arrives after the existing auth event dispatch',
  async (kind) => {
    const record = seed(kind);
    let proof: string | undefined;
    vi.spyOn(auth, 'currentVerifiedAuthSessionId').mockImplementation(() => proof);
    const port = owner();
    const hook = renderHook(() => useConversationJoiningReview(port));
    expect(hook.result.current.canConfirm).toBe(false);
    await act(async () => {
      window.dispatchEvent(new Event(auth.AUTH_RESTORED_EVENT));
      proof = 'offline-login';
      await Promise.resolve();
    });
    expect(hook.result.current.submission).toEqual(record.submission ?? null);
    expect(hook.result.current.join).toEqual(record.join ?? null);
    expect(hook.result.current.restoredSetup).toEqual(record.reviewRequest.setup);
    expect(port.review).not.toHaveBeenCalled();
    expect(port.confirm).not.toHaveBeenCalled();
    if (kind === 'review') {
      await act(() => hook.result.current.retryReview());
      expect(port.review.mock.calls[0][0]).toEqual(record.reviewRequest);
    } else if (kind === 'uncertain') {
      await act(() => hook.result.current.confirm());
      expect(port.confirm).toHaveBeenCalledWith(record.submission);
    } else {
      expect(hook.result.current.requiresRecovery).toBe(true);
      await act(() => hook.result.current.recover());
      expect(port.recover).toHaveBeenCalledWith(receipt().joinId, expect.any(AbortSignal));
    }
  },
);

it('does not clear a corrupt storage block when verified identity or owner availability changes', async () => {
  seed('uncertain');
  const key = sessionStorage.key(0)!;
  sessionStorage.setItem(key, '{broken');
  const port = owner();
  const hook = renderHook(({ port }) => useConversationJoiningReview(port), {
    initialProps: { port: port as ConversationJoiningOwner | undefined },
  });
  hook.rerender({ port: undefined });
  hook.rerender({ port });
  await act(async () => {
    window.dispatchEvent(new Event(auth.AUTH_RESTORED_EVENT));
    await Promise.resolve();
  });
  await act(() => hook.result.current.prepare(joiningSetupFixture()));
  expect(hook.result.current.locked).toBe(true);
  expect(hook.result.current.error).toBeTruthy();
  expect(port.review).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(key)).toBe('{broken');
});

it('never rebinds an invalidated journal after proof returns for the same login label', async () => {
  seed('uncertain');
  const port = owner();
  const hook = renderHook(() => useConversationJoiningReview(port));
  act(() => auth.markAuthLost());
  await act(async () => {
    await auth.restoreCookieAuthentication();
    await Promise.resolve();
  });
  await act(() => hook.result.current.prepare(joiningSetupFixture()));
  await act(() => hook.result.current.confirm());
  expect(hook.result.current.locked).toBe(true);
  expect(hook.result.current.submission).toBeNull();
  expect(port.review).not.toHaveBeenCalled();
  expect(port.confirm).not.toHaveBeenCalled();
  expect(sessionStorage.length).toBe(0);
});

it('fails closed on auth storage read errors and does not later clear that block', async () => {
  const port = owner();
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('Storage disabled');
  });
  const hook = renderHook(() => useConversationJoiningReview(port));
  expect(hook.result.current.locked).toBe(true);
  expect(hook.result.current.error).toBeTruthy();
  get.mockRestore();
  await act(async () => {
    window.dispatchEvent(new Event(auth.AUTH_RESTORED_EVENT));
    await Promise.resolve();
  });
  await act(() => hook.result.current.prepare(joiningSetupFixture()));
  expect(hook.result.current.locked).toBe(true);
  expect(port.review).not.toHaveBeenCalled();
});

it('keeps a competing hook from replacing a newer journal or sending another confirmation', async () => {
  const record = seed('review');
  const firstOwner = owner();
  const secondOwner = owner();
  const first = renderHook(() => useConversationJoiningReview(firstOwner));
  const second = renderHook(() => useConversationJoiningReview(secondOwner));
  await act(() => first.result.current.retryReview());
  await act(() => first.result.current.confirm());
  const retained = conversationJoiningRecovery('source-chat').read();
  await act(() => second.result.current.retryReview());
  await act(() => second.result.current.confirm());
  expect(firstOwner.review.mock.calls[0][0]).toEqual(record.reviewRequest);
  expect(firstOwner.confirm).toHaveBeenCalledTimes(1);
  expect(secondOwner.review).not.toHaveBeenCalled();
  expect(secondOwner.confirm).not.toHaveBeenCalled();
  expect(conversationJoiningRecovery('source-chat').read()).toEqual(retained);
});

it.each(['review', 'confirm', 'recover'] as const)(
  'withholds a deferred %s result after owner loss/change, then retries the original correlation',
  async (phase) => {
    for (const replacement of [undefined, { ...owner(), sourceConversationId: 'other-source' }]) {
      const record = seed(
        phase === 'review' ? 'review' : phase === 'confirm' ? 'uncertain' : 'allocated',
      );
      const port = owner();
      const onLinked = vi.fn();
      let finish!: (raw: unknown) => void;
      port[phase].mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }) as never,
      );
      const hook = renderHook(({ port }) => useConversationJoiningReview(port, onLinked), {
        initialProps: { port: port as ConversationJoiningOwner | undefined },
      });
      let pending!: Promise<void>;
      act(() => {
        pending =
          phase === 'review' ? hook.result.current.retryReview() : hook.result.current[phase]();
      });
      const request = structuredClone(port[phase].mock.calls[0][0]);
      hook.rerender({ port: replacement });
      await act(async () => {
        finish(phase === 'review' ? joiningReviewFixture() : receipt());
        await pending;
      });
      expect(hook.result.current.review).toBeNull();
      expect(hook.result.current.join?.state).not.toBe('linked');
      expect(hook.result.current.pending).toBeNull();
      expect(onLinked).not.toHaveBeenCalled();
      expect(conversationJoiningRecovery('source-chat').read()).toEqual(record);
      hook.rerender({ port });
      await act(() =>
        phase === 'review' ? hook.result.current.retryReview() : hook.result.current[phase](),
      );
      expect(port[phase].mock.calls[1][0]).toEqual(request);
      if (phase === 'review') expect(hook.result.current.canConfirm).toBe(true);
      else expect(hook.result.current.join?.state).toBe('linked');
      hook.unmount();
      sessionStorage.clear();
    }
  },
);

it('accepts an equivalent same-source owner rerender while a request is pending', async () => {
  seed('uncertain');
  const port = owner();
  let finish!: (raw: CollaborationJoin) => void;
  port.confirm.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const hook = renderHook(({ port }) => useConversationJoiningReview(port), {
    initialProps: { port },
  });
  let pending!: Promise<void>;
  act(() => {
    pending = hook.result.current.confirm();
  });
  hook.rerender({ port: { ...port } });
  await act(async () => {
    finish(receipt());
    await pending;
  });
  expect(hook.result.current.join).toEqual(receipt());
});

it('does not retire a linked receipt with a changed linkedFromRevision but accepts allocated-to-linked advancement', async () => {
  seed('linked');
  const port = owner();
  const linked = renderHook(() => useConversationJoiningReview(port));
  port.recover.mockResolvedValueOnce({ ...receipt(), linkedFromRevision: 2 });
  await act(() => linked.result.current.recover());
  expect(linked.result.current.requiresRecovery).toBe(true);
  expect(linked.result.current.error).toBeTruthy();
  act(() => expect(linked.result.current.startNew()).toBe(false));
  linked.unmount();
  sessionStorage.clear();
  seed('allocated');
  const allocated = renderHook(() => useConversationJoiningReview(port));
  port.recover.mockResolvedValueOnce({ ...receipt(), linkedFromRevision: 2 });
  await act(() => allocated.result.current.recover());
  expect(allocated.result.current.join?.linkedFromRevision).toBe(2);
});
