// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  TelosWorkRoleContextSelectionSchema,
  TelosWorkCommandReceiptSchema,
  type CollaborationSettings,
  type TelosWorkRoleSetupInput,
  type TelosWorkCommandReceipt,
  type TelosWorkView,
} from '@mitzo/protocol';
import { useTelosRoleSetup } from '../useTelosRoleSetup';
import type { TelosRoleSetupOptions } from '../useTelosRoleSetup';

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  localStorage.clear();
});

it('retains the request before POST and binds only the explicitly confirmed role conversation', async () => {
  const f = fixture();
  f.api.setupRole.mockImplementationOnce(async (input) => {
    expect(
      JSON.parse(localStorage.getItem('mitzo-telos-role-setup:ordinary-draft')!).submission,
    ).toEqual(input);
    return TelosWorkCommandReceiptSchema.parse({
      commandId: 'confirmed',
      actorId: 'operator:actual',
      work: {
        itemId: 'item',
        kind: null,
        parentId: null,
        revision: 'c'.repeat(64),
        sources: [],
        attempts: [],
        links: [
          {
            version: 1,
            linkId: 'new-lead-link',
            itemId: 'item',
            role: 'lead',
            conversation: { namespace: 'mitzo', conversationId: 'ordinary-lead' },
            linkedAt: null,
            linkedBy: 'operator:actual',
            availability: 'available',
            attemptId: null,
          },
        ],
        assignments: [
          {
            itemId: 'item',
            role: 'lead',
            conversation: { namespace: 'mitzo', conversationId: 'ordinary-lead' },
            revision: 1,
            assignedAt: null,
            assignedBy: 'operator:actual',
          },
        ],
      },
    });
  });
  const { result } = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => result.current.review());
  expect(f.onBound).not.toHaveBeenCalled();
  await act(async () => result.current.confirm());
  expect(f.onBound).toHaveBeenCalledExactlyOnceWith('ordinary-lead');
  expect(result.current.boundConversationId).toBe('ordinary-lead');
  expect(result.current.uncertain).toBe(false);
});

