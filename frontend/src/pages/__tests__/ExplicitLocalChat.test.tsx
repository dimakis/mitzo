import { createChatDraft, saveChatDraft } from '../../lib/chat-drafts';
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { createTestStore } from '../../test-utils/createTestStore';
import { apiFetch } from '../../lib/api-fetch';
import { ChatView } from '../ChatView';
import { DesktopChatView } from '../DesktopChatView';
import { localInventoryFixture } from '../../test-utils/local-inventory-fixture';
import { createChatRuntimeSelection } from '../../lib/chat-runtime-selection';
import { getChatDraft } from '../../lib/chat-drafts';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_MITZO_PROFILE_ID,
  DEFAULT_MITZO_PROFILE_REVISION,
  defaultMitzoProfileDefinition,
  PROFILE_BUILDER_ID,
  PROFILE_BUILDER_REVISION,
  profileBuilderDefinition,
  type AgentLibraryVersion,
} from '@mitzo/protocol';
import { sha256Hex } from '../../lib/browser-crypto';
// Route wiring tests exercise the existing controls directly. The real sheet
// navigation, retained editors and summary layout are covered by QuickChatSettings
// unit tests and the all-intercept local-first/multi-runtime browser suites.
vi.mock('../../lib/quick-settings-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/quick-settings-context')>()),
  useQuickSettings: () => null,
}));

vi.mock('../../components/DesktopShell', () => ({
  DesktopShell: ({ center }: { center: React.ReactNode }) => <div>{center}</div>,
}));
vi.mock('../../components/SessionPanel', () => ({ SessionPanel: () => null }));
vi.mock('../../components/CommandCenter', () => ({ CommandCenter: () => null }));

