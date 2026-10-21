// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { COLLABORATION_EXECUTION_DISABLED, type CollaborationJoin } from '@mitzo/protocol';
import { useConversationJoiningReview } from '../useConversationJoiningReview';
import {
  joiningReviewFixture,
  joiningSetupFixture,
} from '../../preview/conversation-joining-fixture';
import type { LegacyConversationJoiningOwner as ConversationJoiningOwner } from '../../lib/conversation-joining-review';
import { markAuthLost, restoreCookieAuthentication } from '../../lib/api-fetch';
import {
  retainedArtifact,
  retainedJoiningReviewFixture,
  retainedPin,
} from '../../lib/__tests__/conversation-joining-retained-fixture';

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
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
function owner() {
  const review = vi.fn<ConversationJoiningOwner['review']>(async () => joiningReviewFixture());
  const confirm = vi.fn<ConversationJoiningOwner['confirm']>(async (input) => receipt(input));
  const recover = vi.fn<ConversationJoiningOwner['recover']>(async () => receipt());
  return {
    sourceConversationId: 'source-chat',
    review,
    confirm,
    recover,
  } satisfies ConversationJoiningOwner;
}
function receipt(input?: Parameters<ConversationJoiningOwner['confirm']>[0]): CollaborationJoin {
  const review = joiningReviewFixture();
  return {
    version: 1,
    joinId: '00000000-0000-4000-8000-000000000010',
    name: input?.name ?? 'Reviewer',
    membershipRevision: 1,
    settings: input?.settings ?? review.settings,
    snapshot: input?.snapshot ?? {
      snapshotId: review.snapshot.snapshotId,
      sha256: review.snapshot.sha256,
    },
    allocationOperationId: '00000000-0000-4000-8000-000000000011',
    state: 'pending_preparation',
    sessionId: null,
    linkedFromRevision: null,
    execution: COLLABORATION_EXECUTION_DISABLED,
  };
}

it('keeps both artifact kinds and original retained provenance through review and refreeze', async () => {
  const port = owner();
  const review = retainedJoiningReviewFixture();
  port.review.mockResolvedValueOnce(review);
  const setup = joiningSetupFixture();
  setup.artifacts.push(retainedPin());
  const { result } = renderHook(() => useConversationJoiningReview(port));
  await act(() => result.current.prepare(setup));
  expect(result.current.canConfirm).toBe(true);
  expect(result.current.review?.snapshot.artifacts).toHaveLength(2);
  expect(result.current.review?.snapshot.artifacts[1]).toMatchObject(retainedArtifact);
  const edited = structuredClone(review);
  edited.snapshot.joiningBrief = 'Keep the exact retained revision.';
  edited.snapshot.snapshotId = '00000000-0000-4000-8000-000000000099';
  edited.snapshot.sha256 = 'b'.repeat(64);
  port.review.mockResolvedValueOnce(edited);
  await act(() => result.current.editBrief(edited.snapshot.joiningBrief));
  expect(result.current.canConfirm).toBe(true);
  expect(port.review.mock.calls[1][0].setup.artifacts).toEqual(setup.artifacts);
  expect(result.current.review?.snapshot.sourceConversationId).toBe('source-chat');
  expect(result.current.review?.snapshot.artifacts[1]).not.toHaveProperty('sourceConversationId');
});

it.each(['wrong-kind', 'missing-filename', 'latest-title', 'latest-filename'] as const)(
  'refuses retained review metadata with %s even when the bare pin matches',
  async (change) => {
    const port = owner();
    const review = retainedJoiningReviewFixture();
    if (change === 'wrong-kind') review.artifactLabels!.pop();
    if (change === 'missing-filename') delete review.artifactLabels![1].filename;
    if (change === 'latest-title') review.artifactLabels![1].title = 'Latest r3 title';
    if (change === 'latest-filename') review.artifactLabels![1].filename = 'latest-r3.md';
    port.review.mockResolvedValueOnce(review);
    const setup = joiningSetupFixture();
    setup.artifacts.push(retainedPin());
    const { result } = renderHook(() => useConversationJoiningReview(port));
    await act(() => result.current.prepare(setup));
    expect(result.current.error).toBeTruthy();
    expect(result.current.canConfirm).toBe(false);
    expect(port.confirm).not.toHaveBeenCalled();
  },
);