it('refuses the setup POST when the exact original request cannot be durably saved', async () => {
  const f = fixture();
  const { result } = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => result.current.review());
  vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
    throw new Error('device storage full');
  });
  await act(async () => result.current.confirm());
  expect(f.api.setupRole).not.toHaveBeenCalled();
  expect(f.onBound).not.toHaveBeenCalled();
  expect(result.current.locked).toBe(true);
  expect(result.current.error).toContain('has not been sent');
});
const revision = 'a'.repeat(64);
const settings: CollaborationSettings = {
  binding: {
    version: 2,
    account: { accountId: 'offline', provider: 'openai-codex', profileRevision: 'r1' },
    harness: { implementation: 'codex' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'r1' },
  },
  repositoryWorkspaceId: 'f642a9e8-7caf-432c-829e-f547a7359e47',
  selection: {
    version: 1,
    agent: { profileId: 'agent', revision: 1 },
    context: { source: 'none', revision: null },
    permission: { mode: 'agent', revision: 0 },
    model: 'offline-fixture',
    thinking: null,
  },
};
const context = TelosWorkRoleContextSelectionSchema.parse({
  version: 1,
  itemId: 'item',
  role: 'lead',
  brief: { revision, sha256: 'b'.repeat(64), text: 'Reviewed work' },
  parentCriteria: [],
  overallGoal: { itemId: 'item', revision, text: 'Goal' },
  sources: [],
  artifacts: [],
});
function fixture() {
  const api = {
    roleContext: vi.fn<TelosRoleSetupOptions['api']['roleContext']>(async () =>
      structuredClone(context),
    ),
    read: vi.fn<TelosRoleSetupOptions['api']['read']>(async (): Promise<TelosWorkView> => ({
      itemId: 'item',
      kind: null,
      parentId: null,
      revision,
      links: [],
      assignments: [],
      sources: [],
      attempts: [],
    })),
    setupRole: vi.fn(async (_input: TelosWorkRoleSetupInput): Promise<TelosWorkCommandReceipt> => {
      throw new Error('response lost');
    }),
  };
  const onBound = vi.fn();
  const options = {
    draftId: 'ordinary-draft',
    intent: { itemId: 'item', role: 'lead' as const, mode: 'assign' as const },
    settings: structuredClone(settings),
    api,
    onBound,
  };
  return { api, onBound, options };
}
it('reviews explicit role context without starting setup or a turn', async () => {
  const f = fixture();
  const { result } = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => result.current.review());
  expect(f.api.roleContext).toHaveBeenCalledOnce();
  expect(result.current.context).toEqual(context);
  expect(result.current.canConfirm).toBe(true);
  expect(f.api.setupRole).not.toHaveBeenCalled();
  expect(f.onBound).not.toHaveBeenCalled();
});
it('pins only adopted reviewed source snapshots and their exact material revisions before requesting canonical role context', async () => {
  const f = fixture();
  const pin = { artifactId: 'c'.repeat(32), revision: 2, sha256: 'd'.repeat(64) };
  const source = {
    version: 1 as const,
    snapshotId: 'reviewed-source',
    itemId: 'item',
    source: { namespace: 'mitzo' as const, conversationId: 'original' },
    selection: {
      kind: 'selected' as const,
      messageIds: ['message'],
      blockIds: [],
      throughSequence: 2,
    },
    adoptedBrief: { revision, sha256: revision },
    artifacts: [pin, pin],
    author: null,
    sourceCreatedAt: null,
    adoptedAt: null,
  };
  const work = await f.api.read('item');
  f.api.read.mockResolvedValueOnce({
    ...work,
    sources: [
      source,
      { ...source, snapshotId: 'unknown-legacy', selection: { kind: 'unknown' }, artifacts: [] },
    ],
  });
  f.api.roleContext.mockResolvedValueOnce({ ...context, sources: [source], artifacts: [pin] });
  const { result } = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => result.current.review());
  expect(f.api.roleContext).toHaveBeenCalledWith(
    { itemId: 'item', role: 'lead', sourceSnapshotIds: ['reviewed-source'], artifactRefs: [pin] },
    expect.any(AbortSignal),
  );
  expect(result.current.context?.sources).toEqual([source]);
  expect(f.api.setupRole).not.toHaveBeenCalled();
});
it('retains the exact UUID settings context and assignment revision through uncertain retry and a remounted draft', async () => {
  const f = fixture();
  const first = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => first.result.current.review());
  await act(async () => first.result.current.confirm());
  expect(f.api.setupRole).toHaveBeenCalledOnce();
  const original = structuredClone(f.api.setupRole.mock.calls[0][0]);
  expect(original).toMatchObject({
    itemId: 'item',
    role: 'lead',
    expectedRevision: revision,
    expectedAssignmentRevision: 0,
    settings,
    contextSelection: context,
  });
  expect(original.requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(first.result.current.uncertain).toBe(true);
  first.unmount();
  f.options.settings.selection.model = 'changed-after-uncertain';
  const second = renderHook(() => useTelosRoleSetup(f.options));
  expect(second.result.current.locked).toBe(true);
  await act(async () => second.result.current.retry());
  expect(f.api.setupRole.mock.calls[1][0]).toEqual(original);
  expect(f.api.roleContext).toHaveBeenCalledOnce();
  expect(f.onBound).not.toHaveBeenCalled();
});

// The original generic-409 review reproduction is retained in Telos; this
// replacement requires positive same-request evidence, never status alone.
it('CT03: a proven pre-allocation rejection permits fresh review of the retained draft', async () => {
  const f = fixture();
  const { TelosWorkApiError } = await import('@mitzo/client');
  f.api.setupRole.mockImplementation(async (input) => {
    throw Object.assign(new TelosWorkApiError(409, 'conflict', 'Work revision conflict'), {
      recovery: { version: 1, requestId: input.requestId, outcome: 'rejected_before_allocation' },
    });
  });
  const { result } = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => result.current.review());
  await act(async () => result.current.confirm());
  await act(async () => result.current.retry());
  // A definite rejection before preparation needs a new review, not endless replay.
  expect(f.api.roleContext).toHaveBeenCalledTimes(2);
  expect(f.api.setupRole).toHaveBeenCalledOnce();
  expect(result.current.canConfirm).toBe(true);
  expect(f.options.settings).toEqual(settings);
});

