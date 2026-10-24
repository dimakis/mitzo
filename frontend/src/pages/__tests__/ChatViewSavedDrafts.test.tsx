// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useEffect, useRef } from 'react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { createTestStore } from '../../test-utils/createTestStore';
import { ChatView } from '../ChatView';
import { DesktopChatView } from '../DesktopChatView';
import {
  createChatDraft,
  getChatDraft,
  listChatDrafts,
  saveChatDraft,
} from '../../lib/chat-drafts';
import type { AccountSelection } from '../../components/AccountModelPicker';

function openAgentSettings() {
  const settings = screen.getByRole('button', { name: /^Workspace controls,/ });
  if (settings.getAttribute('aria-expanded') !== 'true') fireEvent.click(settings);
}

vi.mock('../../components/AccountModelPicker', () => ({
  AccountModelPicker: ({
    initialSelection,
    onChange,
  }: {
    initialSelection?: AccountSelection;
    onChange(value: AccountSelection | null): void;
  }) => {
    const initialChange = useRef(onChange);
    useEffect(() => {
      initialChange.current(null);
    }, []);
    return (
      <>
        <span data-testid="restored-selection">{JSON.stringify(initialSelection)}</span>
        <button
          onClick={() =>
            onChange(
              initialSelection ?? { accountId: 'work', model: 'luna', reasoningEffort: 'high' },
            )
          }
        >
          Hydrate account
        </button>
        <button
          onClick={() => onChange({ accountId: 'personal', model: 'luna', reasoningEffort: 'low' })}
        >
          Change saved account
        </button>
      </>
    );
  },
}));
vi.mock('../../components/ChatAgentProfilePicker', () => ({ ChatAgentProfilePicker: () => null }));
vi.mock('../../components/RepositoryChatPicker', () => ({
  RepositoryChatPicker: ({
    initialPreparationId,
    draftScoped,
    onChange,
  }: {
    initialPreparationId?: string;
    draftScoped?: boolean;
    onChange(value: { blocked: boolean; repositoryWorkspaceId?: string } | null): void;
  }) => (
    <>
      <span data-testid="repository-id">{initialPreparationId ?? ''}</span>
      <span data-testid="repository-scoped">{String(draftScoped)}</span>
      <button
        onClick={() =>
          onChange({
            blocked: false,
            repositoryWorkspaceId: initialPreparationId ?? '8ca30b0d-3e65-4eeb-8244-f6277350818f',
          })
        }
      >
        Ready scoped repository
      </button>
      <button
        onClick={() =>
          onChange({
            blocked: true,
            repositoryWorkspaceId: initialPreparationId ?? '8ca30b0d-3e65-4eeb-8244-f6277350818f',
          })
        }
      >
        Preparing scoped repository
      </button>
      <button onClick={() => onChange(null)}>Remove scoped repository</button>
    </>
  ),
}));
vi.mock('../../components/SymposiumConversation', () => ({
  SymposiumConversation: ({ ordinaryComposer }: { ordinaryComposer: React.ReactNode }) => (
    <>{ordinaryComposer}</>
  ),
}));
vi.mock('../../components/DesktopShell', () => ({
  DesktopShell: ({
    center,
    left,
    right,
  }: {
    center: React.ReactNode;
    left: React.ReactNode;
    right: React.ReactNode;
  }) => (
    <>
      {left}
      {center}
      {right}
    </>
  ),
}));
vi.mock('../../components/SessionPanel', () => ({
  SessionPanel: ({ onNewChat }: { onNewChat(): void }) => (
    <button onClick={onNewChat}>New chat</button>
  ),
}));
vi.mock('../../components/CommandCenter', () => ({ CommandCenter: () => null }));
vi.mock('../../components/ScrollFab', () => ({ ScrollFab: () => null }));
vi.mock('../../components/SlashPicker', () => ({ SlashPicker: () => null }));
vi.mock('../../components/SessionResourcesDialog', () => ({ SessionResourcesDialog: () => null }));
vi.mock('../../components/MicButton', () => ({ MicButton: () => null }));
vi.mock('../../components/VoiceSettings', () => ({ VoiceSettings: () => null }));
vi.mock('../../components/WebSearchConsent', () => ({ WebSearchConsent: () => null }));
vi.mock('../../hooks/useProgress', () => ({ useProgressByToolId: () => new Map() }));
vi.mock('../../hooks/useVoice', () => ({
  useVoice: () => ({ available: false, stopSpeaking: vi.fn(), voices: [] }),
}));
vi.mock('../../hooks/useBriefingChat', () => ({ useBriefingChat: () => ({}) }));
vi.mock('../../lib/keyboard', () => ({ onKeyboardToggle: () => () => {} }));
vi.mock('../../lib/haptics', () => ({ impactMedium: vi.fn() }));
vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(async () => new Response('[]')),
  getApiBaseUrl: () => '',
  AUTH_LOST_EVENT: 'auth-lost',
  AUTH_RESTORED_EVENT: 'auth-restored',
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});
function Location() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <span data-testid="location">{location.pathname + location.search}</span>
      <button onClick={() => navigate('/chat?draft=second')}>Open second draft</button>
    </>
  );
}
function mount(Page: typeof ChatView, entry: string, active?: string) {
  const store = createTestStore();
  const send = vi.fn();
  store.setState({
    sendMessage: send,
    ...(active ? { sessions: { ...store.getState().sessions, active } } : {}),
  });
  const view = render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter initialEntries={[entry]}>
        <Location />
        <Routes>
          <Route path="/chat/:sessionId?" element={<Page />} />
        </Routes>
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  return { store, send, ...view };
}
for (const Page of [ChatView, DesktopChatView]) {
  it(`${Page.name} clears an emptied draft reference so reloading opens a usable blank composer`, () => {
    const draft = { ...createChatDraft(), text: 'Clear this draft' };
    draft.settings.selection = { accountId: 'work', model: 'luna', reasoningEffort: 'high' };
    draft.settings.mode = 'ask';
    draft.settings.search = 'cwd=%2Fworkspace';
    saveChatDraft(draft);
    const view = mount(Page, `/chat?draft=${draft.id}&cwd=%2Fworkspace`);
    openAgentSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Hydrate account' }));
    fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: '' } });
    expect(getChatDraft(draft.id)).toBeNull();
    expect(screen.getByTestId('location').textContent).toBe('/chat?cwd=%2Fworkspace');
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(screen.getByLabelText('Message Mitzo'), {
      target: { value: 'Still editable' },
    });
    expect(getChatDraft(draft.id)?.settings).toMatchObject({
      selection: draft.settings.selection,
      mode: 'ask',
    });
    fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: '' } });
    const clearedUrl = screen.getByTestId('location').textContent!;
    view.unmount();
    const reloaded = mount(Page, clearedUrl);
    expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', '');
    expect(screen.queryByRole('alert')).toBeNull();
    openAgentSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Hydrate account' }));
    fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: 'After reload' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
    expect(reloaded.send).toHaveBeenCalled();
  });
  it(`${Page.name} keeps a preparation-only draft before typing, after clearing and through reload until removal`, () => {
    const view = mount(Page, '/chat');
    openAgentSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Hydrate account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ready scoped repository' }));
    const draft = listChatDrafts()[0];
    expect(draft?.text).toBe('');
    expect(draft?.settings).toMatchObject({
      repositoryWorkspaceId: '8ca30b0d-3e65-4eeb-8244-f6277350818f',
      selection: { accountId: 'work', model: 'luna', reasoningEffort: 'high' },
    });
    fireEvent.change(screen.getByLabelText('Message Mitzo'), {
      target: { value: 'Temporary text' },
    });
    fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: '' } });
    const savedUrl = screen.getByTestId('location').textContent!;
    expect(savedUrl).toContain(`draft=${draft.id}`);
    view.unmount();
    mount(Page, savedUrl);
    expect(screen.queryByRole('alert')).toBeNull();
    openAgentSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Hydrate account' }));
    expect(screen.getByTestId('repository-id').textContent).toBe(
      draft.settings.repositoryWorkspaceId,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove scoped repository' }));
    expect(getChatDraft(draft.id)).toBeNull();
    expect(screen.getByTestId('location').textContent).toBe('/chat');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it(`${Page.name} removes a cleared quick-action prompt from its reload URL`, () => {
    mount(Page, '/chat?prompt=Clear+this+prompt&cwd=%2Fworkspace');
    fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: '' } });
    expect(screen.getByTestId('location').textContent).toBe('/chat?cwd=%2Fworkspace');
    expect(listChatDrafts()).toEqual([]);
  });
  it(`${Page.name} restores retained account, reasoning, mode and isolation and preserves them while loading`, async () => {
    const draft = { ...createChatDraft(), text: 'Retained briefing' };
    draft.settings = {
      ...draft.settings,
      selection: { accountId: 'personal', model: 'luna', reasoningEffort: 'low' },
      mode: 'ask',
      isolation: false,
      search: 'cwd=%2Fworkspace&extraTools=read',
    };
    saveChatDraft(draft);
    const { store, send } = mount(Page, `/chat?draft=${draft.id}`);
    expect((screen.getByLabelText('Message Mitzo') as HTMLTextAreaElement).value).toBe(draft.text);
    expect(screen.getByTestId('restored-selection').textContent).toContain('personal');
    expect(getChatDraft(draft.id)?.settings).toMatchObject(draft.settings);
    openAgentSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Hydrate account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
    expect(store.getState().config.mode).toBe('ask');
    expect(send).toHaveBeenCalledWith(
      draft.text,
      expect.objectContaining({
        accountId: 'personal',
        reasoningEffort: 'low',
        mode: 'ask',
        isolation: false,
        cwd: '/workspace',
        extraTools: 'read',
      }),
    );
  });
  it(`${Page.name} retains a quick-action initial prompt as a fresh editable draft`, () => {
    mount(Page, '/chat?prompt=Review+this+update&cwd=%2Fworkspace');
    expect((screen.getByLabelText('Message Mitzo') as HTMLTextAreaElement).value).toBe(
      'Review this update',
    );
    expect(listChatDrafts()[0]?.text).toBe('Review this update');
  });
  it(`${Page.name} opens a blank New chat and retains the previous editable draft`, () => {
    const draft = { ...createChatDraft(), text: 'Old thought' };
    saveChatDraft(draft);
    mount(Page, `/chat?draft=${draft.id}`);
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect((screen.getByLabelText('Message Mitzo') as HTMLTextAreaElement).value).toBe('');
    expect(getChatDraft(draft.id)?.text).toBe('Old thought');
    expect(screen.getByTestId('location').textContent).toBe('/chat');
    fireEvent.change(screen.getByLabelText('Message Mitzo'), {
      target: { value: 'Second thought' },
    });
    expect(
      listChatDrafts()
        .map((d) => d.text)
        .sort(),
    ).toEqual(['Old thought', 'Second thought']);
  });
  it(`${Page.name} gives fresh drafts a reloadable URL preserving launch settings`, async () => {
    mount(Page, '/chat?cwd=%2Fworkspace&extraTools=read&agentProfile=helper&profileRevision=2');
    openAgentSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Hydrate account' }));
    fireEvent.change(screen.getByLabelText('Message Mitzo'), {
      target: { value: 'Save for later' },
    });
    const draft = listChatDrafts()[0];
    expect(draft?.settings.selection).toMatchObject({
      accountId: 'work',
      model: 'luna',
      reasoningEffort: 'high',
    });
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toContain(`draft=${draft.id}`),
    );
    expect(screen.getByTestId('location').textContent).toContain('agentProfile=helper');
    expect(draft.settings.search).toContain('cwd=%2Fworkspace');
  });
  it(`${Page.name} navigates between two saved drafts without a remount or content crossover`, () => {
    const first = { ...createChatDraft(), text: 'First thought', contextBlocks: ['First context'] };
    first.settings.selection = {
      accountId: 'first-account',
      model: 'luna',
      reasoningEffort: 'high',
    };
    const second = {
      ...createChatDraft(),
      id: 'second',
      text: 'Second thought',
      contextBlocks: ['Second context'],
    };
    second.settings.selection = {
      accountId: 'second-account',
      model: 'luna',
      reasoningEffort: 'low',
    };
    saveChatDraft(first);
    saveChatDraft(second);
    mount(Page, `/chat?draft=${first.id}`);
    openAgentSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Hydrate account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open second draft' }));
    expect((screen.getByLabelText('Message Mitzo') as HTMLTextAreaElement).value).toBe(
      'Second thought',
    );
    expect(getChatDraft(first.id)?.text).toBe('First thought');
    expect(getChatDraft(second.id)).toMatchObject({
      text: 'Second thought',
      contextBlocks: ['Second context'],
      settings: { selection: { accountId: 'second-account' } },
    });
  });
  it(`${Page.name} restores its exact preparation and keeps blocked IDs until explicit removal`, () => {
    const draft = { ...createChatDraft(), text: 'Repository task' };
    draft.settings.selection = { accountId: 'work', model: 'luna', reasoningEffort: 'high' };
    draft.settings.repositoryWorkspaceId = '8ca30b0d-3e65-4eeb-8244-f6277350818f';
    saveChatDraft(draft);
    mount(Page, `/chat?draft=${draft.id}`);
    openAgentSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Hydrate account' }));
    expect(screen.getByTestId('repository-id').textContent).toBe(
      draft.settings.repositoryWorkspaceId,
    );
    expect(screen.getByTestId('repository-scoped').textContent).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Preparing scoped repository' }));
    expect(getChatDraft(draft.id)?.settings.repositoryWorkspaceId).toBe(
      draft.settings.repositoryWorkspaceId,
    );
    expect(
      (screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove scoped repository' }));
    expect(getChatDraft(draft.id)?.settings.repositoryWorkspaceId).toBeNull();
  });
  it(`${Page.name} requires removing a prepared repository before changing its account or model`, () => {
    const draft = { ...createChatDraft(), text: 'Repository task' };
    draft.settings.selection = { accountId: 'work', model: 'luna', reasoningEffort: 'high' };
    draft.settings.repositoryWorkspaceId = '8ca30b0d-3e65-4eeb-8244-f6277350818f';
    saveChatDraft(draft);
    const { send } = mount(Page, `/chat?draft=${draft.id}`);
    openAgentSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Hydrate account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ready scoped repository' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change saved account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/remove.*repository.*account/i);
    expect(getChatDraft(draft.id)?.settings).toMatchObject({
      selection: { accountId: 'work' },
      repositoryWorkspaceId: draft.settings.repositoryWorkspaceId,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove scoped repository' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change saved account' }));
    expect(getChatDraft(draft.id)?.settings).toMatchObject({
      selection: { accountId: 'personal' },
      repositoryWorkspaceId: null,
    });
  });
  it(`${Page.name} restores each draft’s own preparation when navigating between drafts`, () => {
    const first = { ...createChatDraft(), text: 'First repository task' };
    const second = { ...createChatDraft(), id: 'second', text: 'Second repository task' };
    first.settings.selection = second.settings.selection = { accountId: 'work', model: 'luna' };
    first.settings.repositoryWorkspaceId = '8ca30b0d-3e65-4eeb-8244-f6277350818f';
    second.settings.repositoryWorkspaceId = 'aaaaaaaa-bbbb-4ccc-8ddd-121212121212';
    saveChatDraft(first);
    saveChatDraft(second);
    mount(Page, `/chat?draft=${first.id}`);
    openAgentSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Hydrate account' }));
    expect(screen.getByTestId('repository-id').textContent).toBe(
      first.settings.repositoryWorkspaceId,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open second draft' }));
    openAgentSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Hydrate account' }));
    expect(screen.getByTestId('repository-id').textContent).toBe(
      second.settings.repositoryWorkspaceId,
    );
    expect(getChatDraft(first.id)?.settings.repositoryWorkspaceId).toBe(
      first.settings.repositoryWorkspaceId,
    );
    expect(getChatDraft(second.id)?.settings.repositoryWorkspaceId).toBe(
      second.settings.repositoryWorkspaceId,
    );
  });
  it(`${Page.name} blocks a missing reference without replacing it with an empty saved draft`, () => {
    const { send } = mount(Page, '/chat?draft=missing');
    openAgentSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Hydrate account' }));
    fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: 'Cannot send' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
    expect(send).not.toHaveBeenCalled();
    expect(listChatDrafts()).toEqual([]);
    expect(screen.getByRole('alert').textContent).toMatch(/draft.*unavailable/i);
  });
}

vi.mock('../../hooks/useExplicitLocalChat', async () => {
  const { disabledLocalChat } = await import('../../test-utils/disabled-local-chat');
  return { useExplicitLocalChat: disabledLocalChat };
});

for (const Page of [ChatView, DesktopChatView]) {
  it(`${Page.name} reopens an unsent briefing in its own draft and New clears its chrome`, async () => {
    // A fast render must not hide repeated draft writes behind one timestamp.
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => ++now);
    const originalSetItem = Storage.prototype.setItem;
    let writes = 0;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      // Bound a regression locally instead of letting its notifications exhaust CI.
      if (++writes > 80) throw new Error('Unbounded saved briefing notifications');
      return originalSetItem.call(this, key, value);
    });
    const draft = { ...createChatDraft(), text: 'Explore my saved briefing' };
    const launch = {
      prompt: draft.text,
      context: 'Morning briefing',
      briefing: { date: '2026-10-15', revision: 'a'.repeat(64) },
      accountSelection: { accountId: 'work', model: 'luna' },
    };
    saveChatDraft({ ...draft, settings: { ...draft.settings, launch } });
    const view = mount(Page, `/chat?draft=${draft.id}`, 'unrelated');
    await waitFor(() => expect(view.store.getState().pendingSession).toMatchObject(launch));
    expect(screen.getByRole('button', { name: 'Send launch prompt' })).toBeTruthy();
    expect(getChatDraft(draft.id)?.settings.launch).toMatchObject(launch);
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.queryByRole('button', { name: 'Send launch prompt' })).toBeNull();
    expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', '');
    expect(getChatDraft(draft.id)?.settings.launch).toMatchObject(launch);
    expect(view.send).not.toHaveBeenCalled();
    expect(writes).toBeLessThan(80);
  });
}

