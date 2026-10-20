// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  OrdinaryWorkspaceSettingsSchema,
  TelosWorkRoleContextSelectionSchema,
  type TelosWorkView,
} from '@mitzo/protocol';
import { useTelosRoleSetup, type TelosRoleSetupOptions } from '../useTelosRoleSetup';
const revision = 'a'.repeat(64);
const settings = OrdinaryWorkspaceSettingsSchema.parse({
  version: 2,
  binding: {
    version: 2,
    account: { accountId: 'offline', provider: 'openai-codex', profileRevision: 'r1' },
    harness: { implementation: 'codex' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'r1' },
  },
  selection: {
    version: 1,
    agent: { profileId: 'worker', revision: 1 },
    context: { source: 'none', revision: null },
    permission: { mode: 'agent', revision: 0 },
    model: 'fixture-model',
    thinking: null,
  },
  workspace: { kind: 'ordinary', preparationId: '11111111-1111-4111-8111-111111111111' },
});
const context = TelosWorkRoleContextSelectionSchema.parse({
  version: 1,
  itemId: 'studio',
  role: 'lead',
  brief: { revision, sha256: 'b'.repeat(64), text: 'Reviewed people-work plan' },
  parentCriteria: [],
  overallGoal: { itemId: 'studio', revision, text: 'People-work plan' },
  sources: [],
  artifacts: [],
});
function fixture() {
  const api = {
    read: vi.fn(
      async () =>
        ({
          itemId: 'studio',
          kind: null,
          parentId: null,
          revision,
          links: [],
          assignments: [],
          sources: [],
          attempts: [],
        }) as TelosWorkView,
    ),
    roleContext: vi.fn(async () => context),
    setupRole: vi.fn(),
    setupOrdinaryRole: vi.fn(async (_request: unknown) => {
      throw Error('response lost');
    }),
  };
  const options = {
    draftId: 'ordinary-draft',
    intent: { itemId: 'studio', role: 'lead', mode: 'assign' },
    settings: structuredClone(settings),
    api,
    onBound: vi.fn(),
  } as TelosRoleSetupOptions;
  return { api, options };
}
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
it('retains strict V2 settings and preparation before setup without requesting a repository route', async () => {
  const f = fixture();
  const { result } = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => result.current.review());
  expect(result.current.canConfirm).toBe(true);
  await act(async () => result.current.confirm());
  expect(f.api.setupOrdinaryRole).toHaveBeenCalledOnce();
  expect(f.api.setupRole).not.toHaveBeenCalled();
  const saved = JSON.parse(localStorage.getItem('mitzo-telos-role-setup:ordinary-draft')!);
  expect(saved.version).toBe(2);
  expect(saved.submission).toMatchObject({ version: 2, settings });
  expect(saved.submission).not.toHaveProperty('repositoryWorkspaceId');
  expect(result.current.uncertain).toBe(true);
  expect(result.current.locked).toBe(true);
});
it('reloads an uncertain V2 request and retries its exact original preparation/settings/UUID despite changed picker intent', async () => {
  const f = fixture();
  const first = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => first.result.current.review());
  await act(async () => first.result.current.confirm());
  const request = f.api.setupOrdinaryRole.mock.calls[0][0];
  first.unmount();
  f.api.setupOrdinaryRole.mockClear();
  f.options.settings = {
    ...settings,
    workspace: { kind: 'ordinary', preparationId: '22222222-2222-4222-8222-222222222222' },
  };
  const restored = renderHook(() => useTelosRoleSetup(f.options));
  expect(restored.result.current.locked).toBe(true);
  expect(f.api.setupOrdinaryRole).not.toHaveBeenCalled();
  await act(async () => restored.result.current.retry());
  expect(f.api.setupOrdinaryRole).toHaveBeenCalledExactlyOnceWith(request);
  expect(f.api.setupRole).not.toHaveBeenCalled();
});
it('refuses V2 setup when device storage cannot retain the immutable request', async () => {
  const f = fixture();
  const { result } = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => result.current.review());
  vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
    throw Error('quota');
  });
  await act(async () => result.current.confirm());
  expect(f.api.setupOrdinaryRole).not.toHaveBeenCalled();
  expect(f.api.setupRole).not.toHaveBeenCalled();
  expect(result.current.locked).toBe(true);
});
async function presentationFixture() {
  const f = fixture();
  const { sha256Hex } = await import('../../lib/browser-crypto');
  const presentation = {
    version: 1 as const,
    contextSha256: sha256Hex(JSON.stringify(context)),
    reviewedAt: '2026-10-18T10:00:00Z',
    item: { itemId: 'studio', revision, title: 'People-work plan' },
    overallGoal: { itemId: 'studio', revision, title: 'Home studio session' },
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
    selection: context,
    presentation,
    presentationRef,
  }));
  const setupReviewedOrdinaryRole = vi.fn(async (_raw: unknown) => {
    throw Error('lost reviewed response');
  });
  Object.assign(f.api, { reviewRoleContext, setupReviewedOrdinaryRole });
  return { ...f, presentation, presentationRef, reviewRoleContext, setupReviewedOrdinaryRole };
}
it('retains the exact V2 reviewed presentation and UUID on reload without fetching replacement labels', async () => {
  const f = await presentationFixture();
  const first = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => first.result.current.review());
  await act(async () => first.result.current.confirm());
  const original = f.setupReviewedOrdinaryRole.mock.calls[0][0];
  first.unmount();
  f.options.settings = {
    ...settings,
    selection: { ...settings.selection, model: 'changed-picker-model' },
  };
  const second = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => second.result.current.retry());
  expect(f.setupReviewedOrdinaryRole.mock.calls[1][0]).toEqual(original);
  expect(f.reviewRoleContext).toHaveBeenCalledOnce();
  expect(f.api.setupRole).not.toHaveBeenCalled();
  expect(f.api.setupOrdinaryRole).not.toHaveBeenCalled();
  expect(second.result.current.presentation).toEqual(f.presentation);
});
it('permits explicit re-review after exact pre-allocation proof while retaining the original V2 settings and labels in history', async () => {
  const f = await presentationFixture(),
    { TelosWorkApiError } = await import('@mitzo/client');
  f.setupReviewedOrdinaryRole.mockImplementationOnce(async (raw) => {
    const wrapper = raw as { input: { requestId: string } };
    throw new TelosWorkApiError(409, 'conflict', 'Reviewed work changed', {
      version: 1,
      requestId: wrapper.input.requestId,
      outcome: 'rejected_before_allocation',
    });
  });
  const first = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => first.result.current.review());
  await act(async () => first.result.current.confirm());
  const saved = JSON.parse(localStorage.getItem('mitzo-telos-role-setup:ordinary-draft')!);
  expect(saved.submission).toBeNull();
  expect(saved.rejections[0]).toMatchObject({
    submission: { version: 2, settings },
    presentation: f.presentation,
    presentationRef: f.presentationRef,
  });
  first.unmount();
  const second = renderHook(() => useTelosRoleSetup(f.options));
  expect(second.result.current.rejectedBeforeAllocation).toBe(true);
  expect(f.reviewRoleContext).toHaveBeenCalledOnce();
  await act(async () => second.result.current.retry());
  expect(f.setupReviewedOrdinaryRole).toHaveBeenCalledOnce();
  expect(second.result.current.canConfirm).toBe(true);
  await act(async () => second.result.current.confirm());
  const next = f.setupReviewedOrdinaryRole.mock.calls[1][0] as { input: { requestId: string } };
  expect(next.input.requestId).not.toBe(saved.rejections[0].submission.requestId);
  expect(
    JSON.parse(localStorage.getItem('mitzo-telos-role-setup:ordinary-draft')!).rejections,
  ).toEqual(saved.rejections);
});
it('keeps an unknown or foreign recovery proof locked to its original ordinary request', async () => {
  const f = fixture(),
    { TelosWorkApiError } = await import('@mitzo/client');
  f.api.setupOrdinaryRole.mockImplementation(async () => {
    throw new TelosWorkApiError(409, 'conflict', 'Unconfirmed', {
      version: 1,
      requestId: 'another-request',
      outcome: 'rejected_before_allocation',
    });
  });
  const h = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => h.result.current.review());
  await act(async () => h.result.current.confirm());
  const original = f.api.setupOrdinaryRole.mock.calls[0][0];
  expect(h.result.current.locked).toBe(true);
  expect(h.result.current.rejectedBeforeAllocation).toBe(false);
  await act(async () => h.result.current.retry());
  expect(f.api.setupOrdinaryRole.mock.calls[1][0]).toEqual(original);
});
it('blocks damaged V2 presentation or mixed reviewed settings without replay, replacement review or storage loss', async () => {
  const f = await presentationFixture();
  const first = renderHook(() => useTelosRoleSetup(f.options));
  await act(async () => first.result.current.review());
  await act(async () => first.result.current.confirm());
  first.unmount();
  const key = 'mitzo-telos-role-setup:ordinary-draft',
    saved = JSON.parse(localStorage.getItem(key)!);
  saved.review.settings.workspace.preparationId = '22222222-2222-4222-8222-222222222222';
  localStorage.setItem(key, JSON.stringify(saved));
  const bytes = localStorage.getItem(key);
  const second = renderHook(() => useTelosRoleSetup(f.options));
  expect(second.result.current.locked).toBe(true);
  await act(async () => second.result.current.retry());
  await act(async () => second.result.current.review());
  expect(f.setupReviewedOrdinaryRole).toHaveBeenCalledOnce();
  expect(f.reviewRoleContext).toHaveBeenCalledOnce();
  expect(localStorage.getItem(key)).toBe(bytes);
});
