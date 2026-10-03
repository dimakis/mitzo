// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { createTestStore } from '../../test-utils/createTestStore';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { INITIAL_MESSAGES_STATE, messagesReducer } from '@mitzo/client';

const voiceMocks = vi.hoisted(() => ({
  speak: vi.fn(),
  stopSpeaking: vi.fn(),
}));

vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: {
    on: vi.fn(() => vi.fn()),
    onConnectionChange: vi.fn(() => vi.fn()),
    connected: false,
  },
}));

// Mock all heavy sub-components to isolate DesktopChatView wiring
vi.mock('../../components/DesktopShell', () => ({
  DesktopShell: ({ left, center, right, statusBar }: Record<string, React.ReactNode>) => (
    <div>
      <div data-testid="left">{left}</div>
      <div data-testid="center">{center}</div>
      <div data-testid="right">{right}</div>
      {statusBar && <div data-testid="status">{statusBar}</div>}
    </div>
  ),
}));

vi.mock('../../components/SessionPanel', () => ({
  SessionPanel: () => <div data-testid="session-panel">SessionPanel</div>,
}));

vi.mock('../../components/CommandCenter', () => ({
  CommandCenter: () => <div data-testid="command-center">CommandCenter</div>,
}));

vi.mock('../../components/ChatArea', () => ({
  ChatArea: ({
    messages,
    currentByMessage,
  }: {
    messages: unknown[];
    currentByMessage?: Record<string, unknown>;
  }) => (
    <div data-testid="chat-area">
      <span>Messages: {messages.length}</span>
      <span data-testid="active-seats">
        Active seats: {Object.keys(currentByMessage ?? {}).length}
      </span>
    </div>
  ),
}));

vi.mock('../../components/VoiceSettings', () => ({
  VoiceSettings: () => <div data-testid="voice-settings">Voice</div>,
}));

vi.mock('../../components/WebSearchConsent', () => ({
  WebSearchConsent: ({ connectionId }: { connectionId: string | null }) => (
    <span data-testid="web-search-connection">{connectionId ?? 'none'}</span>
  ),
}));

vi.mock('../../components/ChatInput', () => ({
  ChatInput: ({
    externalContextBlocks,
    sendDisabledReason,
    onSend,
  }: {
    externalContextBlocks?: string[];
    sendDisabledReason?: string;
    onSend: (text: string) => boolean;
  }) => (
    <div data-testid="chat-input">
      <span>{sendDisabledReason}</span>
      <button disabled={!!sendDisabledReason} onClick={() => onSend('hello')}>
        Test send
      </button>
      external: {externalContextBlocks ? externalContextBlocks.length : 'none'}
    </div>
  ),
}));

vi.mock('../../components/StatusBar', () => ({
  StatusBar: ({ connected }: { connected: boolean }) => (
    <div data-testid="status-bar">connected: {String(connected)}</div>
  ),
}));

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

import { DesktopChatView } from '../DesktopChatView';