it.each(['selected', 'conversation_so_far'] as const)(
  'checks extra kind-aware artifact context according to the explicit %s mode',
  async (context) => {
    const port = owner();
    const setup = { ...joiningSetupFixture(), context };
    const response = retainedJoiningReviewFixture();
    response.snapshot.mode = context;
    port.review.mockResolvedValueOnce(response);
    const { result } = renderHook(() => useConversationJoiningReview(port));
    await act(() => result.current.prepare(setup));
    expect(result.current.canConfirm).toBe(context === 'conversation_so_far');
    expect(!!result.current.error).toBe(context === 'selected');
    expect(port.confirm).not.toHaveBeenCalled();
  },
);

it.each(['snapshot', 'both'] as const)(
  'refuses duplicate artifact identities in the selected %s even when counts match',
  async (where) => {
    const port = owner();
    const setup = joiningSetupFixture();
    const response = joiningReviewFixture();
    response.snapshot.artifacts.push(structuredClone(response.snapshot.artifacts[0]));
    if (where === 'both') setup.artifacts.push(structuredClone(setup.artifacts[0]));
    port.review.mockResolvedValueOnce(response);
    const { result } = renderHook(() => useConversationJoiningReview(port));
    await act(() => result.current.prepare(setup));
    expect(result.current.canConfirm).toBe(false);
    expect(result.current.error).toBeTruthy();
  },
);
it('opening a flow performs no read, allocation or confirmation', () => {
  const port = owner();
  const { result } = renderHook(() => useConversationJoiningReview(port));
  expect(result.current.review).toBeNull();
  expect(port.review).not.toHaveBeenCalled();
  expect(port.confirm).not.toHaveBeenCalled();
  expect(port.recover).not.toHaveBeenCalled();
});
it('resumes the same setup when ordinary picker fields have equivalent key ordering', async () => {
  const port = owner();
  const { result } = renderHook(() => useConversationJoiningReview(port));
  const setup = joiningSetupFixture();
  await act(() => result.current.prepare(setup));
  const reordered = {
    ...setup,
    selection: {
      reasoningEffort: setup.selection!.reasoningEffort,
      model: setup.selection!.model,
      accountId: setup.selection!.accountId,
    },
  };
  expect(result.current.hasAttemptFor(reordered)).toBe(true);
  await act(() => result.current.prepare(reordered));
  expect(port.review).toHaveBeenCalledTimes(1);
  expect(result.current.review?.snapshot.snapshotId).toBe(
    joiningReviewFixture().snapshot.snapshotId,
  );
});
it('reviews and confirms on supported remote HTTP without randomUUID or SubtleCrypto', async () => {
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  vi.stubGlobal('crypto', { getRandomValues });
  const port = owner();
  const { result } = renderHook(() => useConversationJoiningReview(port));
  await act(() => result.current.prepare(joiningSetupFixture()));
  expect(result.current.canConfirm).toBe(true);
  await act(() => result.current.confirm());
  expect(port.review.mock.calls[0][0].requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(port.confirm.mock.calls[0][0].requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(result.current.join?.state).toBe('pending_preparation');
});
it('replays the same review request after a lost response; explicit edits create a distinct request', async () => {
  const port = owner();
  port.review.mockRejectedValueOnce(new Error('Saved response was lost'));
  const { result } = renderHook(() => useConversationJoiningReview(port));
  await act(() => result.current.prepare(joiningSetupFixture()));
  const first = structuredClone(port.review.mock.calls[0][0]);
  await act(() => result.current.retryReview());
  expect(port.review.mock.calls[1][0]).toEqual(first);
  port.review.mockRejectedValueOnce(new Error('Saved refreeze response was lost'));
  await act(() => result.current.editBrief('New reviewed brief.'));
  const edited = structuredClone(port.review.mock.calls[2][0]);
  expect(edited.requestId).not.toBe(first.requestId);
  expect(edited.previousSnapshot).toEqual({
    snapshotId: joiningReviewFixture().snapshot.snapshotId,
    sha256: joiningReviewFixture().snapshot.sha256,
  });
  port.review.mockResolvedValueOnce(
    joiningReviewFixture({
      joiningBrief: 'New reviewed brief.',
      snapshotId: '00000000-0000-4000-8000-000000000002',
      sha256: 'b'.repeat(64),
    }),
  );
  await act(() => result.current.retryReview());
  expect(port.review.mock.calls[3][0]).toEqual(edited);
  expect(result.current.canConfirm).toBe(true);
});
it('confirms only the exact frozen snapshot, ordinary settings and membership revision', async () => {
  const port = owner();
  const { result } = renderHook(() => useConversationJoiningReview(port));
  await act(() => result.current.prepare(joiningSetupFixture()));
  expect(result.current.canConfirm).toBe(true);
  await act(() => result.current.confirm());
  expect(port.confirm).toHaveBeenCalledTimes(1);
  const submitted = port.confirm.mock.calls[0][0];
  expect(submitted).toMatchObject({
    name: 'Reviewer',
    expectedMembershipRevision: 1,
    settings: joiningReviewFixture().settings,
    snapshot: {
      snapshotId: joiningReviewFixture().snapshot.snapshotId,
      sha256: joiningReviewFixture().snapshot.sha256,
    },
  });
  expect(result.current.join?.state).toBe('pending_preparation');
  expect(result.current.canConfirm).toBe(false);
});
it.each(['unverified', 'refused', 'needs_reviewed_summary'] as const)(
  'keeps %s capacity unavailable for confirmation',
  async (status) => {
    const port = owner();
    port.review.mockResolvedValue(
      joiningReviewFixture({ capacity: { status, reason: 'Choose less context.' } }),
    );
    const { result } = renderHook(() => useConversationJoiningReview(port));
    await act(() => result.current.prepare(joiningSetupFixture()));
    expect(result.current.canConfirm).toBe(false);
    await act(() => result.current.confirm());
    expect(port.confirm).not.toHaveBeenCalled();
  },
);
it('invalidates an edited brief immediately and freezes a new object before confirmation', async () => {
  const port = owner();
  const { result } = renderHook(() => useConversationJoiningReview(port));
  await act(() => result.current.prepare(joiningSetupFixture()));
  let finish!: (value: ReturnType<typeof joiningReviewFixture>) => void;
  port.review.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => {
    void result.current.editBrief('Check recovery too.');
  });
  expect(result.current.canConfirm).toBe(false);
  expect(result.current.brief).toBe('Check recovery too.');
  await act(() => result.current.confirm());
  expect(port.confirm).not.toHaveBeenCalled();
  const revised = joiningReviewFixture({
    snapshotId: '00000000-0000-4000-8000-000000000002',
    sha256: 'b'.repeat(64),
    joiningBrief: 'Check recovery too.',
  });
  await act(async () => finish(revised));
  await waitFor(() => expect(result.current.canConfirm).toBe(true));
  await act(() => result.current.confirm());
  expect(port.confirm.mock.calls[0][0].snapshot).toEqual({
    snapshotId: revised.snapshot.snapshotId,
    sha256: revised.snapshot.sha256,
  });
  expect(port.review.mock.calls[1][0]).toMatchObject({
    joiningBrief: 'Check recovery too.',
    previousSnapshot: {
      snapshotId: joiningReviewFixture().snapshot.snapshotId,
      sha256: joiningReviewFixture().snapshot.sha256,
    },
  });
});
it('ignores a superseded refreeze response and keeps the latest edit', async () => {
  const port = owner();
  const { result } = renderHook(() => useConversationJoiningReview(port));
  await act(() => result.current.prepare(joiningSetupFixture()));
  let finish!: (value: ReturnType<typeof joiningReviewFixture>) => void;
  port.review.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => {
    void result.current.editBrief('Earlier edit');
  });
  port.review.mockResolvedValueOnce(
    joiningReviewFixture({
      joiningBrief: 'Latest edit',
      snapshotId: '00000000-0000-4000-8000-000000000003',
      sha256: 'c'.repeat(64),
    }),
  );
  await act(() => result.current.editBrief('Latest edit'));
  await act(async () =>
    finish(
      joiningReviewFixture({
        joiningBrief: 'Earlier edit',
        snapshotId: '00000000-0000-4000-8000-000000000002',
        sha256: 'b'.repeat(64),
      }),
    ),
  );
  expect(result.current.brief).toBe('Latest edit');
  expect(result.current.review?.snapshot.joiningBrief).toBe('Latest edit');
});
it.each(['target', 'source', 'brief'] as const)(
  'rejects a refreeze that changes the %s',
  async (kind) => {
    const port = owner();
    const { result } = renderHook(() => useConversationJoiningReview(port));
    await act(() => result.current.prepare(joiningSetupFixture()));
    const changed = joiningReviewFixture({
      joiningBrief: 'New brief',
      snapshotId: '00000000-0000-4000-8000-000000000002',
      sha256: 'b'.repeat(64),
    });
    if (kind === 'target') changed.settings.binding.execution.targetRevision = 'different-target';
    if (kind === 'source') changed.snapshot.messages[0].blocks[0].content = 'Changed source';
    if (kind === 'brief') changed.snapshot.joiningBrief = 'Wrong brief';
    port.review.mockResolvedValueOnce(changed);
    await act(() => result.current.editBrief('New brief'));
    expect(result.current.canConfirm).toBe(false);
    expect(result.current.error).toBeTruthy();
    expect(result.current.brief).toBe('New brief');
  },
);
it('retries uncertain confirmation with the same operation and never starts a replacement join', async () => {
  const port = owner();
  port.confirm.mockRejectedValueOnce(new Error('Connection lost'));
  const { result } = renderHook(() => useConversationJoiningReview(port));
  await act(() => result.current.prepare(joiningSetupFixture()));
  await act(() => result.current.confirm());
  expect(result.current.uncertain).toBe(true);
  const submitted = port.confirm.mock.calls[0][0];
  await act(() => result.current.editBrief('Must not replace an uncertain operation'));
  await act(() => result.current.prepare({ ...joiningSetupFixture(), name: 'Different agent' }));
  expect(port.review).toHaveBeenCalledTimes(1);
  await act(() => result.current.confirm());
  expect(port.confirm.mock.calls[1][0]).toEqual(submitted);
  expect(result.current.join?.name).toBe('Reviewer');
});
it('rechecks a known pending join through its original join ID and fences mismatched receipts', async () => {
  const port = owner();
  const { result } = renderHook(() => useConversationJoiningReview(port));
  await act(() => result.current.prepare(joiningSetupFixture()));
  await act(() => result.current.confirm());
  port.recover.mockResolvedValueOnce({
    ...receipt(),
    joinId: '00000000-0000-4000-8000-000000000099',
  });
  await act(() => result.current.recover());
  expect(port.recover).toHaveBeenCalledWith(receipt().joinId, expect.any(AbortSignal));
  expect(result.current.join?.joinId).toBe(receipt().joinId);
  expect(result.current.error).toBeTruthy();
  expect(port.confirm).toHaveBeenCalledTimes(1);
});