it.each(['missing', 'recover_original', 'wrong_request'] as const)(
  'CT04: %s recovery evidence retains exact replay through remount',
  async (outcome) => {
    const f = fixture();
    const { TelosWorkApiError } = await import('@mitzo/client');
    f.api.setupRole.mockImplementation(async (input) => {
      throw Object.assign(
        new TelosWorkApiError(409, 'conflict', 'Late setup conflict'),
        outcome === 'missing'
          ? {}
          : {
              recovery: {
                version: 1,
                requestId: outcome === 'wrong_request' ? 'unrelated-request' : input.requestId,
                outcome: outcome === 'wrong_request' ? 'rejected_before_allocation' : outcome,
              },
            },
      );
    });
    const first = renderHook(() => useTelosRoleSetup(f.options));
    await act(async () => first.result.current.review());
    await act(async () => first.result.current.confirm());
    const original = structuredClone(f.api.setupRole.mock.calls[0][0]);
    expect(first.result.current.locked).toBe(true);
    expect(first.result.current.uncertain).toBe(true);
    first.unmount();
    f.options.settings.selection.model = 'changed-after-conflict';
    const second = renderHook(() => useTelosRoleSetup(f.options));
    await act(async () => second.result.current.retry());
    expect(f.api.setupRole.mock.calls[1][0]).toEqual(original);
    expect(f.api.roleContext).toHaveBeenCalledOnce();
    expect(second.result.current.locked).toBe(true);
    expect(f.onBound).not.toHaveBeenCalled();
  },
);

it('CT03: proven rejection survives reload and confirms a newly reviewed revision with a new UUID', async () => {
  const f = fixture();
  const { TelosWorkApiError } = await import('@mitzo/client');
  f.api.setupRole.mockImplementation(async (input) => {
    throw Object.assign(new TelosWorkApiError(409, 'conflict', 'Work revision conflict'), {
      recovery: { version: 1, requestId: input.requestId, outcome: 'rejected_before_allocation' },
    });
  });
  const first = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => first.result.current.review());
  await act(async () => first.result.current.confirm());
  const rejected = structuredClone(f.api.setupRole.mock.calls[0][0]);
  first.unmount();
  const nextRevision = 'e'.repeat(64);
  f.api.read.mockResolvedValue({
    itemId: 'item',
    kind: null,
    parentId: null,
    revision: nextRevision,
    links: [],
    assignments: [],
    sources: [],
    attempts: [],
  });
  f.api.roleContext.mockResolvedValue({
    ...structuredClone(context),
    brief: { ...context.brief, revision: nextRevision },
    overallGoal: { ...context.overallGoal, revision: nextRevision },
  });
  const second = renderHook(() => useTelosRoleSetup(f.options));
  expect(second.result.current.locked).toBe(false);
  await act(async () => second.result.current.retry());
  expect(f.api.setupRole).toHaveBeenCalledOnce();
  expect(second.result.current.canConfirm).toBe(true);
  await act(async () => second.result.current.confirm());
  const fresh = f.api.setupRole.mock.calls[1][0];
  expect(fresh.requestId).not.toBe(rejected.requestId);
  expect(fresh.expectedRevision).toBe(nextRevision);
  expect(fresh.settings).toEqual(rejected.settings);
  expect(fresh.itemId).toBe(rejected.itemId);
  expect(f.onBound).not.toHaveBeenCalled();
});