vi.mock('../../components/RepositoryChatPicker', () => ({
  RepositoryChatPicker: ({
    onChange,
    ordinaryRuntime,
  }: {
    onChange: (
      value: import('../../components/RepositoryChatPicker').RepositoryChatSelection,
    ) => void;
    ordinaryRuntime?: {
      runOn: 'local' | 'openshell';
      runtime: {
        account: import('@mitzo/protocol').SessionRuntimeBindingV2['account'];
        harness: import('@mitzo/protocol').SessionRuntimeBindingV2['harness']['implementation'];
        targetId: string;
      };
    };
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
      <button
        onClick={() =>
          onChange({
            blocked: false,
            repositoryWorkspaceId: '8ca30b0d-3e65-4eeb-8244-f6277350818f',
            ...(ordinaryRuntime
              ? {
                  ordinaryRuntime: {
                    version: 2,
                    account: ordinaryRuntime.runtime.account,
                    harness: { implementation: ordinaryRuntime.runtime.harness },
                    execution: {
                      location: ordinaryRuntime.runOn,
                      targetId: ordinaryRuntime.runtime.targetId,
                      targetRevision: 'target-r1',
                    },
                  },
                }
              : {}),
          })
        }
      >
        Ready qualified repository launch
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
    afterMessages,
  }: {
    afterMessages?: React.ReactNode;
    messages: unknown[];
    currentByMessage?: Record<string, unknown>;
  }) => (
    <div>
      <span data-testid="chat-message-count">Messages: {messages.length}</span>
      {afterMessages}
      <span data-testid="active-seats">
        Active seats: {Object.keys(currentByMessage ?? {}).length}
      </span>
    </div>
  ),
}));
vi.mock('../../components/ChatInput', () => ({
  ChatInput: ({
    initialText,
    savedChatDraft,
    onSend,
    onStop,
    running,
    sendDisabledReason,
    composerGeneration,
    settings,
  }: {
    initialText?: string;
    savedChatDraft?: import('../../lib/chat-drafts').ChatDraft;
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
    settings?: React.ReactNode;
  }) => (
    <>
      <div className="chat-input" data-testid="composer-settings">
        {settings}
      </div>
      <div data-testid="draft">{initialText ?? savedChatDraft?.text}</div>
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
function AssignmentRouteProbe() {
  const navigate = useNavigate();
  return (
    <button onClick={() => navigate('/chat/unknown-session')}>Navigate before assignment</button>
  );
}
function setup(
  Screen: typeof ChatView,
  savedLocal = false,
  disabled = false,
  bound = false,
  metadataFailed = false,
  continuation = false,
  suppliedFixture?: import('../../lib/explicit-local-chat').ExplicitLocalInventory,
  ordinary?: 'prepared' | 'conversation' | 'invalid',
  builtin?: AgentLibraryVersion,
  apiHost = false,
) {
  const fixture: import('../../lib/explicit-local-chat').ExplicitLocalInventory =
    suppliedFixture ?? localInventoryFixture();
  if (apiHost) {
    const account = { ...fixture.accounts[0].account, provider: 'openai' as const };
    fixture.accounts[0] = { ...fixture.accounts[0], account, label: 'Work OpenAI API' };
    fixture.targets[0] = { ...fixture.targets[0], harness: 'responses' };
    fixture.routes[0] = { ...fixture.routes[0], account, harness: 'responses' };
  }
  if (builtin) (fixture.agentProfiles as AgentLibraryVersion[]).push(builtin);
  const draft = createChatDraft();
  draft.text = 'hello';
  if (suppliedFixture) {
    draft.images = [
      {
        data: 'b2ZmbGluZQ==',
        preview: 'data:image/png;base64,b2ZmbGluZQ==',
        mediaType: 'image/png',
      },
    ];
    draft.contextBlocks = ['Retained context'];
  }
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
    if (url === '/api/chat/runtime/capabilities')
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
              runtimeCommandScope:
                ordinary === 'prepared' || ordinary === 'invalid'
                  ? 'prepared-first-command'
                  : continuation || ordinary === 'conversation'
                    ? 'conversation'
                    : 'first-command-only',
              ...(ordinary
                ? { ordinaryWorkspaceId: ordinary === 'invalid' ? 'invalid' : readyId }
                : { repositoryWorkspaceId: readyId }),
              mode: 'agent',
              agentProfile: fixture.agentProfiles[0],
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
    (_request: import('@mitzo/protocol').OrdinaryCodexFirstCommand, _observers?: unknown) => true,
  );
  const ordinarySend = vi.fn(
    (
      _request: import('@mitzo/protocol').OrdinaryWorkspaceFirstCommand,
      _phase: 'first' | 'continue',
      _observers?: unknown,
    ) => true,
  );
  const legacySend = vi.fn();
  store.setState({
    localFirstCommandTransportAvailable: true,
    connection: { status: 'connected', clientId: 'sse-current' },
    sendLocalFirstCommand: localSend,
    sendOrdinaryWorkspaceCommand: ordinarySend,
    sendMessage: legacySend,
    ...(bound ? { sessions: { ...store.getState().sessions, active: 'bound-session' } } : {}),
  });
  render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter initialEntries={[bound ? '/chat/bound-session' : `/chat?draft=${draft.id}`]}>
        <AssignmentRouteProbe />
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
    ordinarySend,
    legacySend,
    draft,
    fixture,
    setOrdinaryConversation: () => {
      ordinary = 'conversation';
    },
    recoverMetadata: () => {
      metadataFailed = false;
    },
  };
}
for (const [name, Screen] of [
  ['mobile', ChatView],
  ['desktop', DesktopChatView],
] as const) {
  it(`${name}: exposes exact Local command recovery beside the composer with settings closed`, async () => {
    const { store, localSend } = setup(Screen, true);
    const settings = await screen.findByRole('button', { name: /^Workspace controls/ });
    if (settings.getAttribute('aria-expanded') !== 'true') fireEvent.click(settings);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Account' }), {
      target: { value: 'personal' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Ready repository launch' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Test send' }));
    if (settings.getAttribute('aria-expanded') === 'true') fireEvent.click(settings);
    const request = localSend.mock.calls[0][0];
    const recover = vi.fn(() => true);
    act(() =>
      store.setState({
        localCommand: {
          state: 'retained',
          request,
          sessionId: 'retained-session',
          originDraftId: 'original-draft',
        },
        recoverLocalCommand: recover,
        sendStatus: 'Local command retained. Review before retrying.',
      }),
    );
    const review = await screen.findByText('Review retained Local command');
    expect(review.closest('.workspace-controls')).toBeNull();
    expect(review.closest('.conversation-composer')).toBeTruthy();
    fireEvent.click(review);
    const recovery = screen.getByRole('button', { name: 'Recover original Local command' });
    expect(recovery).toBeEnabled();
    expect(screen.getByText('Personal ChatGPT · luna-fixture · low · Local Mac')).toBeTruthy();
    expect(document.querySelector('.conversation-composer [data-icon="loading"]')).toBeNull();
    fireEvent.click(recovery);
    expect(recover).toHaveBeenCalledOnce();
    expect(localSend).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: 'Open original draft' })).toHaveAttribute(
      'href',
      '/chat?draft=original-draft',
    );
    expect(screen.getByRole('link', { name: 'Open retained conversation' })).toHaveAttribute(
      'href',
      '/chat/retained-session',
    );
    act(() => store.setState({ connection: { status: 'disconnected', clientId: null } }));
    expect(recovery).toBeDisabled();
    expect(screen.getByText('Reconnect before checking the original command.')).toBeTruthy();
  });
  for (const apiHost of [false, true])
    it.each([
      [DEFAULT_MITZO_PROFILE_ID, DEFAULT_MITZO_PROFILE_REVISION, defaultMitzoProfileDefinition],
      [PROFILE_BUILDER_ID, PROFILE_BUILDER_REVISION, profileBuilderDefinition],
    ] as const)(
      `${name}: builtin %s enables Send on the prepared Host Mac ${apiHost ? 'API' : 'subscription'} route`,
      async (profileId, revision, definition) => {
        const builtin = {
          kind: 'builtin' as const,
          profileId,
          revision,
          definition,
          contentHash: sha256Hex(JSON.stringify(definition)),
        };
        const { localSend, legacySend } = setup(
          Screen,
          false,
          false,
          false,
          false,
          false,
          undefined,
          undefined,
          builtin,
          apiHost,
        );
        const trigger = screen.getByRole('button', { name: /^Workspace controls/ });
        if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
        fireEvent.click(await screen.findByRole('button', { name: 'Local Mac' }));
        fireEvent.change(screen.getByRole('combobox', { name: 'Account' }), {
          target: { value: 'personal' },
        });
        fireEvent.change(screen.getByRole('combobox', { name: 'Thinking level' }), {
          target: { value: 'low' },
        });
        fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), {
          target: { value: JSON.stringify(['builtin', profileId, revision]) },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        fireEvent.click(screen.getByRole('button', { name: /^Workspace controls/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'Ready repository launch' }));
        await waitFor(() =>
          expect(screen.getByRole('button', { name: 'Test send' })).toBeEnabled(),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Test send' }));
        expect(localSend).toHaveBeenCalledOnce();
        expect(localSend.mock.calls[0][0]).toMatchObject({
          runOn: 'local',
          selection: { agent: { kind: 'builtin', profileId, revision } },
        });
        expect(legacySend).not.toHaveBeenCalled();
      },
    );
  it(`${name}: sends the ordinary prepared first command and refreshes into continuation without a repository`, async () => {
    const { store, ordinarySend, localSend, legacySend, setOrdinaryConversation } = setup(
      Screen,
      false,
      false,
      true,
      false,
      false,
      undefined,
      'prepared',
    );
    const trigger = await screen.findByRole('button', { name: /^Workspace controls/ });
    if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test send' })).toBeEnabled());
    expect(screen.getByRole('combobox', { name: 'Account' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Thinking level' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Test send' }));
    expect(ordinarySend).toHaveBeenCalledOnce();
    const [request, phase, observers] = ordinarySend.mock.calls[0];
    expect(phase).toBe('first');
    expect(request).toMatchObject({
      version: 2,
      sessionId: 'bound-session',
      workspace: { kind: 'ordinary', workspaceId: readyId },
      selection: { model: 'luna-fixture', thinking: 'low' },
      payload: { text: 'hello' },
    });
    expect(request).not.toHaveProperty('repositoryWorkspaceId');
    expect(observers).not.toHaveProperty('onSessionAssigned');
    setOrdinaryConversation();
    act(() =>
      store.setState({
        localCommand: {
          request,
          ordinaryPhase: 'first',
          state: 'consumed',
          sessionId: 'bound-session',
        },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Thinking level' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Test send' }));
    expect(ordinarySend.mock.calls[1][1]).toBe('continue');
    expect(ordinarySend.mock.calls[1][0].clientMsgId).not.toBe(request.clientMsgId);
    expect(localSend).not.toHaveBeenCalled();
    expect(legacySend).not.toHaveBeenCalled();
    expect(store.getState().sessions.active).toBe('bound-session');
  });
  it(`${name}: refuses malformed ordinary scope without repository or legacy send fallback`, async () => {
    const { ordinarySend, localSend, legacySend } = setup(
      Screen,
      false,
      false,
      true,
      false,
      false,
      undefined,
      'invalid',
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test send' })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Test send' }));
    expect(ordinarySend).not.toHaveBeenCalled();
    expect(localSend).not.toHaveBeenCalled();
    expect(legacySend).not.toHaveBeenCalled();
  });
  it(`${name}: mounts one settings panel at the top and leaves the composer clear`, async () => {
    setup(Screen, true);
    const trigger = await screen.findByRole('button', { name: /^Workspace controls/ });
    expect(trigger.closest('.workspace-controls')).toBeTruthy();
    expect(
      document.querySelector('[data-testid="composer-settings"] .agent-settings-picker'),
    ).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Workspace controls/ })).toHaveLength(1);
    if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
    const agent = screen.getByRole('combobox', { name: 'Agent' });
    const account = screen.getByRole('combobox', { name: 'Account' });
    expect(account.compareDocumentPosition(agent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Run on' }).closest('details')).toBeNull();
    expect(account.closest('.workspace-controls')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Run on' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Local Mac' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('draft')).toHaveTextContent('hello');
  });
  it(`${name}: cold-open bound details retain eight trusted identities while future thinking changes`, async () => {
    const { localSend, legacySend } = setup(Screen, false, false, true, false, true);
    const trigger = await screen.findByRole('button', { name: /^Workspace controls/ });
    if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
    const account = await screen.findByRole('combobox', { name: 'Account' });
    await waitFor(() => expect(account).toBeDisabled());
    const details = document.querySelector('.composer-session-details')!;
    const fields = Array.from(details.querySelectorAll('dt')).map((term) => term.textContent);
    expect(fields).toEqual([
      'Account',
      'Agent',
      'Model',
      'Thinking level',
      'Run on',
      'Agent software',
      'Workspace',
      'Branch',
    ]);
    const value = (label: string) =>
      Array.from(details.querySelectorAll('dt')).find((term) => term.textContent === label)
        ?.nextElementSibling?.textContent;
    expect(value('Account')).toBe('Personal ChatGPT');
    expect(value('Model')).toBe('Luna fixture');
    expect(value('Thinking level')).toBe('low');
    expect(value('Run on')).toBe('Local Mac');
    expect(value('Agent software')).toBe('Codex');
    expect(value('Workspace')).toBe(readyId);
    expect(value('Branch')).toBe('Unavailable');
    expect(screen.getByRole('combobox', { name: 'Agent' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Local Mac' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'OpenShell' })).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Thinking level' }), {
      target: { value: 'high' },
    });
    expect(value('Thinking level')).toBe('high');
    expect(value('Account')).toBe('Personal ChatGPT');
    expect(value('Agent software')).toBe('Codex');
    expect(localSend).not.toHaveBeenCalled();
    expect(legacySend).not.toHaveBeenCalled();
  });
  it(`${name}: retains known Symposium classification through picker remount and guards the next unknown session`, async () => {
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    const { store, localSend, legacySend } = setup(Screen);
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).includes('unknown-session')) return new Promise<Response>(() => {});
      if (String(url).includes('/symposium/status'))
        return new Response(
          JSON.stringify({ sessionId: 'symposium-session', config: null, seats: [] }),
        );
      if (String(url).includes('/meta'))
        return new Response(JSON.stringify({ sessionType: 'symposium' }));
      return new Response('[]');
    });
    act(() =>
      store.setState({ sessions: { ...store.getState().sessions, active: 'symposium-session' } }),
    );
    await screen.findByText('Agent chat');
    await waitFor(() => expect(document.querySelector('.agent-settings-picker')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chat settings' }));
    const workspace = screen.getByRole('button', { name: /^Workspace controls/ });
    if (workspace.getAttribute('aria-expanded') !== 'true') fireEvent.click(workspace);
    expect((await screen.findByText('Symposium')).closest('.workspace-controls')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Test send' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close Agents' }));
    act(() => store.setState({ switchSession: async () => {} }));
    fireEvent.click(screen.getByRole('button', { name: 'Navigate before assignment' }));
    expect(store.getState().sessions.active).toBe('symposium-session');
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Message Mitzo' })).toBeDisabled(),
    );
    expect(screen.queryByText('Agent chat')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test send' })).toBeNull();
    expect(localSend).not.toHaveBeenCalled();
    expect(legacySend).not.toHaveBeenCalled();
  });
  it(`${name}: guards a requested unknown route before the previous ordinary session is replaced`, async () => {
    const { store, localSend, legacySend } = setup(Screen, false, false, true, false, true);
    const previous = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation((url, options) =>
      String(url).includes('unknown-session')
        ? new Promise<Response>(() => {})
        : previous(url, options),
    );
    const trigger = await screen.findByRole('button', { name: /^Workspace controls/ });
    if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
    await screen.findByRole('combobox', { name: 'Account' });
    act(() => store.setState({ switchSession: async () => {} }));
    fireEvent.click(screen.getByRole('button', { name: 'Navigate before assignment' }));
    expect(store.getState().sessions.active).toBe('bound-session');
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Message Mitzo' })).toBeDisabled(),
    );
    expect(screen.queryByTitle('Close session')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test send' })).toBeNull();
    expect(localSend).not.toHaveBeenCalled();
    expect(legacySend).not.toHaveBeenCalled();
  });
  it(`${name}: displays the trusted model label while continuation keeps the exact model id`, async () => {
    const { localSend } = setup(Screen, false, false, true, false, true);
    const trigger = await screen.findByRole('button', {
      name: /^Workspace controls.*Luna fixture/,
    });
    expect(trigger).toHaveAccessibleName(/Luna fixture/);
    if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
    const details = document.querySelector('.composer-session-details')!;
    const modelTerm = Array.from(details.querySelectorAll('dt')).find(
      (term) => term.textContent === 'Model',
    )!;
    expect(modelTerm.nextElementSibling).toHaveTextContent('Luna fixture');
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('luna-fixture');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Test send' }));
    expect(localSend).toHaveBeenCalledWith(
      expect.objectContaining({ selection: expect.objectContaining({ model: 'luna-fixture' }) }),
      expect.anything(),
    );
  });
  it(`${name}: a legacy display summary cannot bypass pending conversation classification`, async () => {
    const { store, localSend, legacySend } = setup(Screen);
    let resolveClassification!: (response: Response) => void;
    const pendingClassification = new Promise<Response>((resolve) => {
      resolveClassification = resolve;
    });
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).includes('/symposium/status')) return pendingClassification;
      if (String(url).includes('/meta')) return new Response('{}');
      return new Response('[]');
    });
    act(() =>
      store.setState({
        sessions: { ...store.getState().sessions, active: 'unclassified-session' },
      }),
    );
    const workspace = screen.getByRole('button', { name: /^Workspace controls/ });
    if (workspace.getAttribute('aria-expanded') !== 'true') fireEvent.click(workspace);
    await screen.findByRole('button', { name: /^Workspace controls.*Legacy account/ });
    expect(screen.getByRole('textbox', { name: 'Message Mitzo' })).toBeDisabled();
    expect(document.querySelector('.chat-input[aria-busy="true"]')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Test send' })).toBeNull();
    expect(localSend).not.toHaveBeenCalled();
    expect(legacySend).not.toHaveBeenCalled();
    await act(async () =>
      resolveClassification(
        new Response(
          JSON.stringify({ sessionId: 'unclassified-session', config: null, seats: [] }),
        ),
      ),
    );
    await screen.findByRole('button', { name: 'Test send' });
    expect(document.querySelector('.chat-input[aria-busy="true"]')).toBeNull();
    expect(localSend).not.toHaveBeenCalled();
    expect(legacySend).not.toHaveBeenCalled();
  });
  it(`${name}: untouched OpenShell stays blocked, explicit Local dispatches only exact dedicated intent`, async () => {
    const { localSend, legacySend } = setup(Screen);
    const workspace = screen.getByRole('button', { name: /^Workspace controls/ });
    if (workspace.getAttribute('aria-expanded') !== 'true') fireEvent.click(workspace);
    const settingsTrigger = screen.getByRole('button', { name: /^Workspace controls/ });
    if (settingsTrigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(settingsTrigger);
    await screen.findByRole('button', { name: 'Local Mac' });
    expect(screen.getByRole('button', { name: 'OpenShell' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Test send' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Local Mac' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Account' }), {
      target: { value: 'personal' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Thinking level' }), {
      target: { value: 'low' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), {
      target: { value: JSON.stringify(['saved', 'agent', 1]) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: /^Workspace controls/ }));
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
    const settingsTrigger = screen.getByRole('button', { name: /^Workspace controls/ });
    if (settingsTrigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(settingsTrigger);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Local Mac' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
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
    const { localSend, legacySend, recoverMetadata, store } = setup(
      Screen,
      false,
      false,
      true,
      true,
    );
    const workspace = screen.getByRole('button', { name: /^Workspace controls/ });
    if (workspace.getAttribute('aria-expanded') !== 'true') fireEvent.click(workspace);
    const settingsTrigger = screen.getByRole('button', { name: /^Workspace controls/ });
    if (settingsTrigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(settingsTrigger);
    expect(screen.queryByRole('button', { name: 'Add agent' })).toBeNull();
    const retry = await screen.findByRole('button', { name: 'Retry conversation settings' });
    expect(screen.queryByRole('combobox', { name: 'Run on' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add agent' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reusable profile drafts' })).toBeNull();
    expect(screen.queryByTestId('web-search-connection')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open review findings' })).toBeNull();
    const setMode = vi.spyOn(store.getState(), 'setMode');
    const agentMode = screen.queryByRole('button', { name: /^Agent$/ });
    if (agentMode) {
      expect(agentMode).toBeDisabled();
      fireEvent.click(agentMode);
    }
    expect(setMode).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Test send' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Test send' }));
    expect(localSend).not.toHaveBeenCalled();
    expect(legacySend).not.toHaveBeenCalled();
    recoverMetadata();
    fireEvent.click(retry);
    await screen.findByText('Fixed for this conversation');
    expect(
      workspace.closest('.workspace-controls')?.querySelector('.conversation-state'),
    ).toHaveTextContent('First command');
    expect(workspace).toHaveAccessibleDescription('First command');
    expect(screen.getByRole('button', { name: 'Test send' })).toBeDisabled();
  });
  it(`${name}: hydrates authoritative model and thinking before the runtime metadata request resolves, then sends those settings`, async () => {
    localStorage.setItem('mitzo-preferred-model', 'old-browser-default');
    const metadata = {
      sessionType: 'chat',
      accountBinding: { accountId: 'work', accountLabel: 'Work', model: 'persisted-model' },
      modelSelection: {
        model: 'persisted-model',
        reasoningEffort: 'high',
        models: [
          { id: 'persisted-model', label: 'Persisted model', reasoningEfforts: ['low', 'high'] },
        ],
      },
    };
    let metadataCalls = 0;
    let release!: (response: Response) => void;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/meta')) {
        if (init?.signal) metadataCalls++;
        if (init?.signal && metadataCalls === 2)
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        return new Response(JSON.stringify(metadata));
      }
      if (url === '/api/chat/runtime/capabilities')
        return new Response(JSON.stringify({ code: 'entry_disabled' }), { status: 503 });
      if (String(url).endsWith('/symposium/status'))
        return new Response(JSON.stringify({ sessionId: 'existing', config: null, seats: [] }));
      return new Response('[]');
    });
    const store = createTestStore();
    const sent = vi.fn(() => true);
    store.setState({
      sendMessage: sent,
      sessions: { ...store.getState().sessions, active: 'existing' },
      modeChangeReady: true,
    });
    render(
      <MitzoStoreProvider value={store}>
        <MemoryRouter initialEntries={['/chat/existing']}>
          <Routes>
            <Route path="/chat/:sessionId" element={<Screen />} />
          </Routes>
        </MemoryRouter>
      </MitzoStoreProvider>,
    );
    await waitFor(() => expect(metadataCalls).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(store.getState().config.modelId).toBe('persisted-model'));
    expect(localStorage.getItem('mitzo-preferred-model')).toBe('old-browser-default');
    release(new Response(JSON.stringify(metadata)));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Test send' }));
    expect(sent).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({
        accountId: 'work',
        model: 'persisted-model',
        reasoningEffort: 'high',
      }),
    );
  });
  it(`${name}: labels consumed receipt settings as historical while future model intent stays distinct`, async () => {
    const fixture = localInventoryFixture();
    fixture.accounts[0].models.push({
      id: 'next-model',
      label: 'Next model',
      reasoningEfforts: ['low', 'high'],
    });
    const { store } = setup(Screen, false, false, true, false, true, fixture);
    const { LocalCodexFirstCommandSchema } = await import('@mitzo/protocol');
    const receipt = LocalCodexFirstCommandSchema.parse({
      runOn: 'local',
      clientMsgId: 'previous-command',
      repositoryWorkspaceId: readyId,
      capabilityRevision: fixture.capabilityRevision,
      runtime: {
        account: fixture.accounts[0].account,
        harness: 'codex',
        targetId: 'mac',
        mode: 'agent',
      },
      selection: {
        version: 1,
        agent: { profileId: 'agent', revision: 1 },
        context: { source: 'none', revision: null },
        permission: { mode: 'agent', revision: 0 },
        model: 'luna-fixture',
        thinking: 'low',
      },
      payload: { text: 'Previously submitted' },
    });
    act(() =>
      store.setState({
        localCommand: { state: 'consumed', sessionId: 'bound-session', request: receipt },
      }),
    );
    const workspace = screen.getByRole('button', { name: /^Workspace controls/ });
    if (workspace.getAttribute('aria-expanded') !== 'true') fireEvent.click(workspace);
    const settingsTrigger = screen.getByRole('button', { name: /^Workspace controls/ });
    if (settingsTrigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(settingsTrigger);
    await screen.findByText('Fixed for this conversation');
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), {
      target: { value: 'next-model' },
    });
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('next-model');
    expect(
      screen.getByText(
        /Last submitted command: Account: personal · Model: luna-fixture · Thinking: low/,
      ),
    ).toBeInTheDocument();
    expect(store.getState().localCommand?.request).toEqual(receipt);
  });
  it(`${name}: supported continuation freezes selected thinking and never sends through legacy routing`, async () => {
    const { localSend, legacySend } = setup(Screen, false, false, true, false, true);
    const workspace = screen.getByRole('button', { name: /^Workspace controls/ });
    if (workspace.getAttribute('aria-expanded') !== 'true') fireEvent.click(workspace);
    const settingsTrigger = screen.getByRole('button', { name: /^Workspace controls/ });
    if (settingsTrigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(settingsTrigger);
    await screen.findByText('Fixed for this conversation');
    expect(workspace).toHaveAccessibleName(/Personal ChatGPT, Luna fixture, low, local/);
    expect(
      workspace.closest('.workspace-controls')?.querySelector('.conversation-state'),
    ).toHaveTextContent('Conversation');
    expect(workspace).toHaveAccessibleDescription('Conversation');
    expect(screen.getByRole('combobox', { name: 'Account' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Thinking level' })).toBeEnabled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Thinking level' }), {
      target: { value: 'high' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: /^Workspace controls/ }));
    expect(workspace).toHaveAccessibleName(/Personal ChatGPT, Luna fixture, high, local/);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Test send' }));
    expect(localSend).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'bound-session',
        repositoryWorkspaceId: readyId,
        selection: expect.objectContaining({ thinking: 'high' }),
      }),
      expect.anything(),
    );
    expect(legacySend).not.toHaveBeenCalled();
    expect(screen.queryByTestId('web-search-connection')).toBeNull();
  });
  it(`${name}: immutable Local metadata disables follow-up, mode and web settings on reload`, async () => {
    const { legacySend } = setup(Screen, false, false, true);
    const workspace = screen.getByRole('button', { name: /^Workspace controls/ });
    if (workspace.getAttribute('aria-expanded') !== 'true') fireEvent.click(workspace);
    const settingsTrigger = screen.getByRole('button', { name: /^Workspace controls/ });
    if (settingsTrigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(settingsTrigger);
    await screen.findByText('Fixed for this conversation');
    expect(
      workspace.closest('.workspace-controls')?.querySelector('.conversation-state'),
    ).toHaveTextContent('First command');
    expect(workspace).toHaveAccessibleDescription('First command');
    expect(screen.getByRole('button', { name: 'Test send' })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Agent$/ })).toBeDisabled());
    expect(screen.queryByTestId('web-search-connection')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Test send' }));
    expect(legacySend).not.toHaveBeenCalled();
  });
}

