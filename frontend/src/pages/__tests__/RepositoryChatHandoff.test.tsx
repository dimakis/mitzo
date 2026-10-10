// @vitest-environment jsdom
import { useEffect, useRef, useImperativeHandle } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { MitzoConnection } from '@mitzo/client';
import type { ChatInputDraftControl } from '../../components/ChatInput';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { createTestStore } from '../../test-utils/createTestStore';
import { ChatView } from '../ChatView';
import { DesktopChatView } from '../DesktopChatView';
import { PREFERRED_MODEL_KEY } from '../../lib/model-preference';
import { useDraft } from '../../hooks/useDraft';
const api = vi.hoisted(() => ({ fetch: vi.fn(), realComposer: false }));
vi.mock('../../lib/api-fetch', async () => ({
  ...(await vi.importActual<typeof import('../../lib/api-fetch')>('../../lib/api-fetch')),
  apiFetch: api.fetch,
  getApiBaseUrl: () => '',
}));
vi.mock('../../components/ChatAgentProfilePicker', () => ({
  ChatAgentProfilePicker: ({
    onChange,
  }: {
    onChange(selection: unknown, reason?: string): void;
  }) => (
    <>
      <button onClick={() => onChange(null, 'Selected agent revision unavailable')}>
        Choose unavailable profile
      </button>
      <button onClick={() => onChange({ profileId: 'bob', revision: 3 })}>Choose Bob</button>
    </>
  ),
}));
vi.mock('../../lib/keyboard', () => ({ onKeyboardToggle: () => () => {} }));
vi.mock('../../hooks/useProgress', () => ({ useProgressByToolId: () => new Map() }));
vi.mock('../../hooks/useVoice', () => ({
  useVoice: () => ({ stopSpeaking: vi.fn(), available: false, voices: [] }),
}));
vi.mock('../../components/VoiceSettings', () => ({ VoiceSettings: () => null }));
vi.mock('../../components/WebSearchConsent', () => ({ WebSearchConsent: () => null }));
vi.mock('../../components/SessionPanel', () => ({ SessionPanel: () => null }));
vi.mock('../../components/CommandCenter', () => ({ CommandCenter: () => null }));
vi.mock('../../components/DesktopShell', () => ({
  DesktopShell: ({ center }: { center: React.ReactNode }) => <>{center}</>,
}));
vi.mock('../../components/WorkspaceControls', () => ({
  WorkspaceControls: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../components/SymposiumConversation', () => ({
  SymposiumConversation: ({ ordinaryComposer }: { ordinaryComposer: React.ReactNode }) => (
    <>{ordinaryComposer}</>
  ),
}));
vi.mock('../../components/ChatInput', async () => {
  const actual = await vi.importActual<typeof import('../../components/ChatInput')>(
    '../../components/ChatInput',
  );
  const MockChatInput = ({
    initialText,
    onSend,
    sendDisabledReason,
    draftStorageKey,
    sessionId,
    draftControl,
  }: {
    initialText?: string;
    onSend(text: string): boolean;
    sendDisabledReason?: string;
    draftStorageKey?: string;
    sessionId?: string;
    draftControl?: React.RefObject<ChatInputDraftControl | null>;
  }) => {
    const [text, setText, clearDraft, flushDraft] = useDraft(
      sessionId,
      initialText,
      draftStorageKey,
    );
    useImperativeHandle(draftControl, () => ({ storageKey: draftStorageKey, clear: clearDraft }));
    return (
      <>
        <input
          aria-label="Task draft"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <span>{sendDisabledReason}</span>
        <button
          disabled={!!sendDisabledReason}
          onClick={() => {
            if (draftStorageKey) flushDraft();
            if (onSend(text)) clearDraft();
          }}
        >
          Send task
        </button>
        <button
          onClick={() => {
            if (draftStorageKey) flushDraft();
            if (onSend(text)) clearDraft();
          }}
        >
          Try send directly
        </button>
      </>
    );
  };
  return {
    ChatInput: (props: React.ComponentProps<typeof actual.ChatInput>) =>
      api.realComposer ? <actual.ChatInput {...props} /> : <MockChatInput {...props} />,
  };
});
vi.mock('../../components/RepositoryChatPicker', () => ({
  RepositoryChatPicker: ({
    initialPreparationId,
    onChange,
  }: {
    initialPreparationId?: string;
    onChange(value: { blocked: boolean; repositoryWorkspaceId?: string } | null): void;
  }) => {
    const change = useRef(onChange);
    change.current = onChange;
    useEffect(
      () =>
        change.current(
          initialPreparationId
            ? { blocked: false, repositoryWorkspaceId: initialPreparationId }
            : null,
        ),
      [initialPreparationId],
    );
    return <span data-testid="preparation-id">{initialPreparationId}</span>;
  },
}));
const id = '8ca30b0d-3e65-4eeb-8244-f6277350818f';
const otherId = 'aaaaaaaa-bbbb-4ccc-8ddd-121212121212';
const ordinaryDraft = 'Unsent ordinary task\n  preserve these bytes';
const preparation = {
  id,
  sourceConversationId: 'parent',
  repository: 'example/repo',
  baseBranch: 'main',
  baseOid: 'a'.repeat(40),
  featureBranch: 'mitzo/task',
  state: 'ready',
  accountId: 'prepared',
  model: 'luna',
  prompt: 'Review the saved repository task',
  setupUrl: `/chat?repositoryPreparation=${id}`,
};
const accounts = [
  { id: 'other', label: 'Other', models: [{ id: 'sol', label: 'Sol' }] },
  { id: 'prepared', label: 'Prepared', models: [{ id: 'luna', label: 'Luna' }] },
];
function Location() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <span data-testid="location">
        {location.pathname}
        {location.search}
      </span>
      <button onClick={() => navigate(`/chat?repositoryPreparation=${otherId}`)}>
        Other preparation
      </button>
    </>
  );
}
function fixture(View: typeof ChatView, active: string | null = null, realSend = false) {
  const store = createTestStore();
  const send = realSend ? vi.fn(store.getState().sendMessage) : vi.fn();
  const newSession = vi.fn(store.getState().newSession);
  store.setState({
    sendMessage: send,
    newSession,
    sessions: { ...store.getState().sessions, active },
    connection: { status: 'connected', clientId: 'offline' },
  });
  localStorage.setItem(
    'mitzo-default-account-model',
    JSON.stringify({ accountId: 'other', model: 'sol' }),
  );
  localStorage.setItem(PREFERRED_MODEL_KEY, 'remembered-model');
  localStorage.setItem('mitzo-draft-new', ordinaryDraft);
  const rendered = render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter initialEntries={[`/chat?repositoryPreparation=${id}`]}>
        <Routes>
          <Route
            path="/chat/:sessionId?"
            element={
              <>
                <View />
                <Location />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  return { store, send, newSession, unmount: rendered.unmount };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  api.realComposer = false;
  api.fetch.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});