it('CT03: failed rejection persistence retains the original submission through reload', async () => {
  const f = fixture();
  const { TelosWorkApiError } = await import('@mitzo/client');
  const failedRejectionWrite = vi.fn(() => {
    throw new Error('device storage full');
  });
  f.api.setupRole.mockImplementationOnce(async (input) => {
    // The original submission is already durable before this POST. Fail only
    // the subsequent terminal-rejection write, not the pre-send safety fence.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(failedRejectionWrite);
    throw Object.assign(new TelosWorkApiError(409, 'conflict', 'Work revision conflict'), {
      recovery: { version: 1, requestId: input.requestId, outcome: 'rejected_before_allocation' },
    });
  });
  const first = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => first.result.current.review());
  await act(async () => first.result.current.confirm());
  const original = structuredClone(f.api.setupRole.mock.calls[0][0]);
  expect(
    JSON.parse(localStorage.getItem('mitzo-telos-role-setup:ordinary-draft')!).submission,
  ).toEqual(original);
  expect(first.result.current.locked).toBe(true);
  expect(first.result.current.uncertain).toBe(true);
  const rejectionError = first.result.current.error;
  first.unmount();
  vi.restoreAllMocks();

  f.options.settings.selection.model = 'changed-after-storage-failure';
  const second = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => second.result.current.retry());
  expect(f.api.setupRole.mock.calls[1][0]).toEqual(original);
  expect(f.api.roleContext).toHaveBeenCalledOnce();
  expect(f.onBound).not.toHaveBeenCalled();
  expect(failedRejectionWrite).toHaveBeenCalledOnce();
  expect(rejectionError).toMatch(/storage/i);
});

it('CT03: terminal rejection history is durable before releasing the original request', async () => {
  const f = fixture();
  const { TelosWorkApiError } = await import('@mitzo/client');
  f.api.setupRole.mockImplementationOnce(async (input) => {
    throw Object.assign(new TelosWorkApiError(409, 'conflict', 'Reviewed work changed'), {
      recovery: { version: 1, requestId: input.requestId, outcome: 'rejected_before_allocation' },
    });
  });
  const h = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => h.result.current.review());
  await act(async () => h.result.current.confirm());
  const original = f.api.setupRole.mock.calls[0][0];
  const stored = JSON.parse(localStorage.getItem('mitzo-telos-role-setup:ordinary-draft')!);
  expect(stored.submission).toBeNull();
  expect(stored.review).toBeNull();
  expect(stored.rejections).toContainEqual({
    submission: original,
    recovery: { version: 1, requestId: original.requestId, outcome: 'rejected_before_allocation' },
  });
  expect(h.result.current.locked).toBe(false);
  expect(f.onBound).not.toHaveBeenCalled();
});
it('CT04: a late old rejection cannot clear a newer explicitly confirmed request in another tab', async () => {
  const f = fixture();
  const { TelosWorkApiError } = await import('@mitzo/client');
  let rejectFirst!: (cause: Error) => void;
  f.api.setupRole.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }),
  );
  f.api.setupRole.mockImplementationOnce(async (input) => {
    throw Object.assign(new TelosWorkApiError(409, 'conflict', 'Reviewed work changed'), {
      recovery: { version: 1, requestId: input.requestId, outcome: 'rejected_before_allocation' },
    });
  });
  f.api.setupRole.mockRejectedValueOnce(new Error('New request response lost'));
  const first = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => first.result.current.review());
  let pending!: Promise<void>;
  await act(async () => {
    pending = first.result.current.confirm();
    await Promise.resolve();
  });
  const original = structuredClone(f.api.setupRole.mock.calls[0][0]);
  const second = renderHook(() => useTelosRoleSetup(f.options));
  try {
    await act(async () => second.result.current.retry());
    expect(second.result.current.locked).toBe(false);
    await act(async () => second.result.current.retry());
    await act(async () => second.result.current.confirm());
    const newer = structuredClone(f.api.setupRole.mock.calls[2][0]);
    expect(newer.requestId).not.toBe(original.requestId);
    await act(async () => {
      rejectFirst(
        Object.assign(new TelosWorkApiError(409, 'conflict', 'Late rejected request'), {
          recovery: {
            version: 1,
            requestId: original.requestId,
            outcome: 'rejected_before_allocation',
          },
        }),
      );
      await pending;
    });
    expect(
      JSON.parse(localStorage.getItem('mitzo-telos-role-setup:ordinary-draft')!).submission,
    ).toEqual(newer);
    expect(first.result.current.locked).toBe(true);
    expect(first.result.current.uncertain).toBe(true);
    expect(f.api.setupRole).toHaveBeenCalledTimes(3);
    expect(f.onBound).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      rejectFirst(new Error('Finish isolated pending request'));
      await pending;
    });
    first.unmount();
    second.unmount();
  }
});
it('CT04: a late old rejection cannot erase a newer explicit review before confirmation in another tab', async () => {
  const f = fixture();
  const { TelosWorkApiError } = await import('@mitzo/client');
  let rejectFirst!: (cause: Error) => void;
  f.api.setupRole.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }),
  );
  f.api.setupRole.mockImplementationOnce(async (input) => {
    throw new TelosWorkApiError(409, 'conflict', 'Reviewed work changed', {
      version: 1,
      requestId: input.requestId,
      outcome: 'rejected_before_allocation',
    });
  });
  const first = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => first.result.current.review());
  let pending!: Promise<void>;
  await act(async () => {
    pending = first.result.current.confirm();
    await Promise.resolve();
  });
  const original = structuredClone(f.api.setupRole.mock.calls[0][0]);
  const second = renderHook(() => useTelosRoleSetup(f.options));
  try {
    await act(async () => second.result.current.retry());
    await act(async () => second.result.current.retry());
    const latest = JSON.parse(localStorage.getItem('mitzo-telos-role-setup:ordinary-draft')!);
    expect(latest.review).not.toBeNull();
    await act(async () => {
      rejectFirst(
        new TelosWorkApiError(409, 'conflict', 'Late original response', {
          version: 1,
          requestId: original.requestId,
          outcome: 'rejected_before_allocation',
        }),
      );
      await pending;
    });
    expect(JSON.parse(localStorage.getItem('mitzo-telos-role-setup:ordinary-draft')!)).toEqual(
      latest,
    );
    expect(first.result.current.locked).toBe(true);
    expect(first.result.current.uncertain).toBe(true);
    expect(second.result.current.canConfirm).toBe(true);
    expect(f.api.setupRole).toHaveBeenCalledTimes(2);
    expect(f.onBound).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      rejectFirst(new Error('Finish isolated pending request'));
      await pending;
    });
    first.unmount();
    second.unmount();
  }
});

