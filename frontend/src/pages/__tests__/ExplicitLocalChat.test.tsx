import { createChatDraft, saveChatDraft } from '../../lib/chat-drafts';
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { createTestStore } from '../../test-utils/createTestStore';
import { apiFetch } from '../../lib/api-fetch';
import { ChatView } from '../ChatView';
import { DesktopChatView } from '../DesktopChatView';
import { localInventoryFixture } from '../../test-utils/local-inventory-fixture';
import { createChatRuntimeSelection } from '../../lib/chat-runtime-selection';
import { getChatDraft } from '../../lib/chat-drafts';
import '@testing-library/jest-dom/vitest';
vi.mock('../../components/DesktopShell', () => ({
  DesktopShell: ({ center }: { center: React.ReactNode }) => <div>{center}</div>,
}));
vi.mock('../../components/SessionPanel', () => ({ SessionPanel: () => null }));
vi.mock('../../components/CommandCenter', () => ({ CommandCenter: () => null }));

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
    composerGeneration,
  }: {
    initialText?: string;
    onStop: () => void;
    running: boolean;
    onSend?: (
      text: string,
      images?: never[],
      context?: string[],
      receipt?: (status: 'accepted' | 'failed' | 'uncertain') => void,
      assigned?: (id: string) => void,
    ) => boolean;
    sendDisabledReason?: string;
    composerGeneration?: number;
  }) => (
    <>
      <div data-testid="draft">{initialText}</div>
      <span data-testid="composer-running">{String(running)}</span>
      <span data-testid="composer-generation">{composerGeneration}</span>
      <button onClick={onStop}>Test Stop</button>
      <button
        disabled={!!sendDisabledReason}
        onClick={() =>
          onSend?.(
            'hello',
            undefined,
            undefined,
            () => {},
            () => {},
          )
        }
      >
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

const readyId = '8ca30b0d-3e65-4eeb-8244-f6277350818f';
function setup(
  Screen: typeof ChatView,
  savedLocal = false,
  disabled = false,
  bound = false,
  metadataFailed = false,
) {
  const fixture = localInventoryFixture();
  const draft = createChatDraft();
  draft.text = 'hello';
  const intent = {
    ...createChatRuntimeSelection(),
    account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
    agentProfile: { profileId: 'agent', revision: 1 },
    execution: { location: 'local' as const, targetId: 'mac' },
    capabilityRevision: 'caps-r1',
  };
  if (savedLocal) {
    draft.settings.runtimeSelection = intent;
    draft.settings.selection = intent.account;
  }
  saveChatDraft(draft);
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (url === '/api/chat/local-codex/capabilities')
      return disabled
        ? new Response(JSON.stringify({ code: 'entry_disabled' }), { status: 503 })
        : new Response(JSON.stringify(fixture));
    if (String(url).endsWith('/meta'))
      return metadataFailed
        ? new Response('{}', { status: 503 })
        : new Response(
            JSON.stringify({
              sessionType: 'chat',
              accountBinding: {
                accountId: 'personal',
                accountLabel: 'Personal ChatGPT',
                model: 'luna-fixture',
              },
              modelSelection: {
                model: 'luna-fixture',
                models: fixture.accounts[0].models,
                reasoningEffort: 'low',
              },
              runtimeCommandScope: 'first-command-only',
              runtimeBinding: {
                version: 2,
                account: fixture.accounts[0].account,
                harness: { implementation: 'codex' },
                execution: { location: 'local', targetId: 'mac', targetRevision: 'r1' },
              },
            }),
          );
    if (String(url).endsWith('/symposium/status'))
      return new Response(JSON.stringify({ sessionId: 'bound-session', config: null, seats: [] }));
    return new Response('[]');
  });
  const store = createTestStore();
  const localSend = vi.fn(
    (_request: import('@mitzo/protocol').LocalCodexFirstCommand, _observers?: unknown) => true,
  );
  const legacySend = vi.fn();
  store.setState({
    localFirstCommandTransportAvailable: true,
    connection: { status: 'connected', clientId: 'sse-current' },
    sendLocalFirstCommand: localSend,
    sendMessage: legacySend,
    ...(bound ? { sessions: { ...store.getState().sessions, active: 'bound-session' } } : {}),
  });
  render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter initialEntries={[bound ? '/chat/bound-session' : `/chat?draft=${draft.id}`]}>
        <Routes>
          <Route path="/chat" element={<Screen />} />
          <Route path="/chat/:sessionId" element={<Screen />} />
        </Routes>
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  return {
    store,
    localSend,
    legacySend,
    draft,
    fixture,
    recoverMetadata: () => {
      metadataFailed = false;
    },
  };
}
for (const [name, Screen] of [
  ['mobile', ChatView],
  ['desktop', DesktopChatView],
] as const) {
  it(`${name}: untouched OpenShell stays blocked, explicit Local dispatches only exact dedicated intent`, async () => {
    const { localSend, legacySend } = setup(Screen);
    const workspace = screen.getByRole('button', { name: /^Workspace controls/ });
    if (workspace.getAttribute('aria-expanded') !== 'true') fireEvent.click(workspace);
    await screen.findByRole('option', { name: 'Local · This Mac' });
    expect(screen.getByRole('combobox', { name: 'Run on' })).toHaveValue('openshell');
    expect(screen.getByRole('button', { name: 'Test send' })).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Run on' }), {
      target: { value: 'local:mac' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Account' }), {
      target: { value: 'personal' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Thinking' }), {
      target: { value: 'low' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), {
      target: { value: JSON.stringify(['saved', 'agent', 1]) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use these Local choices' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ready repository launch' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Test send' }));
    expect(localSend).toHaveBeenCalledTimes(1);
    expect(localSend.mock.calls[0][0]).toMatchObject({
      runOn: 'local',
      repositoryWorkspaceId: readyId,
      capabilityRevision: 'caps-r1',
      runtime: {
        account: { accountId: 'personal', profileRevision: 'routing-r1' },
        targetId: 'mac',
      },
      selection: {
        agent: { profileId: 'agent', revision: 1 },
        model: 'luna-fixture',
        thinking: 'low',
      },
      payload: { text: 'hello' },
    });
    expect(legacySend).not.toHaveBeenCalled();
  });
  it(`${name}: restored Local stays visible and blocked when the route gate is off`, async () => {
    const { localSend, legacySend, draft } = setup(Screen, true, true);
    const workspace = screen.getByRole('button', { name: /^Workspace controls/ });
    if (workspace.getAttribute('aria-expanded') !== 'true') fireEvent.click(workspace);
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Run on' })).toHaveValue('local:mac'),
    );
    expect(screen.getByRole('button', { name: 'Test send' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Agent' })).toHaveValue(
      JSON.stringify(['saved', 'agent', 1]),
    );
    await waitFor(() =>
      expect(getChatDraft(draft.id)?.settings.runtimeSelection?.execution).toEqual({
        location: 'local',
        targetId: 'mac',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Test send' }));
    expect(localSend).not.toHaveBeenCalled();
    expect(legacySend).not.toHaveBeenCalled();
  });
  it(`${name}: metadata failure blocks sending and exposes retry without an inferred execution choice`, async () => {
    const { localSend, legacySend, recoverMetadata } = setup(Screen, false, false, true, true);
    const workspace = screen.getByRole('button', { name: /^Workspace controls/ });
    if (workspace.getAttribute('aria-expanded') !== 'true') fireEvent.click(workspace);
    const retry = await screen.findByRole('button', { name: 'Retry conversation settings' });
    expect(screen.queryByRole('combobox', { name: 'Run on' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Test send' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Test send' }));
    expect(localSend).not.toHaveBeenCalled();
    expect(legacySend).not.toHaveBeenCalled();
    recoverMetadata();
    fireEvent.click(retry);
    await screen.findByText('Run on: Local · first command only');
    expect(screen.getByRole('button', { name: 'Test send' })).toBeDisabled();
  });
  it(`${name}: immutable Local metadata disables follow-up, mode and web settings on reload`, async () => {
    const { legacySend } = setup(Screen, false, false, true);
    const workspace = screen.getByRole('button', { name: /^Workspace controls/ });
    if (workspace.getAttribute('aria-expanded') !== 'true') fireEvent.click(workspace);
    await screen.findByText('Run on: Local · first command only');
    expect(screen.getByRole('button', { name: 'Test send' })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Agent$/ })).toBeDisabled());
    expect(screen.queryByTestId('web-search-connection')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Test send' }));
    expect(legacySend).not.toHaveBeenCalled();
  });
}