function createMockStore() {
  const store = createTestStore();
  store.setState({
    getTransportConnectionId: () => null,
    sessions: { list: [], active: null, loading: false },
    messages: INITIAL_MESSAGES_STATE,
    connection: { status: 'connected', clientId: null },
    permissions: { pending: null },
    tasks: {
      tree: [],
      loopStatus: {
        state: 'idle',
        goalId: null,
        activeTaskId: null,
        progress: null,
        specMode: false,
        awaitingApproval: false,
        spawnEnabled: false,
      },
    },
    workload: { items: [], profiles: [] },
    inbox: { items: [], count: 0 },
    calendar: { events: [], sprints: [] },
    todos: { items: [], profiles: [] },
    config: { contextBlocks: {}, skills: [], mode: 'agent', modelId: 'claude-sonnet-4-6' },
    tokens: {
      agentContext: 0,
      contextCeiling: 200_000,
      sessionTotal: 0,
      numTurns: 0,
      turnIndex: 0,
      numCompactions: 0,
    },
    progress: { blocks: {}, toolIndex: {} },
    sendError: null,
    sendStatus: null,
    historyLoading: false,
    historyError: null,
    modeChangeReady: true,
    dispatchMessages: vi.fn(),
    getConnectionId: () => null,
    switchSession: vi.fn().mockResolvedValue(undefined),
    newSession: vi.fn(),
    sendMessage: vi.fn(),
    interruptMessage: vi.fn(),
    stopGeneration: vi.fn(),
    respondToPermission: vi.fn(),
    expirePermission: vi.fn(),
    setMode: vi.fn(),
    setModel: vi.fn(),
    loadSessions: vi.fn().mockResolvedValue(undefined),
    refreshSessions: vi.fn().mockResolvedValue(undefined),
    fetchSessionMeta: vi.fn().mockResolvedValue(undefined),
    loadTasks: vi.fn().mockResolvedValue(undefined),
    loadLoopStatus: vi.fn().mockResolvedValue(undefined),
    createTask: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    startLoop: vi.fn().mockResolvedValue(undefined),
    pauseLoop: vi.fn().mockResolvedValue(undefined),
    resumeLoop: vi.fn().mockResolvedValue(undefined),
    stopLoop: vi.fn().mockResolvedValue(undefined),
    setSpawnEnabled: vi.fn().mockResolvedValue(undefined),
    approveTask: vi.fn().mockResolvedValue(undefined),
    rejectTask: vi.fn().mockResolvedValue(undefined),
    approveSpec: vi.fn().mockResolvedValue(undefined),
    rejectSpec: vi.fn().mockResolvedValue(undefined),
    refreshTasks: vi.fn(),
    loadInbox: vi.fn().mockResolvedValue(undefined),
    loadTodos: vi.fn().mockResolvedValue(undefined),
    pendingSession: null,
    setPendingSession: vi.fn(),
    clearPendingSession: vi.fn(),
    invalidateAuthentication: vi.fn(),
    restoreAuthentication: vi.fn(),
    forceReconnect: vi.fn(),
    sendSuspend: vi.fn(),
    closeSession: vi.fn().mockResolvedValue(undefined),
  });
  store.setState({
    dispatchMessages: (action) =>
      store.setState((state) => ({ messages: messagesReducer(state.messages, action) })),
  });
  return store;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: 'test', label: 'Test account', models: [{ id: 'luna', label: 'Luna' }] },
        ]),
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderWithRouter(sessionId?: string) {
  const path = sessionId ? `/chat/${sessionId}` : '/chat';
  const store = createMockStore();
  return render(
    <MemoryRouter initialEntries={[path]}>
      <MitzoStoreProvider value={store}>
        <DesktopChatView />
      </MitzoStoreProvider>
    </MemoryRouter>,
  );
}