async function presentationFixture() {
  const f = fixture();
  const { sha256Hex } = await import('../../lib/browser-crypto');
  const presentation = {
    version: 1 as const,
    contextSha256: sha256Hex(JSON.stringify(context)),
    reviewedAt: '2026-10-18T10:00:00Z',
    item: { itemId: context.itemId, revision: context.brief.revision, title: 'Reviewed work' },
    overallGoal: {
      itemId: context.overallGoal.itemId,
      revision: context.overallGoal.revision,
      title: 'Reviewed goal',
    },
    parents: [],
    sources: [],
    artifacts: [],
  };
  const presentationRef = {
    id: '89b5166a-c549-4aa8-85f2-65dfbf0f2f81',
    sha256: sha256Hex(JSON.stringify(presentation)),
  };
  const reviewRoleContext = vi.fn(async () => ({
    version: 1 as const,
    selection: structuredClone(context),
    presentation: structuredClone(presentation),
    presentationRef,
  }));
  const setupReviewedRole = vi.fn(async (_wrapper: unknown) => {
    throw Error('Offline wrapper response lost');
  });
  Object.assign(f.api, { reviewRoleContext, setupReviewedRole });
  return { ...f, presentation, presentationRef, reviewRoleContext, setupReviewedRole };
}

it('CT05: retains the exact reviewed presentation through uncertain wrapper retry without fetching replacement labels', async () => {
  const f = await presentationFixture();
  const { presentationRef, reviewRoleContext, setupReviewedRole } = f;
  const first = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => first.result.current.review());
  await act(async () => first.result.current.confirm());
  expect(setupReviewedRole).toHaveBeenCalledOnce();
  expect(reviewRoleContext).toHaveBeenCalledOnce();
  expect(f.api.roleContext).not.toHaveBeenCalled();
  expect(f.api.setupRole).not.toHaveBeenCalled();
  const original = structuredClone(setupReviewedRole.mock.calls[0][0]);
  expect(original).toMatchObject({
    version: 1,
    presentationRef,
    input: { contextSelection: context, settings },
  });
  first.unmount();
  f.options.settings.selection.model = 'Different currently selected model';
  const second = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => second.result.current.retry());
  expect(setupReviewedRole).toHaveBeenCalledTimes(2);
  expect(setupReviewedRole.mock.calls[1][0]).toEqual(original);
  expect(reviewRoleContext).toHaveBeenCalledOnce();
  expect(second.result.current.locked).toBe(true);
  expect(second.result.current.uncertain).toBe(true);
  expect(f.onBound).not.toHaveBeenCalled();
});

