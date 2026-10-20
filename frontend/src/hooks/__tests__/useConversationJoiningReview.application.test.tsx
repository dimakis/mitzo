// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  COLLABORATION_EXECUTION_DISABLED,
  type CollaborationApplicationReviewInput,
} from '@mitzo/protocol';
import { useConversationJoiningReview } from '../useConversationJoiningReview';
import {
  joiningSetupFixture,
  joiningReviewFixture,
} from '../../preview/conversation-joining-fixture';
import type { ApplicationConversationJoiningOwner } from '../../lib/conversation-joining-review';
import {
  conversationJoiningRecovery,
  joiningReviewFence,
} from '../../lib/conversation-joining-recovery';
import * as auth from '../../lib/api-fetch';

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  auth.markAuthLost();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, authSessionId: 'application-test' })),
  );
  await auth.restoreCookieAuthentication();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const group = '00000000-0000-4000-8000-000000000001';
const otherGroup = '00000000-0000-4000-8000-000000000002';
function port() {
  return {
    kind: 'application' as const,
    collaborationId: group,
    sourceConversationId: 'source-chat',
    captureReview: vi.fn<ApplicationConversationJoiningOwner['captureReview']>(async (input) => ({
      selection: {
        requestId: input.requestId,
        sourceConversationId: 'source-chat',
        expectedMembershipRevision: 1,
        boundary: { sequence: 7, messageId: 'message-one' },
        mode: input.setup.context,
        purpose: input.setup.purpose.trim(),
        messageIds: input.setup.messageIds,
        artifacts: input.setup.artifacts,
        joiningBrief: input.joiningBrief ?? 'Captured brief',
      },
      target: {
        runOn: input.setup.runOn,
        accountId: input.setup.selection!.accountId!,
        model: input.setup.selection!.model,
        reasoningEffort: input.setup.selection!.reasoningEffort ?? null,
        agent: input.setup.agent,
        repositoryWorkspaceId: 'selected-unused-workspace',
        permissionMode: 'ask',
      },
      ...(input.previousSnapshot ? { previousSnapshot: input.previousSnapshot } : {}),
    })),
    // Refusal-only DTO fixtures. Actual successful source/compile/retry is exercised
    // separately through the real SQLite/HTTP/client composition, never fake capacity.
    review: vi.fn<ApplicationConversationJoiningOwner['review']>(async () => {
      throw Error('Response unavailable');
    }),
    confirm: vi.fn<ApplicationConversationJoiningOwner['confirm']>(),
    recover: vi.fn<ApplicationConversationJoiningOwner['recover']>(),
  } satisfies ApplicationConversationJoiningOwner;
}
function retainedApplication() {
  const record = conversationJoiningRecovery('source-chat').read();
  return record?.version === 2 ? record.application : undefined;
}
function defer<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('saves capture_pending before reading and captured before POST, and retries the exact cloned DTO after reload', async () => {
  const p = port();
  p.captureReview.mockImplementationOnce(async (input, signal) => {
    expect(signal.aborted).toBe(false);
    expect(retainedApplication()).toEqual({ state: 'capture_pending', collaborationId: group });
    return port().captureReview(input, signal);
  });
  p.review.mockImplementationOnce(async (input) => {
    expect(retainedApplication()).toEqual({ state: 'captured', collaborationId: group, input });
    input.selection.joiningBrief = 'Callback mutation';
    throw Error('Lost response');
  });
  const first = renderHook(() => useConversationJoiningReview(p));
  await act(() => first.result.current.prepare(joiningSetupFixture()));
  expect(p.captureReview).toHaveBeenCalledTimes(1);
  expect(p.review).toHaveBeenCalledTimes(1);
  first.unmount();
  const retry = renderHook(() => useConversationJoiningReview(p));
  await act(() => retry.result.current.retryReview());
  expect(p.captureReview).toHaveBeenCalledTimes(1);
  expect(p.review.mock.calls[1][0].selection.joiningBrief).toBe('Captured brief');
  expect(retainedApplication()?.state).toBe('captured');
});

