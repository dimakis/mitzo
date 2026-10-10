// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { createTestStore } from '../../test-utils/createTestStore';
import { apiFetch } from '../../lib/api-fetch';
import { ChatView } from '../ChatView';

vi.mock('../../components/ChatAgentProfilePicker', () => ({ ChatAgentProfilePicker: () => null }));

vi.mock('../../components/RepositoryChatPicker', () => ({
  RepositoryChatPicker: ({
    onChange,
  }: {
    onChange: (value: { blocked: boolean; repositoryWorkspaceId?: string }) => void;
  }) => (
    <>
      <button onClick={() => onChange({ blocked: true })}>Block repository launch</button>
      <button
        onClick={() =>
          onChange({
            blocked: false,
            repositoryWorkspaceId: '8ca30b0d-3e65-4eeb-8244-f6277350818f',
          })
        }
      >
        Ready repository launch
      </button>
    </>
  ),
}));

const voiceMocks = vi.hoisted(() => ({
  speak: vi.fn(),
  stopSpeaking: vi.fn(),
}));

vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
  getApiBaseUrl: () => '',
  AUTH_LOST_EVENT: 'auth-lost',
  AUTH_RESTORED_EVENT: 'auth-restored',
}));
vi.mock('../../hooks/useHomePreferences', () => ({
  useHomePreferences: () => ({ preferences: { names: { briefing: 'Jeeves' } } }),
}));
vi.mock('../../hooks/useProgress', () => ({ useProgressByToolId: () => new Map() }));
vi.mock('../../lib/keyboard', () => ({ onKeyboardToggle: () => () => {} }));
vi.mock('../../hooks/useVoice', () => ({
  useVoice: () => ({
    available: false,
    recording: false,
    transcribing: false,
    micBlocked: false,
    ttsAvailable: true,
    ttsEnabled: true,
    speaking: false,
    voices: [],
    selectedVoice: '',
    speak: voiceMocks.speak,
    stopSpeaking: voiceMocks.stopSpeaking,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    cancelRecording: vi.fn(),
    setVoice: vi.fn(),
    partialTranscript: '',
  }),
}));
vi.mock('../../components/VoiceSettings', () => ({ VoiceSettings: () => null }));
vi.mock('../../components/WebSearchConsent', () => ({
  WebSearchConsent: ({ connectionId }: { connectionId: string | null }) => (
    <span data-testid="web-search-connection">{connectionId ?? 'none'}</span>
  ),
}));
vi.mock('../../components/ChatArea', () => ({
  ChatArea: ({
    messages,
    currentByMessage,
  }: {
    messages: unknown[];
    currentByMessage?: Record<string, unknown>;
  }) => (
    <div>
      <span data-testid="chat-message-count">Messages: {messages.length}</span>
      <span data-testid="active-seats">
        Active seats: {Object.keys(currentByMessage ?? {}).length}
      </span>
    </div>
  ),
}));
vi.mock('../../components/ChatInput', () => ({
  ChatInput: ({
    initialText,
    onSend,
    onStop,
    running,
    sendDisabledReason,
  }: {
    initialText?: string;
    onStop: () => void;
    running: boolean;
    onSend?: (text: string) => boolean;
    sendDisabledReason?: string;
  }) => (
    <>
      <div data-testid="draft">{initialText}</div>
      <span data-testid="composer-running">{String(running)}</span>
      <button onClick={onStop}>Test Stop</button>
      <button disabled={!!sendDisabledReason} onClick={() => onSend?.('hello')}>
        Test send
      </button>
    </>
  ),
}));
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.resetAllMocks();
});

