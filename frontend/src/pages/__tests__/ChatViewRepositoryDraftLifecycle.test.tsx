// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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

// Exercise repository preparation and route authority through the original
// editors directly. Real sheet navigation and mounted preparation/draft behavior
// are covered by QuickChatSettings and the offline draft/runtime journeys.
vi.mock('../../lib/quick-settings-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/quick-settings-context')>()),
  useQuickSettings: () => null,
}));

vi.mock('../../components/ChatAgentProfilePicker', () => ({ ChatAgentProfilePicker: () => null }));
vi.mock('../../components/SymposiumConversation', () => ({
  SymposiumConversation: ({ ordinaryComposer }: { ordinaryComposer: React.ReactNode }) => (
    <>{ordinaryComposer}</>
  ),
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
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
  getApiBaseUrl: () => '',
  AUTH_LOST_EVENT: 'auth-lost',
  AUTH_RESTORED_EVENT: 'auth-restored',
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
});
for (const Page of [ChatView, DesktopChatView]) {
  it.each([false, true])(
    `${Page.name} keeps a pending repository preparation mounted while saving and locking its account`,
    async (fresh) => {
      const draft = { ...createChatDraft(), text: 'Repository task' };
      draft.settings.selection = { accountId: 'work', model: 'luna', reasoningEffort: 'high' };
      if (fresh)
        localStorage.setItem(
          'mitzo-default-account-model',
          JSON.stringify(draft.settings.selection),
        );
      else saveChatDraft(draft);
      const preview = {
        id: '8ca30b0d-3e65-4eeb-8244-f6277350818f',
        repository: 'example/repo',
        baseBranch: 'main',
        baseOid: 'a'.repeat(40),
        featureBranch: 'task',
        state: 'preview',
      };
      let resolvePrepare!: (response: Response) => void;
      let prepareSignal: AbortSignal | undefined;
      let failCatalog = false;
      vi.mocked(apiFetch).mockImplementation(async (url, options) => {
        const path = String(url);
        if (failCatalog && path.includes('/accounts')) throw new Error('catalog refresh failed');
        if (path.endsWith('/prepare')) {
          prepareSignal = options?.signal as AbortSignal;
          return new Promise((resolve) => {
            resolvePrepare = resolve;
          });
        }
        const data = path.includes('/accounts')
          ? [
              {
                id: 'work',
                label: 'Work',
                models: [{ id: 'luna', label: 'Luna', reasoningEfforts: ['low', 'high'] }],
              },
            ]
          : path.includes('/catalog')
            ? {
                available: true,
                repositories: [
                  { connectionId: 'github', label: 'GitHub', repository: 'example/repo' },
                ],
              }
            : path.endsWith('/preview')
              ? preview
              : [];
        return new Response(JSON.stringify(data));
      });
      const store = createTestStore();
      const view = render(
        <MitzoStoreProvider value={store}>
          <MemoryRouter
            initialEntries={[fresh ? '/chat?prompt=Repository+task' : `/chat?draft=${draft.id}`]}
          >
            <Routes>
              <Route path="/chat/:sessionId?" element={<Page />} />
            </Routes>
          </MemoryRouter>
        </MitzoStoreProvider>,
      );
      const controls = await screen.findByRole('button', { name: /^Workspace controls/ });
      if (controls.getAttribute('aria-expanded') !== 'true') fireEvent.click(controls);
      await screen.findByRole('button', { name: 'Add repository' });
      const draftId = listChatDrafts()[0].id;
      fireEvent.click(screen.getByRole('button', { name: 'Add repository' }));
      fireEvent.change(screen.getByLabelText('GitHub repository'), {
        target: { value: 'github:example/repo' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Preview repository' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Prepare repository' }));
      await waitFor(() =>
        expect(getChatDraft(draftId)?.settings.repositoryWorkspaceId).toBe(preview.id),
      );
      expect(prepareSignal?.aborted).toBe(false);
      expect((screen.getByLabelText('Account') as HTMLSelectElement).disabled).toBe(true);
      expect((screen.getByLabelText('Model') as HTMLSelectElement).disabled).toBe(true);
      expect((screen.getByLabelText('Thinking level') as HTMLSelectElement).disabled).toBe(false);
      await act(async () =>
        resolvePrepare(new Response(JSON.stringify({ ...preview, state: 'ready' }))),
      );
      await screen.findByText(/Ready for your first prompt/);
      expect(prepareSignal?.aborted).toBe(false);
      expect(
        (screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement).disabled,
      ).toBe(false);
      failCatalog = true;
      const settings = screen.getByRole('button', { name: /^Workspace controls,/ });
      if (settings.getAttribute('aria-expanded') !== 'true') fireEvent.click(settings);
      fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }));
      await screen.findByRole('button', { name: 'Retry accounts' });
      view.unmount();
      expect(getChatDraft(draftId)?.settings).toMatchObject({
        selection: { accountId: 'work', model: 'luna' },
        repositoryWorkspaceId: preview.id,
      });
    },
  );
}

vi.mock('../../hooks/useExplicitLocalChat', async () => {
  const { disabledLocalChat } = await import('../../test-utils/disabled-local-chat');
  return { useExplicitLocalChat: disabledLocalChat };
});