it.each([1, 2])('refuses POST when journal write %s fails', async (failedWrite) => {
  const p = port(),
    set = Storage.prototype.setItem;
  let calls = 0;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (++calls === failedWrite) throw Error('Storage unavailable');
    return set.call(this, key, value);
  });
  const hook = renderHook(() => useConversationJoiningReview(p));
  await act(() => hook.result.current.prepare(joiningSetupFixture()));
  expect(p.captureReview).toHaveBeenCalledTimes(failedWrite - 1);
  expect(p.review).not.toHaveBeenCalled();
  expect(hook.result.current.error).toBeTruthy();
});

it.each(['group', 'legacy', 'source', 'auth', 'base'] as const)(
  'fences capture completion after %s changes',
  async (change) => {
    const p = port(),
      pending = defer<CollaborationApplicationReviewInput>();
    const capture = p.captureReview.getMockImplementation()!;
    p.captureReview.mockReturnValueOnce(pending.promise);
    const hook = renderHook(({ owner }) => useConversationJoiningReview(owner), {
      initialProps: {
        owner: p as import('../../lib/conversation-joining-review').ConversationJoiningOwner,
      },
    });
    let running!: Promise<void>;
    act(() => {
      running = hook.result.current.prepare(joiningSetupFixture());
    });
    expect(p.captureReview).toHaveBeenCalledTimes(1);
    const [input, signal] = p.captureReview.mock.calls[0];
    const result = await capture(input, signal);
    const originalBase = import.meta.env.VITE_API_BASE_URL;
    try {
      if (change === 'auth') act(() => auth.markAuthLost());
      else if (change === 'base') import.meta.env.VITE_API_BASE_URL = 'https://different.invalid';
      else
        hook.rerender({
          owner:
            change === 'legacy'
              ? {
                  sourceConversationId: 'source-chat',
                  review: vi.fn(),
                  confirm: p.confirm,
                  recover: p.recover,
                }
              : {
                  ...p,
                  ...(change === 'group'
                    ? { collaborationId: otherGroup }
                    : { sourceConversationId: 'other' }),
                },
        });
      await act(async () => {
        pending.resolve(result);
        await running;
      });
      expect(p.review).not.toHaveBeenCalled();
      const raw = Object.values(sessionStorage).join('');
      expect(raw).not.toContain('"state":"captured"');
    } finally {
      import.meta.env.VITE_API_BASE_URL = originalBase;
    }
  },
);

it.each(['group', 'legacy', 'source'] as const)(
  'refuses captured retry with mismatched %s owner',
  async (change) => {
    const p = port();
    const first = renderHook(() => useConversationJoiningReview(p));
    await act(() => first.result.current.prepare(joiningSetupFixture()));
    first.unmount();
    const legacyReview = vi.fn();
    const next =
      change === 'legacy'
        ? {
            sourceConversationId: 'source-chat',
            review: legacyReview,
            confirm: p.confirm,
            recover: p.recover,
          }
        : {
            ...p,
            ...(change === 'group'
              ? { collaborationId: otherGroup }
              : { sourceConversationId: 'other' }),
          };
    const retry = renderHook(() => useConversationJoiningReview(next));
    await act(() => retry.result.current.retryReview());
    expect(p.captureReview).toHaveBeenCalledTimes(1);
    expect(p.review).toHaveBeenCalledTimes(1);
    expect(legacyReview).not.toHaveBeenCalled();
    expect(p.confirm).not.toHaveBeenCalled();
    expect(p.recover).not.toHaveBeenCalled();
  },
);

it('refuses v1 application retries and only explicitly starts fresh while preserving the edited draft', async () => {
  const p = port(),
    setup = joiningSetupFixture();
  const oldRequestId = '00000000-0000-4000-8000-000000000020';
  conversationJoiningRecovery('source-chat').save(
    {
      version: 1,
      sourceConversationId: 'source-chat',
      reviewRequest: { requestId: oldRequestId, setup, joiningBrief: 'Old edited draft' },
    },
    null,
  );
  const hook = renderHook(() => useConversationJoiningReview(p));
  await act(() => hook.result.current.retryReview());
  await act(() => hook.result.current.prepare(setup));
  expect(p.captureReview).not.toHaveBeenCalled();
  expect(p.review).not.toHaveBeenCalled();
  expect(hook.result.current.brief).toBe('Old edited draft');
  await act(() => hook.result.current.prepareFreshReview(setup));
  expect(p.captureReview).toHaveBeenCalledTimes(1);
  expect(p.captureReview.mock.calls[0][0].requestId).not.toBe(oldRequestId);
  expect(p.captureReview.mock.calls[0][0].joiningBrief).toBe('Old edited draft');
  expect(conversationJoiningRecovery('source-chat').read()?.version).toBe(2);
});