for (const [layout, View] of [
  ['mobile', ChatView],
  ['desktop', DesktopChatView],
] as const) {
  it(`${layout}: blocks unavailable agent guidance in the send handler and forwards an explicit replacement`, async () => {
    api.fetch.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('/chat-preparation') ? { repositoryChat: preparation } : accounts,
          ),
        ),
    );
    const { send } = fixture(View);
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Send task' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose unavailable profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Try send directly' }));
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Choose Bob' }));
    fireEvent.click(screen.getByRole('button', { name: 'Try send directly' }));
    expect(send).toHaveBeenCalledWith(
      preparation.prompt,
      expect.objectContaining({ agentProfile: { profileId: 'bob', revision: 3 } }),
    );
  });
  it.each(['rejected', 'throwing'] as const)(
    `${layout}: preserves immediate Send edits after a %s real transport and reload`,
    async (failure) => {
      api.realComposer = true;
      api.fetch.mockImplementation(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.includes('/chat-preparation') ? { repositoryChat: preparation } : accounts,
            ),
          ),
      );
      const original = MitzoConnection.prototype.send;
      vi.spyOn(MitzoConnection.prototype, 'send').mockImplementation(function (
        this: MitzoConnection,
        message,
      ) {
        if (message.type === 'send') {
          if (failure === 'throwing') throw new Error('Offline transport failure');
          return false;
        }
        return original.call(this, message);
      });
      const first = fixture(View, null, true);
      await waitFor(() =>
        expect((screen.getByLabelText('Message Mitzo') as HTMLTextAreaElement).value).toBe(
          preparation.prompt,
        ),
      );
      await waitFor(() =>
        expect(
          (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled,
        ).toBe(false),
      );
      fireEvent.change(screen.getByLabelText('Message Mitzo'), {
        target: { value: 'Reviewed immediately before Send' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      expect(first.send).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(`mitzo-repository-prompt:${id}`)).toBe(
        'Reviewed immediately before Send',
      );
      expect((screen.getByLabelText('Message Mitzo') as HTMLTextAreaElement).value).toBe(
        'Reviewed immediately before Send',
      );
      await waitFor(() =>
        expect(
          (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled,
        ).toBe(failure === 'throwing'),
      );
      first.unmount();
      const reopened = fixture(View, null, true);
      await screen.findByText('example/repo');
      expect((screen.getByLabelText('Message Mitzo') as HTMLTextAreaElement).value).toBe(
        'Reviewed immediately before Send',
      );
      expect(reopened.send).not.toHaveBeenCalled();
      expect(localStorage.getItem('mitzo-draft-new')).toBe(ordinaryDraft);
    },
  );
  it(`${layout}: keeps a queued real transport fenced until matching assignment clears the dirty prompt`, async () => {
    api.realComposer = true;
    api.fetch.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('/chat-preparation') ? { repositoryChat: preparation } : accounts,
          ),
        ),
    );
    const original = MitzoConnection.prototype.send;
    vi.spyOn(MitzoConnection.prototype, 'send').mockImplementation(function (
      this: MitzoConnection,
      message,
    ) {
      return message.type === 'send' ? true : original.call(this, message);
    });
    const { store, send } = fixture(View, null, true);
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.change(screen.getByLabelText('Message Mitzo'), {
      target: { value: 'Queued reviewed task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    act(() => {
      store.getState().dispatchMessages({ type: 'SESSION_STATE_CHANGED', state: 'idle' });
      store.setState({ sendStatus: 'Delivery uncertain. Waiting for confirmation.' });
    });
    expect(
      (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
    expect(send).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Message Mitzo'), {
      target: { value: 'Edit while pending assignment' },
    });
    act(() => {
      send.mock.calls[0][1]?.onSessionAssigned?.('assigned');
      store.setState({ sessions: { ...store.getState().sessions, active: 'assigned' } });
    });
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/chat/assigned'));
    expect(localStorage.getItem(`mitzo-repository-prompt:${id}`)).toBeNull();
    expect(localStorage.getItem('mitzo-draft-assigned')).toBeNull();
    expect(localStorage.getItem('mitzo-draft-new')).toBe(ordinaryDraft);
  });
  it(`${layout}: restores edited preparation text after reload without consuming the ordinary draft`, async () => {
    api.fetch.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('/chat-preparation') ? { repositoryChat: preparation } : accounts,
          ),
        ),
    );
    const first = fixture(View);
    await waitFor(() =>
      expect((screen.getByLabelText('Task draft') as HTMLInputElement).value).toBe(
        preparation.prompt,
      ),
    );
    fireEvent.change(screen.getByLabelText('Task draft'), {
      target: { value: 'Edited before reload' },
    });
    first.unmount();
    expect(localStorage.getItem('mitzo-draft-new')).toBe(ordinaryDraft);
    const reopened = fixture(View);
    await screen.findByText('example/repo');
    expect((screen.getByLabelText('Task draft') as HTMLInputElement).value).toBe(
      'Edited before reload',
    );
    expect(localStorage.getItem('mitzo-draft-new')).toBe(ordinaryDraft);
    expect(reopened.send).not.toHaveBeenCalled();
  });
  it(`${layout}: isolates two preparation drafts while a previous route response arrives late`, async () => {
    let complete!: (response: Response) => void;
    api.fetch.mockImplementation(async (url: string) =>
      url.includes('/chat-preparation') && !url.includes(otherId)
        ? new Promise<Response>((resolve) => {
            complete = resolve;
          })
        : new Response(
            JSON.stringify(
              url.includes('/chat-preparation')
                ? {
                    repositoryChat: {
                      ...preparation,
                      id: otherId,
                      setupUrl: `/chat?repositoryPreparation=${otherId}`,
                    },
                  }
                : accounts,
            ),
          ),
    );
    localStorage.setItem(`mitzo-repository-prompt:${id}`, 'Saved A');
    localStorage.setItem(`mitzo-repository-prompt:${otherId}`, 'Saved B');
    const { send } = fixture(View);
    await waitFor(() => expect(api.fetch).toHaveBeenCalled());
    expect((screen.getByLabelText('Task draft') as HTMLInputElement).value).toBe('Saved A');
    fireEvent.change(screen.getByLabelText('Task draft'), { target: { value: 'Edit A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Other preparation' }));
    await screen.findByText('example/repo');
    expect((screen.getByLabelText('Task draft') as HTMLInputElement).value).toBe('Saved B');
    fireEvent.change(screen.getByLabelText('Task draft'), { target: { value: 'Edit B' } });
    await act(async () => complete(new Response(JSON.stringify({ repositoryChat: preparation }))));
    await waitFor(() =>
      expect(localStorage.getItem(`mitzo-repository-prompt:${otherId}`)).toBe('Edit B'),
    );
    expect(localStorage.getItem(`mitzo-repository-prompt:${id}`)).toBe('Edit A');
    expect(localStorage.getItem('mitzo-draft-new')).toBe(ordinaryDraft);
    expect(screen.getByTestId('location').textContent).toBe(
      `/chat?repositoryPreparation=${otherId}`,
    );
    expect(send).not.toHaveBeenCalled();
  });
  it.each(['preparing', 'claiming'] as const)(
    `${layout}: explains the retained %s fence without starting another task`,
    async (state) => {
      api.fetch.mockImplementation(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.includes('/chat-preparation')
                ? { repositoryChat: { ...preparation, state } }
                : accounts,
            ),
          ),
      );
      const { send } = fixture(View);
      expect((await screen.findByRole('alert')).textContent).toBe(
        'This preparation is still running or interrupted. Inspect the original preparation before starting another task.',
      );
      expect(
        (screen.getByRole('button', { name: 'Send task' }) as HTMLButtonElement).disabled,
      ).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'Try send directly' }));
      expect(send).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Refresh preparation status' }));
      await waitFor(() =>
        expect(
          api.fetch.mock.calls.filter(([url]) => url.includes('/chat-preparation')).length,
        ).toBe(2),
      );
      expect(api.fetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    },
  );
  it(`${layout}: preserves the handoff URL while a source chat's old account selection is clearing`, async () => {
    let complete!: (response: Response) => void;
    api.fetch.mockImplementation(async (url: string) =>
      url.includes('/chat-preparation')
        ? new Promise<Response>((resolve) => {
            complete = resolve;
          })
        : new Response(
            JSON.stringify({
              accountBinding: { accountId: 'other', accountLabel: 'Other', model: 'sol' },
            }),
          ),
    );
    const store = createTestStore();
    store.setState({ sessions: { ...store.getState().sessions, active: 'parent' } });
    render(
      <MitzoStoreProvider value={store}>
        <MemoryRouter initialEntries={['/chat/parent']}>
          <Routes>
            <Route
              path="/chat/:sessionId?"
              element={
                <>
                  <View />
                  <Location />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </MitzoStoreProvider>,
    );
    await screen.findByText('Other');
    fireEvent.click(screen.getByRole('button', { name: 'Other preparation' }));
    await waitFor(() =>
      expect(api.fetch.mock.calls.some(([url]) => url.includes('/chat-preparation'))).toBe(true),
    );
    expect(screen.getByTestId('location').textContent).toBe(
      `/chat?repositoryPreparation=${otherId}`,
    );
    expect(screen.queryByTestId('preparation-id')).toBeNull();
    await act(async () =>
      complete(
        new Response(
          JSON.stringify({
            repositoryChat: {
              ...preparation,
              id: otherId,
              setupUrl: `/chat?repositoryPreparation=${otherId}`,
            },
          }),
        ),
      ),
    );
  });
  it(`${layout}: does not select a fallback account while the handoff is loading`, async () => {
    let complete!: (response: Response) => void;
    api.fetch.mockImplementation(async (url: string) =>
      url.includes('/chat-preparation')
        ? new Promise<Response>((resolve) => {
            complete = resolve;
          })
        : new Response(JSON.stringify(accounts)),
    );
    const { send } = fixture(View);
    await waitFor(() => expect(api.fetch).toHaveBeenCalled());
    expect(api.fetch.mock.calls.some(([url]) => url === '/api/accounts')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Try send directly' }));
    expect(send).not.toHaveBeenCalled();
    await act(async () => complete(new Response(JSON.stringify({ repositoryChat: preparation }))));
  });
  it(`${layout}: resets an unassigned draft on receipt navigation and ignores its late assignment`, async () => {
    api.fetch.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('/chat-preparation')
              ? {
                  repositoryChat: url.includes(otherId)
                    ? {
                        ...preparation,
                        id: otherId,
                        prompt: 'Other saved task',
                        setupUrl: `/chat?repositoryPreparation=${otherId}`,
                      }
                    : preparation,
                }
              : accounts,
          ),
        ),
    );
    const { send, newSession } = fixture(View);
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Send task' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send task' }));
    const previous = newSession.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Other preparation' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Task draft') as HTMLInputElement).value).toBe(
        'Other saved task',
      ),
    );
    expect(newSession.mock.calls.length).toBe(previous + 1);
    fireEvent.change(screen.getByLabelText('Task draft'), {
      target: { value: 'Other edited task' },
    });
    act(() => send.mock.calls[0][1].onSessionAssigned('stale-target'));
    expect(localStorage.getItem(`mitzo-repository-prompt:${id}`)).toBe(preparation.prompt);
    expect((screen.getByLabelText('Task draft') as HTMLInputElement).value).toBe(
      'Other edited task',
    );
    expect(screen.getByTestId('location').textContent).toBe(
      `/chat?repositoryPreparation=${otherId}`,
    );
  });
  it(`${layout}: recovers the editable task and sends only the prepared binding after explicit Send`, async () => {
    api.fetch.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('/chat-preparation')
              ? { repositoryChat: preparation }
              : url.includes('/sessions/assigned/meta')
                ? {
                    accountBinding: {
                      accountId: 'prepared',
                      accountLabel: 'Prepared',
                      model: 'luna',
                    },
                    modelSelection: {
                      model: 'luna',
                      models: [
                        ...accounts[1].models,
                        { id: 'manual-model', label: 'Manual model' },
                      ],
                    },
                  }
                : accounts,
          ),
        ),
    );
    const { store, send } = fixture(View);
    await waitFor(() =>
      expect((screen.getByLabelText('Task draft') as HTMLInputElement).value).toBe(
        preparation.prompt,
      ),
    );
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Send task' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.getByTestId('preparation-id').textContent).toBe(id);
    expect(send).not.toHaveBeenCalled();
    expect(localStorage.getItem('mitzo-default-account-model')).toContain('other');
    expect(localStorage.getItem(PREFERRED_MODEL_KEY)).toBe('remembered-model');
    expect(localStorage.getItem('mitzo-draft-new')).toBe(ordinaryDraft);
    fireEvent.change(screen.getByLabelText('Task draft'), { target: { value: 'Edited task' } });
    await waitFor(() =>
      expect(localStorage.getItem(`mitzo-repository-prompt:${id}`)).toBe('Edited task'),
    );
    expect(localStorage.getItem('mitzo-draft-new')).toBe(ordinaryDraft);
    fireEvent.click(screen.getByRole('button', { name: 'Send task' }));
    expect(send).toHaveBeenCalledWith(
      'Edited task',
      expect.objectContaining({ accountId: 'prepared', model: 'luna', repositoryWorkspaceId: id }),
    );
    expect(localStorage.getItem(PREFERRED_MODEL_KEY)).toBe('remembered-model');
    expect(localStorage.getItem(`mitzo-repository-prompt:${id}`)).toBe('Edited task');
    fireEvent.change(screen.getByLabelText('Task draft'), {
      target: { value: 'Edit while pending' },
    });
    expect(localStorage.getItem('mitzo-draft-new')).toBe(ordinaryDraft);
    act(() => {
      send.mock.calls[0][1].onSessionAssigned('assigned');
      store.setState({ sessions: { ...store.getState().sessions, active: 'assigned' } });
    });
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/chat/assigned'));
    await screen.findByText('Prepared');
    expect((screen.getByLabelText('Task draft') as HTMLInputElement).value).toBe('');
    expect(localStorage.getItem('mitzo-draft-new')).toBe(ordinaryDraft);
    expect(localStorage.getItem('mitzo-draft-assigned')).toBeNull();
    expect(localStorage.getItem(`mitzo-repository-prompt:${id}`)).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(PREFERRED_MODEL_KEY)).toBe('remembered-model');
    expect(localStorage.getItem('mitzo-default-account-model')).toContain('other');
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), {
      target: { value: 'manual-model' },
    });
    expect(localStorage.getItem(PREFERRED_MODEL_KEY)).toBe('manual-model');
    expect(store.getState().config.modelId).toBe('manual-model');
    expect(localStorage.getItem('mitzo-default-account-model')).toContain('other');
  });
  it(`${layout}: blocks the early send handler while the old active session is being cleared`, async () => {
    api.fetch.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('/chat-preparation')
              ? { repositoryChat: preparation }
              : { accountBinding: { accountId: 'other', accountLabel: 'Other', model: 'sol' } },
          ),
        ),
    );
    const store = createTestStore();
    const send = vi.fn();
    const setModel = vi.fn();
    store.setState({
      sendMessage: send,
      setModel,
      newSession: vi.fn(),
      sessions: { ...store.getState().sessions, active: 'parent' },
      connection: { status: 'connected', clientId: 'offline' },
    });
    render(
      <MitzoStoreProvider value={store}>
        <MemoryRouter initialEntries={[`/chat?repositoryPreparation=${id}`]}>
          <View />
        </MemoryRouter>
      </MitzoStoreProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try send directly' }));
    await screen.findByText('example/repo');
    fireEvent.click(screen.getByRole('button', { name: 'Try send directly' }));
    expect(send).not.toHaveBeenCalled();
    expect(setModel).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Send task' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
  it(`${layout}: preserves a claimed target and blocks another launch`, async () => {
    api.fetch.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('/chat-preparation')
              ? { repositoryChat: { ...preparation, state: 'claimed', conversationId: 'original' } }
              : accounts,
          ),
        ),
    );
    const { send } = fixture(View);
    expect(
      (await screen.findByRole('link', { name: 'Open repository conversation' })).getAttribute(
        'href',
      ),
    ).toBe('/chat/original');
    fireEvent.click(screen.getByRole('button', { name: 'Try send directly' }));
    expect(send).not.toHaveBeenCalled();
    expect(api.fetch.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);
  });
  it(`${layout}: ignores an unrelated store assignment until this draft is actually acknowledged`, async () => {
    api.fetch.mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('/chat-preparation') ? { repositoryChat: preparation } : accounts,
          ),
        ),
    );
    const { store, send } = fixture(View);
    await screen.findByText('example/repo');
    fireEvent.change(screen.getByLabelText('Task draft'), {
      target: { value: 'Retain for own assignment' },
    });
    act(() => store.setState({ sessions: { ...store.getState().sessions, active: 'unrelated' } }));
    expect(screen.getByTestId('location').textContent).toBe(`/chat?repositoryPreparation=${id}`);
    fireEvent.click(screen.getByRole('button', { name: 'Try send directly' }));
    expect(send).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Task draft') as HTMLInputElement).value).toBe(
      'Retain for own assignment',
    );
  });
}