it('keeps the reviewed briefing account locked and labels the rich chat with the configured minion name', async () => {
  localStorage.setItem('mitzo-preferred-model', 'saved-general-model');
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes('/home/preferences')
            ? { revision: 1, names: { briefing: 'Jeeves', terminal: 'Minion' }, pins: [] }
            : [
                {
                  id: 'work',
                  label: 'Work OpenAI',
                  models: [
                    {
                      id: 'luna',
                      label: 'Luna',
                      reasoningEfforts: ['low', 'high'],
                      defaultReasoningEffort: 'low',
                    },
                  ],
                },
              ],
        ),
      ),
  );
  const store = createTestStore();
  store.setState({
    pendingSession: {
      prompt: 'Discuss this report',
      context: 'Briefing',
      briefing: { date: '2026-10-09', revision: 'a'.repeat(64) },
      accountSelection: { accountId: 'work', model: 'luna' },
      contextBlocks: ['Exact saved report'],
    },
  });
  render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter>
        <ChatView />
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  await screen.findByRole('heading', { name: 'Jeeves' });
  expect((screen.getByLabelText('Account') as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByLabelText('Model') as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByLabelText('Thinking') as HTMLSelectElement).disabled).toBe(true);
  expect(localStorage.getItem('mitzo-preferred-model')).toBe('saved-general-model');
  expect(screen.getByRole('link', { name: /Read briefing/ }).getAttribute('href')).toContain(
    '/briefings/2026-10-09',
  );
  expect(screen.getByRole('button', { name: 'Test send' }).hasAttribute('disabled')).toBe(true);
  localStorage.setItem(
    'mitzo-default-account-model',
    JSON.stringify({ accountId: 'other', model: 'unavailable' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Change account or model' }));
  const dialog = screen.getByRole('dialog', { hidden: true });
  await waitFor(() =>
    expect((within(dialog).getByLabelText('Account') as HTMLSelectElement).value).toBe('work'),
  );
});
it('waits for briefing identity before allowing inline model changes on a restored conversation', async () => {
  let resolveBinding!: (response: Response) => void;
  const identity = new Promise<Response>((resolve) => {
    resolveBinding = resolve;
  });
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).includes('/home/briefing-chats')
      ? identity
      : new Response(
          JSON.stringify({
            accountBinding: { accountId: 'work', accountLabel: 'Work OpenAI', model: 'luna' },
            modelSelection: { model: 'luna', models: [{ id: 'luna', label: 'Luna' }] },
          }),
        ),
  );
  const store = createTestStore();
  store.setState({ sessions: { ...store.getState().sessions, active: 'restored' } });
  render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter initialEntries={['/chat/restored']}>
        <Routes>
          <Route path="/chat/:sessionId" element={<ChatView />} />
        </Routes>
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  const model = (await screen.findByLabelText('Model')) as HTMLSelectElement;
  expect(model.disabled).toBe(true);
  await act(async () => resolveBinding(new Response('[]')));
  await waitFor(() => expect(model.disabled).toBe(false));
});

it('keeps inline account and model changes locked after identity lookup failure until retry confirms an ordinary chat', async () => {
  let attempts = 0;
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).includes('/home/briefing-chats')
      ? ++attempts === 1
        ? new Response('', { status: 503 })
        : new Response('[]')
      : new Response(
          JSON.stringify({
            accountBinding: { accountId: 'work', accountLabel: 'Work OpenAI', model: 'luna' },
            modelSelection: { model: 'luna', models: [{ id: 'luna', label: 'Luna' }] },
          }),
        ),
  );
  const store = createTestStore();
  store.setState({ sessions: { ...store.getState().sessions, active: 'restored' } });
  render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter initialEntries={['/chat/restored']}>
        <Routes>
          <Route path="/chat/:sessionId" element={<ChatView />} />
        </Routes>
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  const retry = await screen.findByRole('button', { name: 'Retry briefing lookup' });
  expect((screen.getByLabelText('Model') as HTMLSelectElement).disabled).toBe(true);
  expect(screen.getByText('Work OpenAI', { selector: '.chat-account-binding' })).toBeTruthy();
  fireEvent.click(retry);
  await waitFor(() =>
    expect((screen.getByLabelText('Model') as HTMLSelectElement).disabled).toBe(false),
  );
  expect(screen.queryByRole('button', { name: 'Retry briefing lookup' })).toBeNull();
});