for (const [name, Screen] of [
  ['mobile', ChatView],
  ['desktop', DesktopChatView],
] as const) {
  it(`${name}: environment changes derive API Responses or Claude without losing draft or adopting another billing account`, async () => {
    const { multiRuntimeInventoryFixture } =
      await import('../../test-utils/multi-runtime-inventory-fixture');
    const { store, localSend, legacySend, draft } = setup(
      Screen,
      false,
      false,
      false,
      false,
      false,
      multiRuntimeInventoryFixture(),
    );
    const workspace = screen.getByRole('button', { name: /^Workspace controls/ });
    if (workspace.getAttribute('aria-expanded') !== 'true') fireEvent.click(workspace);
    const settingsTrigger = screen.getByRole('button', { name: /^Workspace controls/ });
    if (settingsTrigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(settingsTrigger);
    await screen.findByRole('option', { name: 'API billing' });
    expect(screen.getByRole('button', { name: 'OpenShell' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Local Mac' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Account' }), {
      target: { value: 'api' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), {
      target: { value: 'shell-model' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Thinking level' }), {
      target: { value: 'high' },
    });
    expect(screen.getByText('Runs with Codex')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Local model' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Local Mac' }));
    expect(screen.getByText('Runs with Mitzo Responses')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Account' })).toHaveValue('api');
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('shell-model');
    expect(screen.getByRole('combobox', { name: 'Thinking level' })).toHaveValue('high');
    expect(
      screen.getByRole('option', { name: 'Unavailable model: shell-model' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Local model' })).toBeInTheDocument();
    expect(screen.getByTestId('draft')).toHaveTextContent('hello');
    expect(localSend).not.toHaveBeenCalled();
    expect(legacySend).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Account' }), {
      target: { value: 'vertex' },
    });
    expect(screen.getByText('Runs with Claude')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('shell-model');
    expect(screen.getByRole('combobox', { name: 'Thinking level' })).toHaveValue('high');
    expect(screen.getByRole('option', { name: 'Claude model' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Local model' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Test send' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'OpenShell' }));
    expect(screen.getByRole('combobox', { name: 'Account' })).toHaveValue('vertex');
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('shell-model');
    expect(screen.getByRole('combobox', { name: 'Thinking level' })).toHaveValue('high');
    expect(screen.queryByRole('option', { name: 'Shell model' })).toBeNull();
    expect(screen.queryByText('Runs with Codex')).toBeNull();
    expect(screen.getByTestId('draft')).toHaveTextContent('hello');
    expect(screen.getByRole('button', { name: 'Test send' })).toBeDisabled();
    expect(getChatDraft(draft.id)?.settings.runtimeSelection).toMatchObject({
      account: { accountId: 'vertex', model: 'shell-model', reasoningEffort: 'high' },
      accountReference: {
        accountId: 'vertex',
        provider: 'anthropic-vertex',
        profileRevision: 'vertex-r1',
      },
      execution: { location: 'openshell', targetId: null },
    });
    expect(getChatDraft(draft.id)).toMatchObject({
      text: 'hello',
      images: draft.images,
      contextBlocks: draft.contextBlocks,
    });
    expect(store.getState().sessions.active).toBeNull();
  });
}

for (const [name, Screen] of [
  ['mobile', ChatView],
  ['desktop', DesktopChatView],
] as const) {
  it(`${name}: a one-account legacy draft confirms billing through one explicit Account choice`, async () => {
    const fixture = localInventoryFixture();
    const replacement = {
      ...fixture.accounts[0].account,
      provider: 'openai' as const,
      profileRevision: 'replacement-api',
    };
    const data = {
      ...fixture,
      accounts: [
        { ...fixture.accounts[0], label: 'Replacement API account', account: replacement },
      ],
      targets: [{ ...fixture.targets[0], harness: 'responses' as const }],
      routes: [{ ...fixture.routes[0], account: replacement, harness: 'responses' as const }],
    };
    const { draft, localSend, legacySend } = setup(Screen, true, false, false, false, false, data);
    const workspace = screen.getByRole('button', { name: /^Workspace controls/ });
    if (workspace.getAttribute('aria-expanded') !== 'true') fireEvent.click(workspace);
    const settingsTrigger = screen.getByRole('button', { name: /^Workspace controls/ });
    if (settingsTrigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(settingsTrigger);
    await screen.findByRole('option', { name: 'Replacement API account' });
    expect(screen.getByRole('button', { name: 'Test send' })).toBeDisabled();
    expect(screen.getAllByText(/account identity is unconfirmed/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: /^Workspace controls/ }));
    expect(getChatDraft(draft.id)?.settings.runtimeSelection?.accountReference).toBeFalsy();
    const accountControl = screen.getByRole('combobox', { name: 'Account' });
    const pending = screen.getByRole('option', {
      name: 'Confirm account: Replacement API account',
    });
    expect(pending).toBeDisabled();
    expect(accountControl).not.toHaveValue('personal');
    expect(getChatDraft(draft.id)?.settings.runtimeSelection?.account?.accountId).toBe('personal');
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('luna-fixture');
    expect(screen.getByRole('combobox', { name: 'Thinking level' })).toHaveValue('low');
    await userEvent.setup().selectOptions(accountControl, 'personal');
    expect(accountControl).toHaveValue('personal');
    expect(getChatDraft(draft.id)?.settings.runtimeSelection).toMatchObject({
      accountReference: replacement,
      account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
    });
    expect(getChatDraft(draft.id)).toMatchObject({
      text: 'hello',
      images: draft.images,
      contextBlocks: draft.contextBlocks,
    });
    expect(screen.getByTestId('draft')).toHaveTextContent('hello');
    expect(localSend).not.toHaveBeenCalled();
    expect(legacySend).not.toHaveBeenCalled();
  });
}

for (const [name, Screen] of [
  ['mobile', ChatView],
  ['desktop', DesktopChatView],
] as const) {
  it(`${name}: a server-qualified ready checkout keeps account/environment while another first-message model retains the draft`, async () => {
    const fixture = localInventoryFixture();
    fixture.accounts[0].models.push({
      id: 'supported-next',
      label: 'Supported next',
      reasoningEfforts: ['low', 'high'],
    });
    const { draft, localSend, legacySend } = setup(
      Screen,
      false,
      false,
      false,
      false,
      false,
      fixture,
    );
    const workspace = screen.getByRole('button', { name: /^Workspace controls/ });
    if (workspace.getAttribute('aria-expanded') !== 'true') fireEvent.click(workspace);
    const settingsTrigger = screen.getByRole('button', { name: /^Workspace controls/ });
    if (settingsTrigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(settingsTrigger);
    await screen.findByRole('combobox', { name: 'Account' });
    fireEvent.click(screen.getByRole('button', { name: 'Local Mac' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Account' }), {
      target: { value: 'personal' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Thinking level' }), {
      target: { value: 'high' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), {
      target: { value: JSON.stringify(['saved', 'agent', 1]) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: /^Workspace controls/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Ready qualified repository launch' }));
    expect(screen.getByRole('combobox', { name: 'Account' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Local Mac' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'OpenShell' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'Thinking level' })).toBeEnabled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), {
      target: { value: 'supported-next' },
    });
    expect(screen.getByRole('combobox', { name: 'Thinking level' })).toHaveValue('high');
    expect(getChatDraft(draft.id)).toMatchObject({
      text: 'hello',
      images: draft.images,
      contextBlocks: draft.contextBlocks,
      settings: {
        repositoryWorkspaceId: readyId,
        runtimeSelection: {
          account: { accountId: 'personal', model: 'supported-next', reasoningEffort: 'high' },
        },
      },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Test send' }));
    expect(localSend).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryWorkspaceId: readyId,
        runtime: expect.objectContaining({ account: fixture.accounts[0].account, targetId: 'mac' }),
        selection: expect.objectContaining({ model: 'supported-next', thinking: 'high' }),
      }),
      expect.anything(),
    );
    expect(legacySend).not.toHaveBeenCalled();
  });
}

for (const Screen of [ChatView, DesktopChatView]) {
  it(`${Screen.name}: reviews platform proposals in first-command-only history while runtime send stays blocked`, async () => {
    const { localSend, legacySend, store } = setup(Screen, false, false, true, false, false);
    const original = vi.mocked(apiFetch).getMockImplementation()!;
    const proposal = {
      proposalId: 'first-only-proposal',
      suggestedProfileId: 'reviewed-agent',
      state: 'pending',
      definition: {
        name: 'Reviewed Agent',
        role: 'agent',
        instructions: 'Review first-command history',
        expectedOutput: 'Report',
        acceptanceCriteria: ['Cite evidence'],
        modelPolicyRole: 'agent',
      },
    };
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).includes('/profile-proposals') && !init?.method)
        return new Response(JSON.stringify([proposal]));
      if (String(url) === '/api/symposium/profiles') return new Response('[]');
      if (String(url).endsWith('/first-only-proposal/save') && init?.method === 'POST')
        return new Response(JSON.stringify({ profileId: 'reviewed-agent', revision: 1 }));
      return original(url, init);
    });
    await screen.findByDisplayValue('Reviewed Agent');
    expect(screen.getByRole('button', { name: 'Test send' })).toBeDisabled();
    expect(localSend).not.toHaveBeenCalled();
    expect(legacySend).not.toHaveBeenCalled();
    const save = screen.getByRole('button', { name: 'Save reusable profile' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await screen.findByText('Saved Reviewed Agent to your Agent Library.');
    expect(localSend).not.toHaveBeenCalled();
    expect(legacySend).not.toHaveBeenCalled();
    act(() =>
      store.setState({ sessions: { ...store.getState().sessions, active: 'other-session' } }),
    );
    // The old review remains available to read but loses write authorization.
    expect(screen.getByRole('button', { name: 'Test send' })).toBeDisabled();
  });
}
