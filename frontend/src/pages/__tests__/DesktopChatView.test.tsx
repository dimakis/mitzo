// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createStore } from 'zustand/vanilla';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import type { MitzoStoreState } from '@mitzo/client';
import { INITIAL_MESSAGES_STATE } from '@mitzo/client';

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
  ChatArea: () => <div data-testid="chat-area">ChatArea</div>,
}));

vi.mock('../../components/VoiceSettings', () => ({
  VoiceSettings: () => <div data-testid="voice-settings">Voice</div>,
}));

vi.mock('../../components/ChatInput', () => ({
  ChatInput: ({ externalContextBlocks }: { externalContextBlocks?: string[] }) => (
    <div data-testid="chat-input">
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
    ttsEnabled: false,
    ttsAvailable: false,
    speaking: false,
    voices: [],
    selectedVoice: '',
    speak: vi.fn(),
    stopSpeaking: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    cancelRecording: vi.fn(),
    setTtsEnabled: vi.fn(),
    setVoice: vi.fn(),
    partialTranscript: '',
  }),
}));

vi.mock('../../hooks/useAutoSpeak', () => ({
  useAutoSpeak: vi.fn(),
}));

import { DesktopChatView } from '../DesktopChatView';

function createMockStore() {
  return createStore<MitzoStoreState>(() => ({
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
    calendar: { events: [], sprints: [], loading: false },
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
    dispatchMessages: vi.fn(),
    switchSession: vi.fn().mockResolvedValue(undefined),
    newSession: vi.fn(),
    sendMessage: vi.fn(),
    interruptMessage: vi.fn(),
    stopGeneration: vi.fn(),
    respondToPermission: vi.fn(),
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
    forceReconnect: vi.fn(),
    sendSuspend: vi.fn(),
    closeSession: vi.fn().mockResolvedValue(undefined),
  }));
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ contextBlocks: {}, fileViewerRoots: [] }),
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

  it('renders model selector and mode pills in center header', () => {
    renderWithRouter();
    const center = screen.getByTestId('center');
    expect(center.querySelector('.chat-model-select')).toBeTruthy();
    expect(center.querySelector('.mode-pills')).toBeTruthy();
  });

  it('renders voice settings in center header', () => {
    renderWithRouter();
    expect(screen.getByTestId('voice-settings')).toBeTruthy();
  });
});