describe('DesktopChatView', () => {
  it('updates web-search consent when the connection ID changes without a status change', () => {
    const store = createMockStore();
    store.setState({
      connection: { ...store.getState().connection, clientId: 'connection-one' },
    });
    render(
      <MemoryRouter>
        <MitzoStoreProvider value={store}>
          <DesktopChatView />
        </MitzoStoreProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('web-search-connection').textContent).toBe('connection-one');

    act(() =>
      store.setState({
        connection: { ...store.getState().connection, clientId: 'connection-two' },
      }),
    );
    expect(screen.getByTestId('web-search-connection').textContent).toBe('connection-two');
  });

  it('passes concurrent seat streams to the shared ChatArea', () => {
    const store = createMockStore();
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
      <MemoryRouter>
        <MitzoStoreProvider value={store}>
          <DesktopChatView />
        </MitzoStoreProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('active-seats').textContent).toContain('Active seats: 2');
  });
  it('renders three-panel layout', () => {
    renderWithRouter();
    expect(screen.getByTestId('session-panel')).toBeTruthy();
    expect(screen.getByTestId('chat-area')).toBeTruthy();
    expect(screen.getByTestId('command-center')).toBeTruthy();
  });

  it('renders session panel in left slot', () => {
    renderWithRouter();
    const left = screen.getByTestId('left');
    expect(left.querySelector('[data-testid="session-panel"]')).toBeTruthy();
  });

  it('renders chat area and input in center slot', () => {
    renderWithRouter();
    const center = screen.getByTestId('center');
    expect(center.querySelector('[data-testid="chat-area"]')).toBeTruthy();
    expect(center.querySelector('[data-testid="chat-input"]')).toBeTruthy();
  });

  it('renders command center in right slot', () => {
    renderWithRouter();
    const right = screen.getByTestId('right');
    expect(right.querySelector('[data-testid="command-center"]')).toBeTruthy();
  });

  it('renders status bar', () => {
    renderWithRouter();
    expect(screen.getByTestId('status-bar')).toBeTruthy();
  });

  it('lets ChatInput manage its own context selection', () => {
    renderWithRouter();
    expect(screen.getByTestId('chat-input').textContent).toContain('external: none');
  });

  it('renders model selector and mode pills in center header', async () => {
    renderWithRouter();
    const center = screen.getByTestId('center');
    expect(await screen.findByLabelText('Model')).toBeTruthy();
    expect(center.querySelector('.mode-pills')).toBeTruthy();
  });

  it('keeps the voice picker without exposing an automatic response-speech toggle', () => {
    renderWithRouter();
    expect(screen.getByTestId('voice-settings')).toBeTruthy();
    expect(screen.queryByTitle(/text-to-speech/)).toBeNull();
  });

  it('does not speak when an assistant response completes', async () => {
    const store = createMockStore();
    render(
      <MemoryRouter>
        <MitzoStoreProvider value={store}>
          <DesktopChatView />
        </MitzoStoreProvider>
      </MemoryRouter>,
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
});

it('uses the account catalog on desktop and sends the explicit subscription choice', async () => {
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    json: async () => [
      { id: 'personal', label: 'My subscription', models: [{ id: 'luna', label: 'Luna' }] },
    ],
  } as Response);
  const store = createMockStore();
  render(
    <MemoryRouter>
      <MitzoStoreProvider value={store}>
        <DesktopChatView />
      </MitzoStoreProvider>
    </MemoryRouter>,
  );
  await screen.findByLabelText('Account');
  expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('luna');
  fireEvent.click(screen.getByRole('button', { name: /^Workspace/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Use My subscription · Luna' }));
  fireEvent.click(screen.getByText('Test send'));
  expect(store.getState().sendMessage).toHaveBeenCalledWith(
    'hello',
    expect.objectContaining({ accountId: 'personal', model: 'luna' }),
  );
});

it('explains why sending is disabled while desktop accounts load', () => {
  vi.mocked(fetch).mockReturnValue(new Promise(() => {}));
  const store = createMockStore();
  render(
    <MemoryRouter>
      <MitzoStoreProvider value={store}>
        <DesktopChatView />
      </MitzoStoreProvider>
    </MemoryRouter>,
  );
  expect(screen.getByText('Select an account before sending.')).toBeTruthy();
  expect((screen.getByText('Test send') as HTMLButtonElement).disabled).toBe(true);
});

it('keeps the active mode selected until the store receives server confirmation', () => {
  const store = createMockStore();
  store.setState((s) => ({ sessions: { ...s.sessions, active: 'active-session' } }));
  render(
    <MemoryRouter>
      <MitzoStoreProvider value={store}>
        <DesktopChatView />
      </MitzoStoreProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: /^Workspace/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
  expect(store.getState().setMode).toHaveBeenCalledWith('auto');
  expect(screen.getByRole('button', { name: 'Agent' }).className).toContain('mode-pill--active');
  expect(screen.getByRole('button', { name: 'Auto' }).className).not.toContain('mode-pill--active');
});

it('disables mode controls while a new chat starts', () => {
  const store = createMockStore();
  store.setState({ modeChangeReady: false });
  render(
    <MemoryRouter>
      <MitzoStoreProvider value={store}>
        <DesktopChatView />
      </MitzoStoreProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: /^Workspace/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
  expect(store.getState().setMode).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'Auto' }) as HTMLButtonElement).disabled).toBe(true);
});

it('shows reconnecting in collapsed workspace settings when disconnected', () => {
  const store = createMockStore();
  store.setState((s) => ({ connection: { ...s.connection, status: 'disconnected' } }));
  render(
    <MemoryRouter>
      <MitzoStoreProvider value={store}>
        <DesktopChatView />
      </MitzoStoreProvider>
    </MemoryRouter>,
  );
  const toggle = screen.getByRole('button', { name: /^Workspace/ });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(toggle.textContent).toContain('Reconnecting');
});

it('offers the shared reviewer entry for an active desktop conversation', () => {
  const store = createMockStore();
  store.setState((state) => ({ sessions: { ...state.sessions, active: 'active-session' } }));
  render(
    <MemoryRouter>
      <MitzoStoreProvider value={store}>
        <DesktopChatView />
      </MitzoStoreProvider>
    </MemoryRouter>,
  );
  expect(screen.queryByRole('button', { name: 'Add reviewer' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Workspace controls/ }));
  expect(screen.getByRole('button', { name: 'Add reviewer' })).toBeTruthy();
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
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => catalog } as Response);
  renderWithRouter();
  const toggle = screen.getByRole('button', { name: /Workspace controls/ });
  expect(await within(toggle).findByText('Work Vertex')).toBeTruthy();
  expect(within(toggle).getByText('Luna')).toBeTruthy();
  expect(within(toggle).getByText('Thinking: high')).toBeTruthy();
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('combobox')).toBeNull();
});

