// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
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
