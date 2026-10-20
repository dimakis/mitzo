// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  joiningReviewFixture,
  joiningSetupFixture,
} from '../../preview/conversation-joining-fixture';
import {
  conversationJoiningRecovery,
  joiningReviewFence,
} from '../../lib/conversation-joining-recovery';
import type {
  ApplicationConversationJoiningOwner,
  ConversationJoiningOwner,
} from '../../lib/conversation-joining-review';
import { markAuthLost, restoreCookieAuthentication } from '../../lib/api-fetch';
import { useConversationJoiningReview } from '../useConversationJoiningReview';

beforeEach(async () => {
  sessionStorage.clear();
  localStorage.clear();
  markAuthLost();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, authSessionId: 'receipt-test' })),
  );
  await restoreCookieAuthentication();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Public validation DTO only, explicitly UNVERIFIED. No capacity or successful
// application composition is inferred from these hook/journal substitution cases.
function receipt() {
  const result = joiningReviewFixture({
    capacity: { status: 'unverified', reason: 'No native capacity owner' },
    joiningBrief: 'Exact brief',
  });
  result.settings.selection.permission.mode = 'ask';
  return result;
}
function owner(): ApplicationConversationJoiningOwner {
  const result = receipt();
  return {
    kind: 'application',
    sourceConversationId: 'source-chat',
    collaborationId: '00000000-0000-4000-8000-000000000010',
    captureReview: vi.fn<ApplicationConversationJoiningOwner['captureReview']>(async (input) => ({
      selection: {
        requestId: input.requestId,
        expectedMembershipRevision: 1,
        sourceConversationId: 'source-chat',
        boundary: result.snapshot.boundary,
        mode: input.setup.context,
        messageIds: input.setup.messageIds,
        artifacts: input.setup.artifacts,
        purpose: input.setup.purpose.trim(),
        joiningBrief: input.joiningBrief ?? 'Exact brief',
      },
      target: {
        runOn: 'local',
        accountId: input.setup.selection!.accountId!,
        model: input.setup.selection!.model,
        reasoningEffort: null,
        agent: input.setup.agent,
        repositoryWorkspaceId: result.settings.repositoryWorkspaceId,
        permissionMode: 'ask',
      },
      ...(input.previousSnapshot ? { previousSnapshot: input.previousSnapshot } : {}),
    })),
    review: vi.fn(async () => structuredClone(result)),
    confirm: vi.fn(),
    recover: vi.fn(),
  };
}

it.each(['snapshotId', 'sha256', 'source', 'settings', 'membership', 'removed'] as const)(
  'journal refuses same-request accepted application receipt %s substitution',
  async (change) => {
    const p = owner();
    const hook = renderHook(() => useConversationJoiningReview(p));
    await act(() => hook.result.current.prepare(joiningSetupFixture()));
    expect(hook.result.current.review?.snapshot.capacity.status).toBe('unverified');
    const storage = conversationJoiningRecovery('source-chat'),
      original = storage.read()!;
    expect(original.acceptedReview).toEqual(joiningReviewFence(receipt()));
    const next = structuredClone(original);
    if (change === 'snapshotId')
      next.acceptedReview!.snapshot.snapshotId = '00000000-0000-4000-8000-000000000011';
    if (change === 'sha256') next.acceptedReview!.snapshot.sha256 = 'b'.repeat(64);
    if (change === 'source') next.acceptedReview!.sourceSha256 = 'c'.repeat(64);
    if (change === 'settings')
      next.acceptedReview!.settings.binding.account.profileRevision = 'different-revision';
    if (change === 'membership') next.acceptedReview!.expectedMembershipRevision++;
    if (change === 'removed') delete next.acceptedReview;
    expect(() => storage.save(next, original)).toThrow(
      'Original application review receipt must be recovered',
    );
    expect(storage.read()).toEqual(original);
  },
);

it.each(['snapshot', 'source', 'settings'] as const)(
  'actual hook refuses changed %s receipt after remount while replaying captured input',
  async (change) => {
    const p = owner();
    const first = renderHook(() => useConversationJoiningReview(p));
    await act(() => first.result.current.prepare(joiningSetupFixture()));
    expect(first.result.current.review?.snapshot.capacity.status).toBe('unverified');
    const storage = conversationJoiningRecovery('source-chat'),
      original = storage.read()!;
    first.unmount();
    const changed = receipt();
    if (change === 'snapshot') {
      changed.snapshot.snapshotId = '00000000-0000-4000-8000-000000000011';
      changed.snapshot.sha256 = 'b'.repeat(64);
    }
    if (change === 'source')
      changed.snapshot.messages[0].blocks[0].content = 'Changed retained source';
    if (change === 'settings')
      changed.settings.binding.account.profileRevision = 'different-revision';
    vi.mocked(p.review).mockResolvedValueOnce(changed);
    const retry = renderHook(() => useConversationJoiningReview(p));
    await act(() => retry.result.current.retryReview());
    expect(vi.mocked(p.captureReview)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(p.review).mock.calls[1][0]).toEqual(vi.mocked(p.review).mock.calls[0][0]);
    expect(storage.read()).toEqual(original);
    expect(retry.result.current.review).toBeNull();
    expect(retry.result.current.error).toBeTruthy();
    expect(retry.result.current.canConfirm).toBe(false);
    expect(p.confirm).not.toHaveBeenCalled();
    expect(p.recover).not.toHaveBeenCalled();
  },
);

it.each(['group', 'legacy', 'source'] as const)(
  'refuses pending application POST adoption after %s owner change',
  async (change) => {
    const p = owner();
    let resolve!: (value: ReturnType<typeof receipt>) => void;
    vi.mocked(p.review).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const hook = renderHook(({ port }) => useConversationJoiningReview(port), {
      initialProps: { port: p as ConversationJoiningOwner },
    });
    let running!: Promise<void>;
    await act(async () => {
      running = hook.result.current.prepare(joiningSetupFixture());
    });
    expect(p.review).toHaveBeenCalledTimes(1);
    const storage = conversationJoiningRecovery('source-chat'),
      before = storage.read();
    expect(before?.acceptedReview).toBeUndefined();
    const next: ConversationJoiningOwner =
      change === 'legacy'
        ? {
            sourceConversationId: p.sourceConversationId,
            review: vi.fn(),
            confirm: p.confirm,
            recover: p.recover,
          }
        : {
            ...p,
            ...(change === 'group'
              ? { collaborationId: '00000000-0000-4000-8000-000000000012' }
              : { sourceConversationId: 'other-source' }),
          };
    hook.rerender({ port: next });
    await act(async () => {
      resolve(receipt());
      await running;
    });
    expect(storage.read()).toEqual(before);
    expect(hook.result.current.review).toBeNull();
    expect(hook.result.current.canConfirm).toBe(false);
    expect(p.confirm).not.toHaveBeenCalled();
    expect(p.recover).not.toHaveBeenCalled();
  },
);
