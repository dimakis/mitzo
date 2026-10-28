// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { createTestStore } from '../../test-utils/createTestStore';
import { localInventoryFixture } from '../../test-utils/local-inventory-fixture';
import { ChatView } from '../ChatView';
import { DesktopChatView } from '../DesktopChatView';
import { apiFetch } from '../../lib/api-fetch';
import { metadataConnection as channel } from '../../../../packages/client/src/__tests__/fixtures/metadata-connection.js';
vi.mock('../../../../packages/client/src/sse-connection.js', async () => ({
  SseConnection: (
    await import('../../../../packages/client/src/__tests__/fixtures/metadata-connection.js')
  ).MetadataTestConnection,
}));
vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
  getApiBaseUrl: () => '',
  AUTH_LOST_EVENT: 'auth-lost',
  AUTH_RESTORED_EVENT: 'auth-restored',
}));
vi.mock('../../lib/quick-settings-context', async (original) => ({
  ...(await original<typeof import('../../lib/quick-settings-context')>()),
  useQuickSettings: () => null,
}));
vi.mock('../../components/SymposiumConversation', () => ({
  SymposiumConversation: ({ ordinaryComposer }: { ordinaryComposer: React.ReactNode }) => (
    <>{ordinaryComposer}</>
  ),
}));
vi.mock('../../components/DesktopShell', () => ({
  DesktopShell: ({ center }: { center: React.ReactNode }) => <>{center}</>,
}));
vi.mock('../../components/SessionPanel', () => ({ SessionPanel: () => null }));
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
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
});
for (const Page of [ChatView, DesktopChatView]) {
  it.each(['session_info', '_open', '_foreground'])(
    `${Page.name} refreshes adopted repository routing on %s without losing the mounted draft or future choices`,
    async (event) => {
      const inventory = localInventoryFixture();
      inventory.accounts[0].models.push({
        id: 'luna-next',
        label: 'Next Luna',
        reasoningEfforts: ['low', 'high'],
      });
      const oldId = '11111111-1111-4111-8111-111111111111';
      const adoptedId = '22222222-2222-4222-8222-222222222222';
      const sessionId = 'bound-session';
      let workspaceId = oldId;
      let hold = false;
      const pending: Array<(response: Response) => void> = [];
      const metadata = () => ({
        sessionId,
        sessionType: 'chat',
        branch: 'same-task-branch',
        repositoryWorkspaceId: workspaceId,
        repositoryContext: { workspaceId, repository: 'example/repo' },
        runtimeCommandScope: 'conversation',
        mode: 'agent',
        agentProfile: inventory.agentProfiles[0],
        accountBinding: { ...inventory.accounts[0].account, model: 'luna-fixture' },
        modelSelection: {
          model: 'luna-fixture',
          models: inventory.accounts[0].models,
          reasoningEffort: 'low',
        },
        runtimeBinding: {
          version: 2,
          account: inventory.accounts[0].account,
          harness: { implementation: 'codex' },
          execution: { location: 'local', targetId: 'mac', targetRevision: 'target-r1' },
        },
      });
      const sent: Array<Record<string, unknown>> = [];
      const fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        if (url === '/local/send' || url === '/local/continue') {
          const body = JSON.parse(String(init?.body));
          sent.push(body);
          return Response.json(
            {
              ok: true,
              state: 'consumed',
              sessionId,
              clientMsgId: body.clientMsgId,
              dispatched: true,
            },
            { status: 202 },
          );
        }
        if (url.includes('/capabilities')) return Response.json(inventory);
        if (url.endsWith('/meta'))
          return hold ? new Promise((resolve) => pending.push(resolve)) : Response.json(metadata());
        if (url.endsWith('/symposium/status'))
          return Response.json({ sessionId, config: null, seats: [] });
        return Response.json([]);
      });
      vi.mocked(apiFetch).mockImplementation((url, init) => fetch(String(url), init));
      let queued = '[]';
      const store = createTestStore({
        transport: { fetch },
        sseConfig: { baseUrl: '', fetch },
        localFirstCommandConfig: {
          url: '/local/send',
          storage: {
            getItem: () => queued,
            setItem: (_key, value) => {
              queued = value;
            },
          },
        },
      });
      await store.getState().switchSession(sessionId);
      store.setState({
        modeChangeReady: true,
        connection: { status: 'connected', clientId: channel.id },
      });
      channel.listener({
        type: 'session_info',
        sessionId,
        branch: 'same-task-branch',
        cwd: '/old-task',
        worktree: false,
      });
      render(
        <MitzoStoreProvider value={store}>
          <MemoryRouter initialEntries={[`/chat/${sessionId}`]}>
            <Routes>
              <Route path="/chat/:sessionId" element={<Page />} />
            </Routes>
          </MemoryRouter>
        </MitzoStoreProvider>,
      );
      const settings = await screen.findByRole('button', { name: /^Workspace controls/ });
      if (settings.getAttribute('aria-expanded') !== 'true') fireEvent.click(settings);
      const model = await screen.findByRole('combobox', { name: 'Model' });
      await waitFor(() => expect(model).toBeEnabled());
      fireEvent.change(model, { target: { value: 'luna-next' } });
      fireEvent.change(screen.getByRole('combobox', { name: 'Thinking level' }), {
        target: { value: 'high' },
      });
      const draft = screen.getByRole('textbox', { name: 'Message Mitzo' });
      fireEvent.change(draft, { target: { value: 'so is it not operational now?' } });
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled(),
      );
      hold = true;
      workspaceId = adoptedId;
      act(() =>
        channel.listener(
          event === 'session_info'
            ? {
                type: event,
                sessionId,
                branch: 'same-task-branch',
                cwd: '/adopted-task',
                worktree: false,
              }
            : { type: event },
        ),
      );
      expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      expect(sent).toEqual([]);
      expect(screen.getByRole('textbox', { name: 'Message Mitzo' })).toBe(draft);
      expect(draft).toHaveValue('so is it not operational now?');
      await waitFor(() => expect(pending.length).toBeGreaterThan(0));
      hold = false;
      await act(async () => {
        for (const resolve of pending) resolve(Response.json(metadata()));
      });
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled(),
      );
      expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('luna-next');
      expect(screen.getByRole('combobox', { name: 'Thinking level' })).toHaveValue('high');
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0]).toMatchObject({
        sessionId,
        repositoryWorkspaceId: adoptedId,
        runtime: { account: inventory.accounts[0].account },
        selection: {
          agent: { profileId: 'agent', revision: 1 },
          model: 'luna-next',
          thinking: 'high',
        },
        payload: { text: 'so is it not operational now?' },
      });
      expect(JSON.stringify(sent[0])).not.toContain(oldId);
    },
  );
}
