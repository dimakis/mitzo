// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { createTestStore } from '../../test-utils/createTestStore';
import { apiFetch } from '../../lib/api-fetch';
import { ChatView } from '../ChatView';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn(), getApiBaseUrl: () => '' }));
vi.mock('../../hooks/useAutoSpeak', () => ({ useAutoSpeak: vi.fn() }));
vi.mock('../../hooks/useProgress', () => ({ useProgressByToolId: () => new Map() }));
vi.mock('../../lib/keyboard', () => ({ onKeyboardToggle: () => () => {} }));
vi.mock('../../hooks/useVoice', () => ({ useVoice: () => ({ stopSpeaking: vi.fn() }) }));
vi.mock('../../components/VoiceSettings', () => ({ VoiceSettings: () => null }));
vi.mock('../../components/ChatArea', () => ({ ChatArea: () => null }));
vi.mock('../../components/ChatInput', () => ({
  ChatInput: ({ initialText }: { initialText?: string }) => (
    <div data-testid="draft">{initialText}</div>
  ),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it.each(['before', 'after'])(
  'pauses launches arriving %s a catalog failure until explicit send',
  async (timing) => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 'work', label: 'Work', models: [{ id: 'sonnet', label: 'Sonnet' }] },
        ],
      } as Response);
    const store = createTestStore();
    const sendMessage = vi.fn();
    store.setState({
      pendingSession:
        timing === 'before' ? { prompt: 'Review this task', context: 'Task context' } : null,
      sendMessage,
    });
    render(
      <MitzoStoreProvider value={store}>
        <MemoryRouter initialEntries={['/chat']}>
          <ChatView />
        </MemoryRouter>
      </MitzoStoreProvider>,
    );
    if (screen.getByRole('button', { name: /Workspace/ }).getAttribute('aria-expanded') === 'false')
      fireEvent.click(screen.getByRole('button', { name: /Workspace/ }));
    await screen.findByRole('alert');
    if (timing === 'after')
      act(() =>
        store.getState().setPendingSession({ prompt: 'Review this task', context: 'Task context' }),
      );
    await waitFor(() => expect(store.getState().pendingSession).toBeNull());
    expect(screen.getByText('Review this task')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry accounts' }));
    await screen.findByText('Work');
    expect(sendMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send launch prompt' }));
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        'Review this task',
        expect.objectContaining({ accountId: 'work', model: 'sonnet' }),
      ),
    );
    expect(store.getState().messages.sessionContext).toBe('Task context');
  },
);

it('sends distinct launches with identical prompt text', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => [{ id: 'work', label: 'Work', models: [{ id: 'sonnet', label: 'Sonnet' }] }],
  } as Response);
  const store = createTestStore();
  const sendMessage = vi.fn();
  store.setState({ sendMessage });
  render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter>
        <ChatView />
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  await screen.findByText('Work');
  for (const telosTaskId of ['task-a', 'task-b']) {
    act(() =>
      store
        .getState()
        .setPendingSession({ prompt: 'Review this task', context: telosTaskId, telosTaskId }),
    );
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        'Review this task',
        expect.objectContaining({ telosTaskId }),
      ),
    );
  }
  expect(sendMessage).toHaveBeenCalledTimes(2);
});

it('keeps a new chat route clear of the previous session and adopts the new ID', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => [] } as Response);
  const store = createTestStore();
  store.setState({ sessions: { ...store.getState().sessions, active: 'old-session' } });
  function Location() {
    return <div data-testid="location">{useLocation().pathname}</div>;
  }
  render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter initialEntries={['/chat']}>
        <Location />
        <Routes>
          <Route path="/chat/:sessionId?" element={<ChatView />} />
        </Routes>
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  await waitFor(() => expect(store.getState().sessions.active).toBeNull());
  expect(screen.getByTestId('location').textContent).toBe('/chat');
  act(() => store.setState({ sessions: { ...store.getState().sessions, active: 'new-session' } }));
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/chat/new-session'));
  expect(store.getState().sessions.active).toBe('new-session');
});

it('clears a failed unassigned turn when a fresh chat route opens', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => [] } as Response);
  const store = createTestStore();
  store.getState().dispatchMessages({
    type: 'USER_SEND',
    text: 'failed prompt',
    clientMsgId: 'failed-message',
  });
  store.getState().dispatchMessages({ type: 'ERROR', error: 'startup failed' });
  expect(store.getState().messages.messages).not.toHaveLength(0);
  render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter initialEntries={['/chat']}>
        <Routes>
          <Route path="/chat/:sessionId?" element={<ChatView />} />
        </Routes>
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  await waitFor(() => expect(store.getState().messages.messages).toHaveLength(0));
  expect(store.getState().messages.running).toBe(false);
  expect(store.getState().modeChangeReady).toBe(true);
});

it('keeps mobile account and permission controls in one collapsible workspace section', async () => {
  localStorage.removeItem('mitzo-workspace-controls-expanded');
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => [
      { id: 'preview', label: 'Preview', models: [{ id: 'demo', label: 'Demo' }] },
    ],
  } as Response);
  render(
    <MitzoStoreProvider value={createTestStore()}>
      <MemoryRouter>
        <ChatView />
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  expect(screen.getByRole('button', { name: /Workspace/ }).getAttribute('aria-expanded')).toBe(
    'false',
  );
  expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Workspace/ }));
  expect(await screen.findByRole('combobox', { name: 'Model' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Agent' })).toBeTruthy();
});

it('shows mobile session details without expanding workspace settings', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => [] } as Response);
  const store = createTestStore();
  store.setState({
    sessions: { ...store.getState().sessions, active: 'mobile-session' },
    messages: {
      ...store.getState().messages,
      branch: 'session/mobile',
      isWorktree: true,
      wtId: 'mobile-worktree',
    },
    fetchSessionMeta: async () => {},
  });
  render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter initialEntries={['/chat/mobile-session']}>
        <Routes>
          <Route path="/chat/:sessionId" element={<ChatView />} />
        </Routes>
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  expect(screen.getByText('Isolated workspace')).toBeTruthy();
  const summary = screen.getByText('Session details');
  fireEvent.click(summary);
  expect(summary.closest('details')?.textContent).toContain('session/mobile');
  expect(summary.closest('details')?.textContent).toContain('mobile-worktree');
  expect(summary.closest('details')?.textContent).toContain('mobile-session');
});
