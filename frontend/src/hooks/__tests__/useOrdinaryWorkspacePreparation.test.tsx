// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import {
  OrdinaryWorkspacePreparationRequestSchema,
  OrdinaryWorkspacePreparationReceiptSchema,
} from '@mitzo/protocol';
import { useOrdinaryWorkspacePreparation } from '../useOrdinaryWorkspacePreparation';
import { apiFetch } from '../../lib/api-fetch';
import { loadOrdinaryPreparation } from '../../lib/ordinary-workspace-preparation';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
const request = OrdinaryWorkspacePreparationRequestSchema.parse({
  version: 1,
  model: 'fixture-model',
  runOn: 'local',
  runtime: {
    account: { accountId: 'offline', provider: 'openai-codex', profileRevision: 'r1' },
    harness: 'codex',
    targetId: 'mac',
  },
});
const receipt = OrdinaryWorkspacePreparationReceiptSchema.parse({
  version: 1,
  kind: 'ordinary',
  preparationId: '11111111-1111-4111-8111-111111111111',
  runtimeBinding: {
    version: 2,
    account: request.runtime.account,
    harness: { implementation: 'codex' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'r1' },
  },
  capabilities: ['ordinary_conversation', 'writable_files', 'retained_artifacts', 'task_execution'],
});
const options = {
  draftId: 'draft',
  enabled: true,
  request,
  selectionKey: 'selection-1',
  blocked: false,
};
const ok = () => new Response(JSON.stringify(receipt), { status: 201 });
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it('retains server-issued readiness before exposure and reuses the exact receipt on reload without another request', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => ok());
  const first = renderHook(() => useOrdinaryWorkspacePreparation(options));
  await waitFor(() => expect(first.result.current.receipt).toEqual(receipt));
  expect(loadOrdinaryPreparation('draft')?.receipt).toEqual(receipt);
  expect(vi.mocked(apiFetch)).toHaveBeenCalledOnce();
  first.unmount();
  vi.mocked(apiFetch).mockClear();
  const restored = renderHook(() => useOrdinaryWorkspacePreparation(options));
  expect(restored.result.current.receipt).toEqual(receipt);
  expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
});
it('retains a known receipt after quota failure and retries storage without creating a replacement preparation', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => ok());
  vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
    throw Error('quota');
  });
  const f = renderHook(() => useOrdinaryWorkspacePreparation(options));
  await waitFor(() =>
    expect(f.result.current.error).toMatch(/original workspace preparation could not be saved/),
  );
  expect(f.result.current.receipt).toBeNull();
  act(() => f.result.current.retry());
  await waitFor(() => expect(f.result.current.receipt).toEqual(receipt));
  expect(vi.mocked(apiFetch)).toHaveBeenCalledOnce();
});
it('keeps an HTTP failure manual through rerender and checks again only on explicit retry', async () => {
  vi.mocked(apiFetch)
    .mockRejectedValueOnce(Error('Readiness unavailable'))
    .mockImplementation(async () => ok());
  const f = renderHook(() => useOrdinaryWorkspacePreparation(options));
  await waitFor(() => expect(f.result.current.error).toBe('Readiness unavailable'));
  f.rerender();
  expect(vi.mocked(apiFetch)).toHaveBeenCalledOnce();
  act(() => f.result.current.retry());
  await waitFor(() => expect(f.result.current.receipt).toEqual(receipt));
  expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(2);
});
it('blocks corrupt retained preparation and does not erase or replace it on retry', async () => {
  const key = 'mitzo-ordinary-workspace-preparation:draft';
  localStorage.setItem(key, 'unreadable');
  const f = renderHook(() => useOrdinaryWorkspacePreparation(options));
  expect(f.result.current.error).toMatch(/could not be read/);
  act(() => f.result.current.retry());
  expect(localStorage.getItem(key)).toBe('unreadable');
  expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
});
it('waits for the role owner to unlock before readiness and discards a late result after locking', async () => {
  let complete!: (r: Response) => void;
  vi.mocked(apiFetch).mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const f = renderHook(({ blocked }) => useOrdinaryWorkspacePreparation({ ...options, blocked }), {
    initialProps: { blocked: true },
  });
  expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  f.rerender({ blocked: false });
  await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledOnce());
  f.rerender({ blocked: true });
  await act(async () => {
    complete(ok());
  });
  expect(f.result.current.receipt).toBeNull();
  expect(loadOrdinaryPreparation('draft')).toBeNull();
});
it('fences late readiness across draft navigation and retains only the selected draft', async () => {
  let complete!: (r: Response) => void;
  vi.mocked(apiFetch)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    )
    .mockImplementation(async () => ok());
  const f = renderHook(({ draftId }) => useOrdinaryWorkspacePreparation({ ...options, draftId }), {
    initialProps: { draftId: 'first-draft' },
  });
  await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledOnce());
  f.rerender({ draftId: 'second-draft' });
  await waitFor(() => expect(f.result.current.receipt).toEqual(receipt));
  await act(async () => {
    complete(ok());
  });
  expect(loadOrdinaryPreparation('first-draft')).toBeNull();
  expect(loadOrdinaryPreparation('second-draft')?.receipt).toEqual(receipt);
});
it('rejects a server receipt for a different account without retaining it or automatically retrying', async () => {
  vi.mocked(apiFetch).mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          ...receipt,
          runtimeBinding: {
            ...receipt.runtimeBinding,
            account: { ...receipt.runtimeBinding.account, accountId: 'foreign' },
          },
        }),
        { status: 201 },
      ),
  );
  const f = renderHook(() => useOrdinaryWorkspacePreparation(options));
  await waitFor(() => expect(f.result.current.error).toBeTruthy());
  expect(f.result.current.receipt).toBeNull();
  expect(loadOrdinaryPreparation('draft')).toBeNull();
  expect(vi.mocked(apiFetch)).toHaveBeenCalledOnce();
  vi.mocked(apiFetch).mockImplementation(async () => ok());
  act(() => f.result.current.retry());
  await waitFor(() => expect(f.result.current.receipt).toEqual(receipt));
  expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(2);
});