for (const Page of [ChatView, DesktopChatView]) {
  it(`${Page.name} saves and restores the confirmed account of an ordinary contextual launch`, () => {
    const draft = { ...createChatDraft(), text: 'Meeting preparation' };
    saveChatDraft({
      ...draft,
      settings: { ...draft.settings, launch: { prompt: draft.text, context: 'Meeting' } },
    });
    const view = mount(Page, `/chat?draft=${draft.id}`);
    openAgentSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Change saved account' }));
    expect(getChatDraft(draft.id)?.settings.selection).toEqual({
      accountId: 'personal',
      model: 'luna',
      reasoningEffort: 'low',
    });
    view.unmount();
    mount(Page, `/chat?draft=${draft.id}`);
    openAgentSettings();
    expect(screen.getByTestId('restored-selection').textContent).toContain('personal');
  });
}

import { act } from '@testing-library/react';
import {
  bindChatDraftToSession,
  consumeChatDraft,
  getSessionChatDraft,
} from '../../lib/chat-drafts';
for (const Page of [ChatView, DesktopChatView]) {
  it(`${Page.name} restores a silently bound rich draft and releases it to the ordinary owner after acceptance`, async () => {
    const draft = {
      ...createChatDraft(),
      text: 'Typed before binding',
      images: [
        { data: 'ZmFrZQ==', preview: 'data:image/png;base64,ZmFrZQ==', mediaType: 'image/png' },
      ],
      contextBlocks: ['Retained selected resource'],
    };
    draft.settings.retainRuntimeIntent = true;
    saveChatDraft(draft);
    expect(bindChatDraftToSession(draft.id, 'bound-chat')).toBe('bound');
    mount(Page, '/chat/bound-chat', 'bound-chat');
    expect((screen.getByLabelText('Message Mitzo') as HTMLTextAreaElement).value).toBe(
      'Typed before binding',
    );
    expect(screen.getByAltText('Attachment 1')).toBeTruthy();
    expect(getSessionChatDraft('bound-chat')?.contextBlocks).toEqual([
      'Retained selected resource',
    ]);
    act(() => {
      expect(consumeChatDraft(getChatDraft(draft.id)!)).toBe(true);
    });
    fireEvent.change(screen.getByLabelText('Message Mitzo'), {
      target: { value: 'Next ordinary message' },
    });
    await waitFor(() =>
      expect(localStorage.getItem('mitzo-draft-bound-chat')).toBe('Next ordinary message'),
    );
    expect(getChatDraft(draft.id)).toBeNull();
  });
}

