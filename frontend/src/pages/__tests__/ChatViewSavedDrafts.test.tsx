// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
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

vi.mock('../../components/AccountModelPicker', () => ({
  AccountModelPicker: ({
    initialSelection,
    onChange,
  }: {
    initialSelection?: AccountSelection;
    onChange(value: AccountSelection | null): void;
  }) => {
    useEffect(() => {
      onChange(null);
    }, [onChange]);
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
vi.mock('../../components/RepositoryChatPicker', () => ({ RepositoryChatPicker: () => null }));
vi.mock('../../components/SymposiumConversation', () => ({
  SymposiumConversation: ({ ordinaryComposer }: { ordinaryComposer: React.ReactNode }) => (
    <>{ordinaryComposer}</>
  ),
}));
vi.mock('../../components/WorkspaceControls', () => ({
  WorkspaceControls: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../components/DesktopShell', () => ({
  DesktopShell: ({ center, left }: { center: React.ReactNode; left: React.ReactNode }) => (
    <>
      {left}
      {center}
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
vi.mock('../../components/SessionTray', () => ({ SessionTray: () => null }));
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
function mount(Page: typeof ChatView, entry: string) {
  const store = createTestStore();
  const send = vi.fn();
  store.setState({ sendMessage: send });
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
    fireEvent.click(screen.getByRole('button', { name: 'Hydrate account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
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
  it(`${Page.name} blocks a missing reference without replacing it with an empty saved draft`, () => {
    const { send } = mount(Page, '/chat?draft=missing');
    fireEvent.click(screen.getByRole('button', { name: 'Hydrate account' }));
    fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: 'Cannot send' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(send).not.toHaveBeenCalled();
    expect(listChatDrafts()).toEqual([]);
    expect(screen.getByRole('alert').textContent).toMatch(/draft.*unavailable/i);
  });
}
