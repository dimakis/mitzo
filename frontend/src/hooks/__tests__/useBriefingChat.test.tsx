// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { createTestStore } from '../../test-utils/createTestStore';
import { useBriefingChat } from '../useBriefingChat';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../useHomePreferences', () => ({
  useHomePreferences: () => ({ preferences: { names: { briefing: 'Jeeves' } } }),
}));
afterEach(cleanup);
it('recognizes a resumed briefing conversation by its persisted exact source revision', async () => {
  const binding = {
    sessionId: 'saved',
    date: '2026-10-09',
    revision: 'a'.repeat(64),
    accountId: 'work',
    model: 'luna',
    createdAt: 'now',
  };
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify([binding])));
  const store = createTestStore();
  const { result } = renderHook(() => useBriefingChat('saved'), {
    wrapper: ({ children }) => <MitzoStoreProvider value={store}>{children}</MitzoStoreProvider>,
  });
  await waitFor(() => expect(result.current.binding).toEqual(binding));
  expect(result.current.name).toBe('Jeeves');
  expect(result.current.isBriefing).toBe(true);
});
it('does not reuse another conversation binding when navigation changes', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response('[]'));
  const store = createTestStore();
  store.setState({
    pendingSession: {
      prompt: 'Discuss',
      context: 'Briefing',
      briefing: { date: '2026-10-09', revision: 'old' },
      accountSelection: { accountId: 'work', model: 'luna' },
    },
  });
  const { result, rerender } = renderHook(({ id }) => useBriefingChat(id), {
    initialProps: { id: null as string | null },
    wrapper: ({ children }) => <MitzoStoreProvider value={store}>{children}</MitzoStoreProvider>,
  });
  expect(result.current.isBriefing).toBe(true);
  rerender({ id: 'unrelated' });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.binding).toBeNull();
  expect(result.current.isBriefing).toBe(false);
});

it.each(['503', 'network', 'malformed', 'invalid binding'] as const)(
  'keeps identity guarded after %s lookup failure and retries to a confirmed ordinary chat',
  async (failure) => {
    vi.mocked(apiFetch).mockImplementationOnce(async () => {
      if (failure === 'network') throw new Error('Offline');
      if (failure === '503') return new Response('', { status: 503 });
      return new Response(
        JSON.stringify(
          failure === 'malformed'
            ? {}
            : [
                {
                  sessionId: 'saved',
                  date: 'bad',
                  revision: 'bad',
                  accountId: 'work',
                  model: 'luna',
                },
              ],
        ),
      );
    });
    const store = createTestStore();
    const { result } = renderHook(() => useBriefingChat('saved'), {
      wrapper: ({ children }) => <MitzoStoreProvider value={store}>{children}</MitzoStoreProvider>,
    });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.selectionLocked).toBe(true);
    expect(result.current.loading).toBe(false);
    let resolve!: (response: Response) => void;
    vi.mocked(apiFetch).mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    act(() => result.current.retry());
    expect(result.current.loading).toBe(true);
    expect(result.current.selectionLocked).toBe(true);
    await act(async () => resolve(new Response('[]')));
    await waitFor(() => expect(result.current.selectionLocked).toBe(false));
    expect(result.current.error).toBeUndefined();
    expect(result.current.isBriefing).toBe(false);
  },
);

it('retains a known exact source through a failed refresh and successful retry', async () => {
  const binding = {
    sessionId: 'saved',
    date: '2026-10-09',
    revision: 'a'.repeat(64),
    accountId: 'work',
    model: 'luna',
    createdAt: 'now',
  };
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify([binding])));
  const store = createTestStore();
  const { result } = renderHook(() => useBriefingChat('saved'), {
    wrapper: ({ children }) => <MitzoStoreProvider value={store}>{children}</MitzoStoreProvider>,
  });
  await waitFor(() => expect(result.current.binding).toEqual(binding));
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response('', { status: 503 }));
  act(() => window.dispatchEvent(new Event('mitzo-briefing-chat')));
  await waitFor(() => expect(result.current.error).toBeTruthy());
  expect(result.current.source).toEqual(binding);
  expect(result.current.selectionLocked).toBe(true);
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify([binding])));
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.error).toBeUndefined());
  expect(result.current.source).toEqual(binding);
  expect(result.current.selectionLocked).toBe(true);
});

it('ignores a stale failure when navigation or unmount aborts its lookup', async () => {
  let reject!: (error: Error) => void;
  vi.mocked(apiFetch).mockImplementationOnce(
    () =>
      new Promise<Response>((_, fail) => {
        reject = fail;
      }),
  );
  const store = createTestStore();
  const { result, rerender, unmount } = renderHook(({ id }) => useBriefingChat(id), {
    initialProps: { id: 'old' },
    wrapper: ({ children }) => <MitzoStoreProvider value={store}>{children}</MitzoStoreProvider>,
  });
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response('[]'));
  rerender({ id: 'new' });
  await waitFor(() => expect(result.current.selectionLocked).toBe(false));
  await act(async () => reject(new Error('Old connection failed')));
  expect(result.current.error).toBeUndefined();
  unmount();
});