it('updates web-search consent when the connection ID changes without a status change', () => {
  const store = createTestStore();
  store.setState({
    connection: { ...store.getState().connection, status: 'connected', clientId: 'connection-one' },
  });
  render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter>
        <ChatView />
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  expect(screen.getByTestId('web-search-connection').textContent).toBe('connection-one');

  act(() =>
    store.setState({
      connection: { ...store.getState().connection, clientId: 'connection-two' },
    }),
  );
  expect(screen.getByTestId('web-search-connection').textContent).toBe('connection-two');
});

it('passes concurrent seat streams to the shared mobile ChatArea', () => {
  const store = createTestStore();
  store.setState((state) => ({
    messages: {
      ...state.messages,
      currentByMessage: {
        reviewer: { messageId: 'reviewer', blocks: new Map(), blockOrder: [] },
        architect: { messageId: 'architect', blocks: new Map(), blockOrder: [] },
      },
    },
  }));
  render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter>
        <ChatView />
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  expect(screen.getByTestId('active-seats').textContent).toContain('Active seats: 2');
});

it('does not speak when an assistant response completes on mobile', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => [] } as Response);
  const store = createTestStore();
  render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter>
        <ChatView />
      </MemoryRouter>
    </MitzoStoreProvider>,
  );

  act(() => {
    const dispatch = store.getState().dispatchMessages;
    dispatch({ type: 'MESSAGE_START', messageId: 'assistant-response' });
    dispatch({
      type: 'BLOCK_START',
      messageId: 'assistant-response',
      blockId: 'text',
      blockType: 'text',
    });
    dispatch({
      type: 'BLOCK_DELTA',
      messageId: 'assistant-response',
      blockId: 'text',
      blockType: 'text',
      delta: 'Do not auto-play me',
    });
    dispatch({ type: 'MESSAGE_END', messageId: 'assistant-response' });
  });

  expect(await screen.findByText('Messages: 1')).toBeTruthy();
  expect(voiceMocks.speak).not.toHaveBeenCalled();
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
    await waitFor(() => expect(store.getState().pendingSession?.prompt).toBe('Review this task'));
    expect(screen.getByText('Review this task')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry accounts' }));
    await screen.findByText('Work');
    fireEvent.click(screen.getByRole('button', { name: 'Use Work · Sonnet' }));
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

it('reviews distinct launches with identical prompt text before sending', async () => {
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
  if (screen.getByRole('button', { name: /^Workspace/ }).getAttribute('aria-expanded') === 'false')
    fireEvent.click(screen.getByRole('button', { name: /^Workspace/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Use Work · Sonnet' }));
  for (const telosTaskId of ['task-a', 'task-b']) {
    act(() =>
      store
        .getState()
        .setPendingSession({ prompt: 'Review this task', context: telosTaskId, telosTaskId }),
    );
    await screen.findByRole('button', { name: 'Send launch prompt' });
    if (telosTaskId === 'task-b') {
      expect(
        (screen.getByRole('button', { name: 'Send launch prompt' }) as HTMLButtonElement).disabled,
      ).toBe(true);
      fireEvent.click(await screen.findByRole('button', { name: 'Use Work · Sonnet' }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Send launch prompt' }));
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

it('keeps mobile session details inside the expanded workspace controls', async () => {
  localStorage.removeItem('mitzo-workspace-controls-expanded');
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
  expect(screen.getByText('Isolated workspace').closest('[hidden]')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Workspace/ }));
  expect(screen.getByText('Isolated workspace').closest('[hidden]')).toBeNull();
  const summary = screen.getByText('Session details');
  fireEvent.click(summary);
  expect(summary.closest('details')?.textContent).toContain('session/mobile');
  expect(summary.closest('details')?.textContent).toContain('mobile-worktree');
  expect(summary.closest('details')?.textContent).toContain('mobile-session');
});

it('shows conversation history loading explicitly', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => [] } as Response);
  const store = createTestStore();
  render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter>
        <ChatView />
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  act(() => store.setState({ historyLoading: true }));
  expect(screen.getByText('Loading conversation…')).toBeTruthy();
  act(() => store.setState({ historyLoading: false }));
  expect(screen.queryByText('Loading conversation…')).toBeNull();
});

it('shows the profile, model and thinking in the collapsed workspace header', async () => {
  localStorage.removeItem('mitzo-workspace-controls-expanded');
  const catalog = [
    {
      id: 'work',
      label: 'Work Vertex',
      models: [
        {
          id: 'luna',
          label: 'Luna',
          reasoningEfforts: ['low', 'high'],
          defaultReasoningEffort: 'high',
        },
      ],
    },
  ];
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => catalog } as Response);
  const store = createTestStore();
  render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter>
        <ChatView />
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  const toggle = screen.getByRole('button', { name: /Workspace controls/ });
  expect(await within(toggle).findByText('Work Vertex')).toBeTruthy();
  expect(within(toggle).getByText('Luna')).toBeTruthy();
  expect(within(toggle).getByText('Thinking: high')).toBeTruthy();
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('combobox')).toBeNull();
});

it('groups web search settings under the existing header disclosure', async () => {
  localStorage.removeItem('mitzo-workspace-controls-expanded');
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => [] } as Response);
  const store = createTestStore();
  render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter>
        <ChatView />
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  const settings = screen.getByTestId('web-search-connection');
  expect(settings.closest('[hidden]')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Workspace controls/ }));
  expect(settings.closest('[hidden]')).toBeNull();
});