it.each(['missing', 'wrong-version', 'blank-title'] as const)(
  'refuses %s display metadata for included saved content',
  async (kind) => {
    const port = owner();
    const invalid = joiningReviewFixture();
    if (kind === 'missing') invalid.artifactLabels = [];
    if (kind === 'wrong-version') invalid.artifactLabels![0].revision = 3;
    if (kind === 'blank-title') invalid.artifactLabels![0].title = '  ';
    port.review.mockResolvedValueOnce(invalid);
    const { result } = renderHook(() => useConversationJoiningReview(port));
    await act(() => result.current.prepare(joiningSetupFixture()));
    expect(result.current.canConfirm).toBe(false);
    expect(result.current.error).toBeTruthy();
    expect(port.confirm).not.toHaveBeenCalled();
  },
);

it('starts another fresh intent only after the exact joining receipt becomes linked', async () => {
  const port = owner();
  const { result } = renderHook(() => useConversationJoiningReview(port));
  await act(() => result.current.prepare(joiningSetupFixture()));
  await act(() => result.current.confirm());
  const first = port.confirm.mock.calls[0][0];
  act(() => {
    expect(result.current.startNew()).toBe(false);
  });
  port.recover.mockResolvedValueOnce({
    ...receipt(first),
    state: 'linked',
    sessionId: 'fresh-chat',
    linkedFromRevision: 1,
  });
  await act(() => result.current.recover());
  act(() => {
    expect(result.current.startNew()).toBe(true);
  });
  await act(() => result.current.prepare({ ...joiningSetupFixture(), name: 'Reviewer2' }));
  await act(() => result.current.confirm());
  const second = port.confirm.mock.calls[1][0];
  expect(second.name).toBe('Reviewer2');
  expect(second.requestId).not.toBe(first.requestId);
});

it('retains an uncertain operation when the owner is rerendered and never lends it to another source', async () => {
  const port = owner();
  port.confirm.mockRejectedValueOnce(new Error('Lost acknowledgement'));
  const { result, rerender } = renderHook(({ port }) => useConversationJoiningReview(port), {
    initialProps: { port },
  });
  await act(() => result.current.prepare(joiningSetupFixture()));
  await act(() => result.current.confirm());
  const original = port.confirm.mock.calls[0][0];
  rerender({ port: { ...port, sourceConversationId: 'another-chat' } });
  await act(() => result.current.confirm());
  expect(port.confirm).toHaveBeenCalledTimes(1);
  rerender({ port: { ...port } });
  await act(() => result.current.confirm());
  expect(port.confirm.mock.calls[1][0]).toEqual(original);
});