const roleDraftFence = vi.hoisted(() => ({ setup: vi.fn() }));
vi.mock('../../hooks/useTelosRoleSetup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/useTelosRoleSetup')>();
  return {
    ...actual,
    useTelosRoleSetup: (
      options: import('../../hooks/useTelosRoleSetup').TelosRoleSetupOptions,
    ) => ({
      context: null,
      pending: null,
      error: null,
      uncertain: false,
      locked: false,
      canConfirm: true,
      boundConversationId: null,
      replacing: false,
      review: async () => {},
      confirm: async () => {
        await roleDraftFence.setup();
        options.onBound?.('confirmed-role-chat');
      },
      retry: async () => {
        await roleDraftFence.setup();
        options.onBound?.('confirmed-role-chat');
      },
    }),
  };
});
for (const Page of [ChatView, DesktopChatView]) {
  it(`${Page.name} refuses silent role setup when the latest rich draft cannot be saved even though binding records fit`, async () => {
    roleDraftFence.setup.mockClear();
    const draft = {
      ...createChatDraft(),
      text: 'Previously saved setup text',
      images: [
        { data: 'ZmFrZQ==', preview: 'data:image/png;base64,ZmFrZQ==', mediaType: 'image/png' },
      ],
      contextBlocks: ['Retained selected resource'],
    };
    draft.settings.retainRuntimeIntent = true;
    draft.settings.search = 'telosRoleItem=item&telosRole=lead&telosRoleMode=assign';
    saveChatDraft(draft);
    const write = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === `mitzo-chat-draft:${draft.id}`)
        throw new DOMException('Rich draft exceeds quota', 'QuotaExceededError');
      write.call(this, key, value);
    });
    mount(Page, `/chat?draft=${draft.id}&${draft.settings.search}`);
    fireEvent.change(screen.getByLabelText('Message Mitzo'), {
      target: { value: 'Latest unsaved setup text' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Assign lead & open chat' }));
    await waitFor(() => expect(roleDraftFence.setup).not.toHaveBeenCalled());
    const retainedLocation = new URL(
      screen.getByTestId('location').textContent!,
      'http://example.test',
    );
    expect(retainedLocation.pathname).toBe('/chat');
    expect(retainedLocation.searchParams.get('draft')).toBe(draft.id);
    expect(retainedLocation.searchParams.get('telosRoleItem')).toBe('item');
    expect((screen.getByLabelText('Message Mitzo') as HTMLTextAreaElement).value).toBe(
      'Latest unsaved setup text',
    );
    expect(screen.getByAltText('Attachment 1')).toBeTruthy();
    expect(getChatDraft(draft.id)?.text).toBe('Previously saved setup text');
    expect(getSessionChatDraft('confirmed-role-chat')).toBeNull();
  });
}
for (const Page of [ChatView, DesktopChatView]) {
  it(`${Page.name} rechecks the latest rich draft after awaited role setup before binding or navigation`, async () => {
    roleDraftFence.setup.mockClear();
    let finish!: () => void;
    roleDraftFence.setup.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const draft = {
      ...createChatDraft(),
      text: 'Persisted before setup',
      contextBlocks: ['Retained context'],
    };
    draft.settings.retainRuntimeIntent = true;
    draft.settings.search = 'telosRoleItem=item&telosRole=lead&telosRoleMode=assign';
    saveChatDraft(draft);
    mount(Page, `/chat?draft=${draft.id}&${draft.settings.search}`);
    fireEvent.click(screen.getByRole('button', { name: 'Assign lead & open chat' }));
    expect(roleDraftFence.setup).toHaveBeenCalledOnce();
    const write = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === `mitzo-chat-draft:${draft.id}`)
        throw new DOMException('Rich draft exceeds quota', 'QuotaExceededError');
      write.call(this, key, value);
    });
    fireEvent.change(screen.getByLabelText('Message Mitzo'), {
      target: { value: 'Latest edit during setup' },
    });
    await act(async () => finish());
    const retainedLocation = new URL(
      screen.getByTestId('location').textContent!,
      'http://example.test',
    );
    expect(retainedLocation.pathname).toBe('/chat');
    expect(retainedLocation.searchParams.get('draft')).toBe(draft.id);
    expect(retainedLocation.searchParams.get('telosRoleItem')).toBe('item');
    expect((screen.getByLabelText('Message Mitzo') as HTMLTextAreaElement).value).toBe(
      'Latest edit during setup',
    );
    expect(getChatDraft(draft.id)?.text).toBe('Persisted before setup');
    expect(getSessionChatDraft('confirmed-role-chat')).toBeNull();
  });
}
