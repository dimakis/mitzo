// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useRepositoryChatPreparation } from '../useRepositoryChatPreparation';
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../lib/api-fetch', () => ({ apiFetch: api.fetch }));
const id = '8ca30b0d-3e65-4eeb-8244-f6277350818f';
const preparation = {
  id,
  sourceConversationId: 'parent',
  repository: 'example/repo',
  baseBranch: 'main',
  baseOid: 'a'.repeat(40),
  featureBranch: 'mitzo/task',
  state: 'ready',
  accountId: 'work',
  model: 'luna',
  prompt: 'Review this task',
  setupUrl: `/chat?repositoryPreparation=${id}`,
};
afterEach(() => {
  cleanup();
  api.fetch.mockReset();
});
it('loads the authenticated persisted draft once without relying on storage', async () => {
  api.fetch.mockResolvedValue(new Response(JSON.stringify({ repositoryChat: preparation })));
  const { result, rerender } = renderHook(() => useRepositoryChatPreparation(id));
  expect(result.current.reason).toMatch(/Loading/);
  await waitFor(() => expect(result.current.preparation?.prompt).toBe(preparation.prompt));
  expect(result.current.reason).toBeUndefined();
  rerender();
  expect(api.fetch).toHaveBeenCalledTimes(1);
  expect(api.fetch.mock.calls[0][0]).toBe(`/api/repository-workspaces/${id}/chat-preparation`);
});
it('fences out-of-order responses and assignment callbacks after a route change', async () => {
  let resolve!: (response: Response) => void;
  api.fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  const otherId = 'aaaaaaaa-bbbb-4ccc-8ddd-121212121212';
  api.fetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        repositoryChat: {
          ...preparation,
          id: otherId,
          prompt: 'Other task',
          setupUrl: `/chat?repositoryPreparation=${otherId}`,
        },
      }),
    ),
  );
  const { result, rerender } = renderHook(
    ({ id: selected }) => useRepositoryChatPreparation(selected),
    { initialProps: { id } },
  );
  const staleAssignment = result.current.markAssigned;
  rerender({ id: otherId });
  await waitFor(() => expect(result.current.preparation?.prompt).toBe('Other task'));
  await act(async () => {
    resolve(new Response(JSON.stringify({ repositoryChat: preparation })));
  });
  act(() => staleAssignment('stale-conversation'));
  expect(result.current.preparation?.id).toBe(otherId);
  expect(result.current.assignedConversationId).toBeNull();
});
it.each(['failed', 'preparing', 'preview', 'claiming', 'discarded', 'claimed'] as const)(
  'restores %s status while blocking new execution',
  async (state) => {
    api.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          repositoryChat: {
            ...preparation,
            state,
            ...(state === 'claimed' ? { conversationId: 'original' } : {}),
          },
        }),
      ),
    );
    const { result } = renderHook(() => useRepositoryChatPreparation(id));
    await waitFor(() => expect(result.current.preparation?.state).toBe(state));
    expect(result.current.reason).toBeTruthy();
    expect(api.fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
  },
);
it.each(['preparing', 'claiming'] as const)(
  'keeps an interrupted %s receipt fenced with original-operation guidance',
  async (state) => {
    api.fetch.mockResolvedValue(
      new Response(JSON.stringify({ repositoryChat: { ...preparation, state } })),
    );
    const { result } = renderHook(() => useRepositoryChatPreparation(id));
    await waitFor(() => expect(result.current.preparation?.state).toBe(state));
    expect(result.current.reason).toBe(
      'This preparation is still running or interrupted. Inspect the original preparation before starting another task.',
    );
    act(() => result.current.markAssigned('another-task'));
    expect(result.current.assignedConversationId).toBeNull();
    expect(api.fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
  },
);
it('rejects an invalid ID without requesting another preparation', () => {
  const { result } = renderHook(() => useRepositoryChatPreparation('not-an-id'));
  expect(result.current.reason).toMatch(/Invalid/);
  expect(api.fetch).not.toHaveBeenCalled();
});
it('rejects an otherwise valid response for a different ID', async () => {
  api.fetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        repositoryChat: {
          ...preparation,
          id: 'aaaaaaaa-bbbb-4ccc-8ddd-121212121212',
          setupUrl: '/chat?repositoryPreparation=aaaaaaaa-bbbb-4ccc-8ddd-121212121212',
        },
      }),
    ),
  );
  const { result } = renderHook(() => useRepositoryChatPreparation(id));
  await waitFor(() => expect(result.current.reason).toMatch(/unavailable/));
  expect(result.current.preparation).toBeUndefined();
});
