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
