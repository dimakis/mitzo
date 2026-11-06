// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useNewChatDraft } from '../useNewChatDraft';
import { apiFetch } from '../../lib/api-fetch';
import { createChatDraft, saveChatDraft } from '../../lib/chat-drafts';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.resetAllMocks();
});
const configuration = {
  version: 1,
  runtime: {
    version: 1,
    account: { accountId: 'personal', model: 'luna-fixture' },
    agentProfile: null,
    execution: { location: 'local', targetId: 'mac-1' },
  },
  mode: 'ask',
  isolation: false,
  repositoryWorkspaceId: null,
  contextBlocks: ['Saved context'],
  extraTools: ['Read'],
};
it('hydrates complete defaults into a fresh draft without changing its identity', async () => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ revision: 2, configuration }));
  const { result } = renderHook(() => useNewChatDraft(null, 0, true));
  const id = result.current.draft.id;
  await waitFor(() =>
    expect(result.current.draft.settings.runtimeSelection?.execution.location).toBe('local'),
  );
  expect(result.current.draft.id).toBe(id);
  expect(result.current.draft.settings.runtimeSelection?.execution.targetId).toBe('mac-1');
  expect(result.current.draft.settings.mode).toBe('ask');
  expect(result.current.draft.settings.isolation).toBe(false);
  expect(result.current.draft.contextBlocks).toEqual(['Saved context']);
});
it('never replaces a restored draft or an explicit edit while defaults load', async () => {
  let resolve!: (value: Response) => void;
  vi.mocked(apiFetch).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const { result } = renderHook(() => useNewChatDraft(null, 0, true));
  act(() => result.current.markEdited());
  await act(async () => resolve(Response.json({ revision: 2, configuration })));
  expect(result.current.draft.settings.runtimeSelection).toBeUndefined();
  const draft = createChatDraft();
  draft.text = 'Retained task';
  saveChatDraft(draft);
  const restored = renderHook(() => useNewChatDraft(draft.id, 0, true));
  expect(restored.result.current.draft.text).toBe('Retained task');
  expect(restored.result.current.draft.settings.runtimeSelection).toBeUndefined();
});
it('loads, retries and saves defaults for a restored draft without hydrating its settings', async () => {
  const draft = createChatDraft();
  draft.text = 'Keep this handoff';
  saveChatDraft(draft);
  vi.mocked(apiFetch).mockRejectedValueOnce(Error('Offline'));
  const { result } = renderHook(() => useNewChatDraft(draft.id, 0, true));
  await waitFor(() => expect(result.current.defaults.error).toBe('Offline'));
  vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ revision: 2, configuration }));
  act(() => result.current.defaults.refresh());
  await waitFor(() => expect(result.current.defaults.revision).toBe(2));
  expect(result.current.defaultsHydrating).toBe(false);
  expect(result.current.draft).toEqual(draft);
  vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ revision: 3, configuration: null }));
  await act(async () => expect(await result.current.defaults.save(null)).toBe(true));
  expect(result.current.defaults.revision).toBe(3);
  expect(result.current.draft).toEqual(draft);
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/api/session-launch/defaults',
    expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ expectedRevision: 2, configuration: null }),
    }),
  );
});