it('groups web search settings under the existing header disclosure', async () => {
  localStorage.removeItem('mitzo-workspace-controls-expanded');
  renderWithRouter();
  const settings = screen.getByTestId('web-search-connection');
  expect(settings.closest('[hidden]')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Workspace controls/ }));
  expect(settings.closest('[hidden]')).toBeNull();
});

it('reviews a Telos launch, sends the chosen account once, and follows its assigned session', async () => {
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    json: async () => [
      { id: 'work', label: 'Work Vertex', models: [{ id: 'opus', label: 'Opus' }] },
      { id: 'test', label: 'Personal ChatGPT', models: [{ id: 'luna', label: 'Luna' }] },
    ],
  } as Response);
  const store = createMockStore();
  const launch = {
    prompt: 'Review Telos task',
    context: 'Task context',
    telosTaskId: 'task-a',
    agentName: 'mitzo-telos',
  };
  store.setState({
    pendingSession: launch,
    clearPendingSession: () => store.setState({ pendingSession: null }),
  });
  function Location() {
    return <div data-testid="location">{useLocation().pathname}</div>;
  }
  render(
    <MemoryRouter initialEntries={['/chat']}>
      <MitzoStoreProvider value={store}>
        <Location />
        <Routes>
          <Route path="/chat/:sessionId?" element={<DesktopChatView />} />
        </Routes>
      </MitzoStoreProvider>
    </MemoryRouter>,
  );
  await screen.findByRole('button', { name: 'Send launch prompt' });
  expect(store.getState().sendMessage).not.toHaveBeenCalled();
  fireEvent.change(await screen.findByRole('combobox', { name: 'Account' }), {
    target: { value: 'test' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send launch prompt' }));
  expect(store.getState().sendMessage).toHaveBeenCalledExactlyOnceWith(
    'Review Telos task',
    expect.objectContaining({
      accountId: 'test',
      model: 'luna',
      telosTaskId: 'task-a',
      agentName: 'mitzo-telos',
    }),
  );
  expect(store.getState().messages.sessionContext).toBe('Task context');
  act(() => store.setState((s) => ({ sessions: { ...s.sessions, active: 'target-session' } })));
  await waitFor(() =>
    expect(screen.getByTestId('location').textContent).toBe('/chat/target-session'),
  );
  expect(store.getState().sessions.active).toBe('target-session');
});

it('adopts a target assigned in the same render batch as clearing the previous chat', async () => {
  const store = createMockStore();
  store.setState({
    sessions: { ...store.getState().sessions, active: 'old-session' },
    newSession: () => {
      store.setState((s) => ({ sessions: { ...s.sessions, active: null } }));
      store.setState((s) => ({ sessions: { ...s.sessions, active: 'target-session' } }));
    },
  });
  function Location() {
    return <div data-testid="location">{useLocation().pathname}</div>;
  }
  render(
    <MemoryRouter initialEntries={['/chat']}>
      <MitzoStoreProvider value={store}>
        <Location />
        <Routes>
          <Route path="/chat/:sessionId?" element={<DesktopChatView />} />
        </Routes>
      </MitzoStoreProvider>
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(screen.getByTestId('location').textContent).toBe('/chat/target-session'),
  );
});

it('reviews a carried launch in its own desktop draft before confirming the account and sending', async () => {
  vi.mocked(fetch).mockImplementation(
    async (url) =>
      ({
        ok: true,
        json: async () =>
          String(url).endsWith('/symposium')
            ? { sessionId: 'unrelated', seats: [], config: null }
            : String(url).includes('/accounts')
              ? [
                  {
                    id: 'personal',
                    label: 'Personal ChatGPT',
                    models: [{ id: 'luna', label: 'Luna' }],
                  },
                ]
              : [],
      }) as Response,
  );
  const store = createTestStore();
  const sendMessage = vi.fn();
  store.setState({
    sessions: { ...store.getState().sessions, active: 'unrelated' },
    pendingSession: { prompt: 'Launch', context: 'Telos', telosTaskId: 'task' },
    sendMessage,
  });
  function Location() {
    return <div data-testid="location">{useLocation().pathname}</div>;
  }
  render(
    <MemoryRouter initialEntries={['/chat/unrelated']}>
      <MitzoStoreProvider value={store}>
        <Location />
        <Routes>
          <Route path="/chat/:sessionId?" element={<DesktopChatView />} />
        </Routes>
      </MitzoStoreProvider>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Review launch in new chat' }));
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/chat'));
  expect(sendMessage).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole('button', { name: 'Use Personal ChatGPT · Luna' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send launch prompt' }));
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
    'Launch',
    expect.objectContaining({ accountId: 'personal', model: 'luna', telosTaskId: 'task' }),
  );
});
