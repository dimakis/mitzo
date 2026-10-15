// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, useNavigate, useSearchParams } from 'react-router-dom';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { createTestStore } from '../../test-utils/createTestStore';
import { useStageChatLaunch } from '../useStageChatLaunch';
import { usePendingLaunch } from '../usePendingLaunch';
import { launchDraftDelivery } from '../../lib/launch-draft-delivery';
import { getChatDraft, listChatDrafts } from '../../lib/chat-drafts';
vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
  getApiBaseUrl: () => '',
  AUTH_LOST_EVENT: 'auth-lost',
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
const launch = {
  prompt: 'Discuss the saved briefing',
  context: 'Morning briefing',
  briefing: { date: '2026-10-15', revision: 'a'.repeat(64) },
  accountSelection: { accountId: 'work', model: 'luna', reasoningEffort: 'high' },
  contextBlocks: ['guidance'],
  telosTaskId: 'task',
  agentName: 'minion',
};
function setup() {
  const store = createTestStore();
  const send = vi.fn();
  store.setState({ sendMessage: send });
  const hook = renderHook(
    () => {
      const [search] = useSearchParams();
      return {
        stage: useStageChatLaunch(),
        pending: usePendingLaunch(search.get('draft')),
        navigate: useNavigate(),
        id: search.get('draft'),
      };
    },
    {
      wrapper: ({ children }) => (
        <MitzoStoreProvider value={store}>
          <MemoryRouter initialEntries={['/chat']}>{children}</MemoryRouter>
        </MitzoStoreProvider>
      ),
    },
  );
  return { ...hook, store, send };
}
it('saves an unsent launch, starts New blank and restores only its own draft', async () => {
  const { result, store, send } = setup();
  act(() => result.current.stage(launch, 'extraTools=Bash'));
  const id = result.current.id!;
  expect(id).toBeTruthy();
  expect(getChatDraft(id)).toMatchObject({
    text: launch.prompt,
    settings: { launch, selection: launch.accountSelection, search: 'extraTools=Bash' },
  });
  expect(result.current.pending.launch).toMatchObject(launch);
  act(() => {
    store.getState().newSession();
    result.current.navigate('/chat');
  });
  expect(result.current.pending.launch).toBeNull();
  expect(getChatDraft(id)).not.toBeNull();
  act(() => result.current.navigate(`/chat?draft=${id}`));
  await waitFor(() => expect(result.current.pending.launch).toMatchObject(launch));
  expect(send).not.toHaveBeenCalled();
  act(() => result.current.navigate('/chat'));
  expect(result.current.pending.launch).toBeNull();
  expect(listChatDrafts()).toHaveLength(1);
});
it('consumes only the submitted launch draft after acknowledgement and keeps replacements', () => {
  const { result, send } = setup();
  let receipt: ((status: 'accepted' | 'failed' | 'uncertain') => void) | undefined;
  send.mockImplementation((text, options) => {
    const clientMsgId = crypto.randomUUID();
    expect(
      launchDraftDelivery.prepare(options.launchDraftId, {
        ...options,
        prompt: text,
        clientMsgId,
      }),
    ).toBe(true);
    receipt = (status) => {
      launchDraftDelivery.settle(clientMsgId, status);
      options.onDelivery?.(status);
    };
  });
  act(() => result.current.stage(launch));
  const first = result.current.id!;
  act(() => result.current.pending.sendLaunch());
  act(() => receipt?.('failed'));
  expect(getChatDraft(first)).not.toBeNull();
  act(() => result.current.pending.sendLaunch());
  const firstReceipt = receipt;
  act(() => result.current.stage({ ...launch, prompt: 'Replacement' }));
  const second = result.current.id!;
  act(() => firstReceipt?.('accepted'));
  expect(getChatDraft(first)).toBeNull();
  expect(getChatDraft(second)?.text).toBe('Replacement');
  expect(result.current.pending.launch?.prompt).toBe('Replacement');
});
it('keeps the current conversation when saving a launch fails', () => {
  const { result, store } = setup();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('full');
  });
  expect(() => act(() => result.current.stage(launch))).toThrow(/save/i);
  expect(store.getState().pendingSession).toBeNull();
  expect(result.current.id).toBeNull();
});

it('restoring an uncertain launch cannot send the same prompt twice', async () => {
  const { result, store, send } = setup();
  let receipt: ((status: 'accepted' | 'failed' | 'uncertain') => void) | undefined;
  send.mockImplementation((_text, options) => {
    receipt = options?.onDelivery;
  });
  act(() => result.current.stage(launch));
  const id = result.current.id!;
  act(() => result.current.pending.sendLaunch());
  act(() => receipt?.('uncertain'));
  act(() => {
    store.getState().newSession();
    result.current.navigate('/chat');
  });
  act(() => result.current.navigate(`/chat?draft=${id}`));
  await waitFor(() => expect(result.current.pending.launchSending).toBe(true));
  act(() => result.current.pending.sendLaunch());
  expect(send).toHaveBeenCalledTimes(1);
  act(() => receipt?.('failed'));
  expect(result.current.pending.launchSending).toBe(false);
  act(() => result.current.pending.sendLaunch());
  expect(send).toHaveBeenCalledTimes(2);
});

it('keeps an assigned conversation active while releasing its launch preview', () => {
  const { result, store } = setup();
  act(() => result.current.stage(launch));
  act(() => result.current.pending.sendLaunch());
  act(() => {
    store.setState({ sessions: { ...store.getState().sessions, active: 'assigned' } });
    result.current.navigate('/chat/assigned');
  });
  expect(store.getState().sessions.active).toBe('assigned');
  expect(result.current.pending.launch).toBeNull();
});