it('hides ordinary suspend and permission controls on the mobile Symposium surface', async () => {
  localStorage.setItem('mitzo-workspace-controls-expanded', '1');
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      ({
        ok: true,
        json: async () =>
          String(url).endsWith('/meta')
            ? { sessionType: 'symposium' }
            : String(url).endsWith('/status')
              ? { sessionId: 'native-chat', config: null, seats: [] }
              : [],
      }) as Response,
  );
  const store = createTestStore();
  const closeSession = vi.fn();
  store.setState({
    sessions: { ...store.getState().sessions, active: 'native-chat' },
    closeSession,
    fetchSessionMeta: async () => {},
  });
  render(
    <MemoryRouter initialEntries={['/chat/native-chat']}>
      <MitzoStoreProvider value={store}>
        <Routes>
          <Route path="/chat/:sessionId" element={<ChatView />} />
        </Routes>
      </MitzoStoreProvider>
    </MemoryRouter>,
  );
  await screen.findByText('Symposium');
  expect(screen.queryByRole('button', { name: 'Ask' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Auto' })).toBeNull();
  expect(screen.queryByTitle('Close session')).toBeNull();
  expect(screen.queryByTestId('web-search-connection')).toBeNull();
  expect(screen.queryByText('Ready')).toBeNull();
  expect(screen.getByText('Agent chat')).toBeTruthy();
  expect(screen.queryByText(/Each agent has its own account/)).toBeNull();
  expect(closeSession).not.toHaveBeenCalled();
});

it('requires a fresh account confirmation when New chat replaces an unsent draft', async () => {
  localStorage.removeItem('mitzo-default-account-model');
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => [
      { id: 'personal', label: 'Personal', models: [{ id: 'luna', label: 'Luna' }] },
    ],
  } as Response);
  const store = createTestStore();
  render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter initialEntries={['/chat']}>
        <ChatView />
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  const workspace = screen.getByRole('button', { name: /Workspace controls/ });
  if (workspace.getAttribute('aria-expanded') === 'false') fireEvent.click(workspace);
  fireEvent.click(await screen.findByRole('button', { name: 'Use Personal · Luna' }));
  expect(screen.queryByRole('button', { name: 'Use Personal · Luna' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  expect(await screen.findByRole('button', { name: 'Use Personal · Luna' })).toBeTruthy();
});

it('blocks an unprepared repository and forwards its receipt with the first prompt', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => [{ id: 'work', label: 'Work', models: [{ id: 'sonnet', label: 'Sonnet' }] }],
  } as Response);
  const store = createTestStore();
  const sendMessage = vi.fn();
  store.setState({ sendMessage });
  render(
    <MemoryRouter>
      <MitzoStoreProvider value={store}>
        <ChatView />
      </MitzoStoreProvider>
    </MemoryRouter>,
  );
  if (screen.getByRole('button', { name: /^Workspace/ }).getAttribute('aria-expanded') === 'false')
    fireEvent.click(screen.getByRole('button', { name: /^Workspace/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Use Work · Sonnet' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Block repository launch' }));
  expect((screen.getByRole('button', { name: 'Test send' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Ready repository launch' }));
  fireEvent.click(screen.getByRole('button', { name: 'Test send' }));
  expect(sendMessage).toHaveBeenCalledWith(
    'hello',
    expect.objectContaining({ repositoryWorkspaceId: '8ca30b0d-3e65-4eeb-8244-f6277350818f' }),
  );
});

it('blocks a saved repository before the picker reports any selection', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => [{ id: 'work', label: 'Work', models: [{ id: 'sonnet', label: 'Sonnet' }] }],
  } as Response);
  sessionStorage.setItem(
    'mitzo-repository-draft:work:sonnet',
    '8ca30b0d-3e65-4eeb-8244-f6277350818f',
  );
  const store = createTestStore();
  const sendMessage = vi.fn();
  store.setState({ sendMessage });
  render(
    <MemoryRouter>
      <MitzoStoreProvider value={store}>
        <ChatView />
      </MitzoStoreProvider>
    </MemoryRouter>,
  );
  if (screen.getByRole('button', { name: /^Workspace/ }).getAttribute('aria-expanded') === 'false')
    fireEvent.click(screen.getByRole('button', { name: /^Workspace/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Use Work · Sonnet' }));

  expect((screen.getByRole('button', { name: 'Test send' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Test send' }));
  expect(sendMessage).not.toHaveBeenCalled();
});

it.each([true, false])(
  'consumes a repository receipt only after its matching send is assigned: %s',
  async (queued) => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 'work', label: 'Work', models: [{ id: 'sonnet', label: 'Sonnet' }] },
      ],
    } as Response);
    const key = 'mitzo-repository-draft:work:sonnet';
    const receipt = '8ca30b0d-3e65-4eeb-8244-f6277350818f';
    sessionStorage.setItem(key, receipt);
    const store = createTestStore();
    const sendMessage = vi.fn(
      (_text: string, _options?: { onSessionAssigned?: (id: string) => void }) => {},
    );
    store.setState({ sendMessage });
    render(
      <MemoryRouter>
        <MitzoStoreProvider value={store}>
          <ChatView />
        </MitzoStoreProvider>
      </MemoryRouter>,
    );
    if (
      screen.getByRole('button', { name: /^Workspace/ }).getAttribute('aria-expanded') === 'false'
    )
      fireEvent.click(screen.getByRole('button', { name: /^Workspace/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use Work · Sonnet' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ready repository launch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test send' }));
    expect(sessionStorage.getItem(key)).toBe(receipt);
    act(() =>
      store.setState({ sessions: { ...store.getState().sessions, active: 'assigned-chat' } }),
    );
    expect(sessionStorage.getItem(key)).toBe(receipt);
    if (queued) act(() => sendMessage.mock.calls[0][1]?.onSessionAssigned?.('assigned-chat'));
    await waitFor(() => expect(sessionStorage.getItem(key)).toBe(queued ? null : receipt));
  },
);

it('keeps Stop pending until server state confirms completion', () => {
  const store = createTestStore();
  const stop = vi.fn();
  store.setState({
    messages: { ...store.getState().messages, running: true },
    stopGeneration: stop,
  });
  render(
    <MemoryRouter>
      <MitzoStoreProvider value={store}>
        <ChatView />
      </MitzoStoreProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Test Stop' }));
  expect(stop).toHaveBeenCalledTimes(1);
  expect(store.getState().messages.running).toBe(true);
  expect(screen.getByTestId('composer-running').textContent).toBe('true');
});