it('CT05: terminal rejection retains its original display bytes and ref before explicit review, including after reload', async () => {
  const f = await presentationFixture();
  const { TelosWorkApiError } = await import('@mitzo/client');
  f.setupReviewedRole.mockImplementationOnce(async (raw) => {
    const wrapper = raw as { input: TelosWorkRoleSetupInput };
    throw new TelosWorkApiError(409, 'conflict', 'Reviewed work changed', {
      version: 1,
      requestId: wrapper.input.requestId,
      outcome: 'rejected_before_allocation',
    });
  });
  const first = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => first.result.current.review());
  await act(async () => first.result.current.confirm());
  const original = f.setupReviewedRole.mock.calls[0][0] as { input: TelosWorkRoleSetupInput };
  const retained = JSON.parse(localStorage.getItem('mitzo-telos-role-setup:ordinary-draft')!);
  expect(retained.submission).toBeNull();
  expect(retained.review).toBeNull();
  expect(retained.rejections).toEqual([
    {
      submission: original.input,
      recovery: {
        version: 1,
        requestId: original.input.requestId,
        outcome: 'rejected_before_allocation',
      },
      presentation: f.presentation,
      presentationRef: f.presentationRef,
    },
  ]);
  first.unmount();
  const second = renderHook(() => useTelosRoleSetup(f.options));
  expect(second.result.current.rejectedBeforeAllocation).toBe(true);
  expect(f.reviewRoleContext).toHaveBeenCalledOnce();
  expect(f.setupReviewedRole).toHaveBeenCalledOnce();
  await act(async () => second.result.current.retry());
  expect(f.reviewRoleContext).toHaveBeenCalledTimes(2);
  expect(f.setupReviewedRole).toHaveBeenCalledOnce();
  expect(second.result.current.canConfirm).toBe(true);
  expect(
    JSON.parse(localStorage.getItem('mitzo-telos-role-setup:ordinary-draft')!).rejections,
  ).toEqual(retained.rejections);
  await act(async () => second.result.current.confirm());
  const next = f.setupReviewedRole.mock.calls[1][0] as { input: TelosWorkRoleSetupInput };
  expect(next.input.requestId).not.toBe(original.input.requestId);
  expect(f.api.setupRole).not.toHaveBeenCalled();
  expect(f.onBound).not.toHaveBeenCalled();
});

it('CT05: changed saved display bytes cannot trigger replay, replacement review or allocation', async () => {
  const f = await presentationFixture();
  const first = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => first.result.current.review());
  await act(async () => first.result.current.confirm());
  first.unmount();
  const storageKey = 'mitzo-telos-role-setup:ordinary-draft';
  const retained = JSON.parse(localStorage.getItem(storageKey)!);
  retained.review.presentation.overallGoal.title = 'Unreviewed replacement goal';
  localStorage.setItem(storageKey, JSON.stringify(retained));
  const bytes = localStorage.getItem(storageKey);
  const second = renderHook(() => useTelosRoleSetup(f.options));
  expect(second.result.current.locked).toBe(true);
  expect(second.result.current.error).toContain('could not be read');
  await act(async () => second.result.current.retry());
  await act(async () => second.result.current.review());
  await act(async () => second.result.current.confirm());
  expect(f.reviewRoleContext).toHaveBeenCalledOnce();
  expect(f.setupReviewedRole).toHaveBeenCalledOnce();
  expect(f.api.setupRole).not.toHaveBeenCalled();
  expect(localStorage.getItem(storageKey)).toBe(bytes);
  expect(f.onBound).not.toHaveBeenCalled();
});
