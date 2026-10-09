// @vitest-environment jsdom
import { useEffect, useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { createTestStore } from '../../test-utils/createTestStore';
import { ChatView } from '../ChatView';
import { DesktopChatView } from '../DesktopChatView';
import { PREFERRED_MODEL_KEY } from '../../lib/model-preference';
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../lib/api-fetch', () => ({ apiFetch: api.fetch, getApiBaseUrl: () => '' }));
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
vi.mock('../../components/ChatInput', () => ({
  ChatInput: ({
    initialText,
    onSend,
    sendDisabledReason,
  }: {
    initialText?: string;
    onSend(text: string): boolean;
    sendDisabledReason?: string;
  }) => {
    const [text, setText] = useState(initialText ?? '');
    return (
      <>
        <input
          aria-label="Task draft"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <span>{sendDisabledReason}</span>
        <button disabled={!!sendDisabledReason} onClick={() => onSend(text)}>
          Send task
        </button>
        <button onClick={() => onSend(text)}>Try send directly</button>
      </>
    );
  },
}));
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
function fixture(View: typeof ChatView, active: string | null = null) {
  const store = createTestStore();
  const send = vi.fn();
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
  render(
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
  return { store, send, newSession };
}
afterEach(() => {
  cleanup();
  api.fetch.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});

for (const [layout, View] of [
  ['mobile', ChatView],
  ['desktop', DesktopChatView],
] as const) {
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
    act(() => send.mock.calls[0][1].onSessionAssigned('stale-target'));
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
                    modelSelection: { model: 'luna', models: accounts[1].models },
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
    fireEvent.change(screen.getByLabelText('Task draft'), { target: { value: 'Edited task' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send task' }));
    expect(send).toHaveBeenCalledWith(
      'Edited task',
      expect.objectContaining({ accountId: 'prepared', model: 'luna', repositoryWorkspaceId: id }),
    );
    expect(localStorage.getItem(PREFERRED_MODEL_KEY)).toBe('remembered-model');
    act(() => {
      send.mock.calls[0][1].onSessionAssigned('assigned');
      store.setState({ sessions: { ...store.getState().sessions, active: 'assigned' } });
    });
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/chat/assigned'));
    await screen.findByText('Prepared');
    expect(localStorage.getItem(PREFERRED_MODEL_KEY)).toBe('remembered-model');
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
    act(() => store.setState({ sessions: { ...store.getState().sessions, active: 'unrelated' } }));
    expect(screen.getByTestId('location').textContent).toBe(`/chat?repositoryPreparation=${id}`);
    fireEvent.click(screen.getByRole('button', { name: 'Try send directly' }));
    expect(send).not.toHaveBeenCalled();
  });
}
