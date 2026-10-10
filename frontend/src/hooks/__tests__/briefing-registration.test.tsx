// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { MitzoStoreProvider, useMitzoStore } from '@mitzo/client/hooks';
import type { SendMessageOptions } from '@mitzo/client';
import { createTestStore } from '../../test-utils/createTestStore';
import { apiFetch } from '../../lib/api-fetch';
import { usePendingLaunch } from '../usePendingLaunch';
import { useBriefingChat } from '../useBriefingChat';
vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
  getApiBaseUrl: () => '',
  AUTH_LOST_EVENT: 'mitzo:auth-lost',
}));
vi.mock('../useHomePreferences', () => ({ useHomePreferences: () => ({ preferences: null }) }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.resetAllMocks();
});

const reviewed = { date: '2026-10-09', revision: 'a'.repeat(64), accountId: 'work', model: 'luna' };
function useConversation() {
  const id = useMitzoStore((s) => s.sessions.active);
  return { launch: usePendingLaunch(), chat: useBriefingChat(id) };
}

it('keeps the assigned reviewed identity after failed POST and GET[] through completion, navigation and fresh-store remount, then retries only registration', async () => {
  let registered = false;
  const calls: string[] = [];
  vi.mocked(apiFetch).mockImplementation(async (url, opts) => {
    calls.push(String(url));
    if (opts?.method === 'POST')
      return new Response(
        JSON.stringify({ ...reviewed, sessionId: 'assigned', createdAt: '2026-10-09T07:00:00Z' }),
        { status: registered ? 201 : 503 },
      );
    return new Response(
      JSON.stringify(
        registered
          ? [{ ...reviewed, sessionId: 'assigned', createdAt: '2026-10-09T07:00:00Z' }]
          : [],
      ),
    );
  });
  const store = createTestStore();
  let options: SendMessageOptions | undefined;
  const send = vi.fn((_text: string, value?: SendMessageOptions) => {
    options = value;
  });
  store.setState({
    pendingSession: {
      prompt: 'Explain',
      context: 'Briefing',
      briefing: reviewed,
      accountSelection: { accountId: reviewed.accountId, model: reviewed.model },
      sourceSnapshots: [
        {
          kind: 'briefing',
          date: reviewed.date,
          revision: reviewed.revision,
          content: 'Private original report bytes',
        },
      ],
    },
    sendMessage: send,
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <MitzoStoreProvider value={store}>{children}</MitzoStoreProvider>
  );
  const first = renderHook(useConversation, { wrapper });
  act(() => first.result.current.launch.sendLaunch());
  await act(async () => {
    options?.onSessionAssigned?.('assigned');
    store.setState({ sessions: { ...store.getState().sessions, active: 'assigned' } });
    options?.onDelivery?.('accepted');
  });
  await waitFor(() => expect(first.result.current.launch.registrationError).toBeTruthy());
  await waitFor(() => expect(first.result.current.chat.loading).toBe(false));
  expect(first.result.current.chat.source).toMatchObject(reviewed);
  expect(first.result.current.chat.selectionLocked).toBe(true);
  expect(first.result.current.launch.launch).toBeNull();
  act(() =>
    store.setState({
      messages: { ...store.getState().messages, running: false },
      sessions: { ...store.getState().sessions, active: 'other' },
    }),
  );
  await waitFor(() => expect(first.result.current.chat.loading).toBe(false));
  expect(first.result.current.chat.source).toBeNull();
  expect(first.result.current.launch.registrationError).toBe('');
  first.unmount();
  const restored = createTestStore();
  restored.setState({ sessions: { ...restored.getState().sessions, active: 'assigned' } });
  const second = renderHook(useConversation, {
    wrapper: ({ children }) => <MitzoStoreProvider value={restored}>{children}</MitzoStoreProvider>,
  });
  await waitFor(() => expect(second.result.current.chat.loading).toBe(false));
  expect(second.result.current.chat.source).toMatchObject(reviewed);
  expect(second.result.current.chat.selectionLocked).toBe(true);
  expect(second.result.current.launch.registrationError).toBeTruthy();
  expect(Object.values(localStorage).join('')).not.toContain('Private original report bytes');
  registered = true;
  await act(async () => second.result.current.launch.retryRegistration());
  await waitFor(() => expect(second.result.current.launch.registrationError).toBe(''));
  await waitFor(() => expect(second.result.current.chat.binding?.sessionId).toBe('assigned'));
  expect(second.result.current.chat.selectionLocked).toBe(true);
  expect(send).toHaveBeenCalledOnce();
  const posts = vi.mocked(apiFetch).mock.calls.filter(([, opts]) => opts?.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(posts.map(([, opts]) => JSON.parse(String(opts?.body)))).toEqual([
    { ...reviewed, sessionId: 'assigned' },
    { ...reviewed, sessionId: 'assigned' },
  ]);
});