it('requires verified journal adoption before application capture', async () => {
  auth.markAuthLost();
  const p = port();
  const hook = renderHook(() => useConversationJoiningReview(p));
  await act(() => hook.result.current.prepare(joiningSetupFixture()));
  expect(p.captureReview).not.toHaveBeenCalled();
  expect(p.review).not.toHaveBeenCalled();
});

it.each([false, true])(
  'preserves old-v1 submission and join recovery locks without inventing application intent (join=%s)',
  async (withJoin) => {
    const p = port(),
      setup = joiningSetupFixture(),
      oldReview = joiningReviewFixture();
    const snapshot = {
      snapshotId: oldReview.snapshot.snapshotId,
      sha256: oldReview.snapshot.sha256,
    };
    const submission = {
      requestId: '00000000-0000-4000-8000-000000000021',
      name: setup.name,
      expectedMembershipRevision: 1,
      settings: oldReview.settings,
      snapshot,
    };
    const storage = conversationJoiningRecovery('source-chat');
    const original = storage.save(
      {
        version: 1,
        sourceConversationId: 'source-chat',
        reviewRequest: {
          requestId: '00000000-0000-4000-8000-000000000020',
          setup,
          joiningBrief: oldReview.snapshot.joiningBrief,
        },
        acceptedReview: joiningReviewFence(oldReview),
        submission,
        ...(withJoin
          ? {
              join: {
                version: 1,
                joinId: '00000000-0000-4000-8000-000000000022',
                name: setup.name,
                membershipRevision: 1,
                settings: oldReview.settings,
                snapshot,
                allocationOperationId: '00000000-0000-4000-8000-000000000023',
                state: 'pending_preparation',
                sessionId: null,
                linkedFromRevision: null,
                execution: COLLABORATION_EXECUTION_DISABLED,
              },
            }
          : {}),
      },
      null,
    );
    const hook = renderHook(() => useConversationJoiningReview(p));
    await act(() => hook.result.current.retryReview());
    await act(() => hook.result.current.prepareFreshReview(setup));
    await act(() => hook.result.current.confirm());
    await act(() => hook.result.current.recover());
    expect(hook.result.current.locked).toBe(true);
    expect(hook.result.current.error).toBeTruthy();
    expect(storage.read()).toEqual(original);
    expect(p.captureReview).not.toHaveBeenCalled();
    expect(p.review).not.toHaveBeenCalled();
    expect(p.confirm).not.toHaveBeenCalled();
    expect(p.recover).not.toHaveBeenCalled();
  },
);

it('can repeat a pending observational capture after reload without changing its request ID', async () => {
  const p = port();
  p.captureReview.mockRejectedValueOnce(Error('Read response lost'));
  const first = renderHook(() => useConversationJoiningReview(p));
  await act(() => first.result.current.prepare(joiningSetupFixture()));
  expect(p.captureReview).toHaveBeenCalledTimes(1);
  expect(p.review).not.toHaveBeenCalled();
  const original = structuredClone(p.captureReview.mock.calls[0][0]);
  first.unmount();
  const retry = renderHook(() => useConversationJoiningReview(p));
  await act(() => retry.result.current.retryReview());
  expect(p.captureReview.mock.calls[1][0]).toEqual(original);
  expect(p.review).toHaveBeenCalledTimes(1);
});

it('refuses a capture which changes public setup selectors before any POST', async () => {
  const p = port(),
    capture = p.captureReview.getMockImplementation()!;
  p.captureReview.mockImplementationOnce(async (input, signal) => {
    const result = await capture(input, signal);
    result.target.accountId = 'other-account';
    return result;
  });
  const hook = renderHook(() => useConversationJoiningReview(p));
  await act(() => hook.result.current.prepare(joiningSetupFixture()));
  expect(p.captureReview).toHaveBeenCalledTimes(1);
  expect(p.review).not.toHaveBeenCalled();
  expect(hook.result.current.error).toBeTruthy();
});
