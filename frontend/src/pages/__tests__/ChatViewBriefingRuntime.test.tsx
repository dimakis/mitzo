// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { createTestStore } from '../../test-utils/createTestStore';
import { ChatView } from '../ChatView';
import { DesktopChatView } from '../DesktopChatView';
import {
  createChatDraft,
  getChatDraft,
  saveChatDraft,
  chatDraftStorageKey,
} from '../../lib/chat-drafts';
import { localInventoryFixture } from '../../test-utils/local-inventory-fixture';
import { apiFetch } from '../../lib/api-fetch';
import { launchDraftDelivery, reviewedBriefingLaunch } from '../../lib/launch-draft-delivery';
import {
  buildLocalFirstCommand,
  ExplicitLocalInventorySchema,
} from '../../lib/explicit-local-chat';
import { createChatRuntimeSelection } from '../../lib/chat-runtime-selection';
import { composeOrdinaryRuntimeCapabilities } from '../../../../server/ordinary-runtime-capability-composition';

function openAgentSettings() {
  const settings = screen.getByRole('button', { name: /^Workspace controls,/ });
  if (settings.getAttribute('aria-expanded') !== 'true') fireEvent.click(settings);
}

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
  const select = vi.fn(store.getState().selectLocalCommandDraft);
  const owned = vi.fn((_request: unknown, _opts?: unknown) => true);
  store.setState({
    sendMessage: send,
    sendLocalFirstCommand: owned,
    selectLocalCommandDraft: select,
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
  return { store, send, owned, select, ...view };
}

function briefingFixture(reviewed = true) {
  const draft = createChatDraft();
  const source = {
    kind: 'briefing' as const,
    date: '2026-10-09',
    revision: 'a'.repeat(64),
    content: 'Original report',
  };
  const base = localInventoryFixture();
  const inventory = ExplicitLocalInventorySchema.parse({
    ...base,
    ...composeOrdinaryRuntimeCapabilities([{ ...base, capabilityRevision: 'selected-route-r1' }]),
    defaultLocalRepository: true,
  });
  const account = { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' };
  draft.text = 'Discuss original report';
  draft.settings.selection = account;
  draft.settings.launch = {
    prompt: draft.text,
    context: 'Morning briefing',
    briefing: source,
    accountSelection: account,
    sourceSnapshots: [source],
  };
  draft.settings.runtimeSelection = {
    ...createChatRuntimeSelection(),
    account,
    accountReference: reviewed ? inventory.accounts[0].account : null,
    execution: { location: reviewed ? 'local' : 'openshell', targetId: reviewed ? 'mac' : null },
    capabilityRevision: reviewed ? inventory.capabilityRevision : null,
    agentProfile: { profileId: 'agent', revision: 1 },
  };
  saveChatDraft(draft);
  return { draft, source, inventory };
}
for (const Page of [ChatView, DesktopChatView]) {
  it(`${Page.name} sends a reviewed saved briefing through the owned first command with pinned source/account/model`, async () => {
    const { draft, source, inventory } = briefingFixture();
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      Response.json(String(url).includes('/capabilities') ? inventory : []),
    );
    const view = mount(Page, `/chat?draft=${draft.id}`);
    view.owned.mockImplementation((request, opts) =>
      launchDraftDelivery.prepare(
        (opts as { draftId: string }).draftId,
        request as Record<string, unknown>,
      ),
    );
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        expect.stringContaining('/capabilities'),
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send launch prompt' })).toHaveProperty(
        'disabled',
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send launch prompt' }));
    await waitFor(() => expect(view.owned).toHaveBeenCalledTimes(1));
    expect(view.owned.mock.results[0].value).toBe(true);
    expect(launchDraftDelivery.pending(draft.id)).toBe(true);
    expect(getChatDraft(draft.id)?.settings.launch?.reviewedRoute).toMatchObject({
      inventoryRevision: inventory.capabilityRevision,
      capabilityRevision: 'selected-route-r1',
      targetId: 'mac',
      account: inventory.accounts[0].account,
    });
    expect(view.send).not.toHaveBeenCalled();
    expect(view.owned.mock.calls[0][0]).toMatchObject({
      runtime: { account: inventory.accounts[0].account, targetId: 'mac' },
      capabilityRevision: 'selected-route-r1',
      selection: { model: 'luna-fixture' },
      payload: { text: draft.text, sourceSnapshots: [source] },
    });
    expect(view.store.getState().messages.sessionContext).toBe('Morning briefing');
    expect(getChatDraft(draft.id)?.settings.launch).toMatchObject({
      briefing: { date: source.date, revision: source.revision },
      sourceSnapshots: [source],
    });
  });
  it.each([
    'missing-target',
    'entry-disabled',
    'changed-account',
    'changed-capability',
    'changed-agent',
  ])(`${Page.name} retains a briefing and never falls back when %s`, async (scenario) => {
    const { draft, inventory } = briefingFixture();
    if (scenario === 'missing-target') draft.settings.runtimeSelection!.execution.targetId = null;
    if (scenario === 'changed-account') inventory.accounts[0].account.profileRevision = 'changed';
    if (scenario === 'changed-capability') inventory.capabilityRevision = 'changed';
    if (scenario === 'changed-agent') inventory.agentProfiles[0].revision = 2;
    saveChatDraft(draft);
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      String(url).includes('/capabilities')
        ? scenario === 'entry-disabled'
          ? Response.json({ code: 'entry_disabled' }, { status: 503 })
          : Response.json(inventory)
        : Response.json([]),
    );
    const view = mount(Page, `/chat?draft=${draft.id}`);
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        expect.stringContaining('/capabilities'),
        expect.anything(),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send launch prompt' }));
    expect(view.owned).not.toHaveBeenCalled();
    expect(view.send).not.toHaveBeenCalled();
    expect(getChatDraft(draft.id)).not.toBeNull();
  });
}

for (const Page of [ChatView, DesktopChatView]) {
  it(`${Page.name} confirms the same current public account and selects execution without exposing another pinned model/account`, async () => {
    const { draft, inventory } = briefingFixture(false);
    inventory.accounts.push({
      ...inventory.accounts[0],
      account: { ...inventory.accounts[0].account, accountId: 'other' },
      label: 'Other account',
    });
    inventory.accounts[0].models.push({
      ...inventory.accounts[0].models[0],
      id: 'other-model',
      label: 'Other model',
    });
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      Response.json(String(url).includes('/capabilities') ? inventory : []),
    );
    const view = mount(Page, `/chat?draft=${draft.id}`);
    openAgentSettings();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Account, Confirm account/ })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: /^Account, Confirm account/ }));
    expect(screen.queryByRole('button', { name: 'Other account' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Personal ChatGPT' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat settings' }));
    fireEvent.click(screen.getByRole('button', { name: /^Model,/ }));
    expect(screen.queryByRole('button', { name: 'Other model' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat settings' }));
    fireEvent.click(screen.getByRole('button', { name: /^Run on,/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Local Mac' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat settings' }));
    fireEvent.click(screen.getByRole('button', { name: /^Thinking,/ }));
    fireEvent.click(screen.getByRole('button', { name: 'high' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(getChatDraft(draft.id)?.settings.runtimeSelection).toMatchObject({
        accountReference: inventory.accounts[0].account,
        execution: { location: 'local', targetId: 'mac' },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send launch prompt' }));
    expect(view.owned).toHaveBeenCalledTimes(1);
    expect(view.send).not.toHaveBeenCalled();
    expect(view.owned.mock.calls[0][0]).toMatchObject({ selection: { thinking: 'high' } });
  });
  it.each(['raw-extra-tools', 'query-extra-tools', 'generic-uncertain'])(
    `${Page.name} retains %s without autosave stripping or owned/generic conversion`,
    async (kind) => {
      const { draft, inventory } = briefingFixture();
      if (kind === 'raw-extra-tools') {
        const raw = JSON.parse(localStorage.getItem(chatDraftStorageKey(draft.id))!);
        raw.settings.launch.extraTools = [];
        localStorage.setItem(chatDraftStorageKey(draft.id), JSON.stringify(raw));
      } else if (kind === 'generic-uncertain') {
        launchDraftDelivery.prepare(draft.id, {
          clientMsgId: 'generic-still-pending',
          prompt: draft.text,
          accountId: 'personal',
          model: 'luna-fixture',
          sourceSnapshots: draft.settings.launch!.sourceSnapshots,
        });
        launchDraftDelivery.settle('generic-still-pending', 'uncertain');
      }
      const raw = localStorage.getItem(chatDraftStorageKey(draft.id));
      vi.mocked(apiFetch).mockImplementation(async (url) =>
        Response.json(String(url).includes('/capabilities') ? inventory : []),
      );
      const view = mount(
        Page,
        `/chat?draft=${draft.id}${kind === 'query-extra-tools' ? '&extraTools=' : ''}`,
      );
      openAgentSettings();
      fireEvent.click(screen.getByRole('button', { name: 'Send launch prompt' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(view.owned).not.toHaveBeenCalled();
      expect(view.send).not.toHaveBeenCalled();
      expect(localStorage.getItem(chatDraftStorageKey(draft.id))).toBe(raw);
    },
  );
}

for (const Page of [ChatView, DesktopChatView]) {
  it(`${Page.name} explicitly restores the original owned draft outbox scope even while its launch receipt is pending`, async () => {
    const { draft, inventory } = briefingFixture();
    const command = buildLocalFirstCommand(draft.settings.runtimeSelection!, inventory, {
      clientMsgId: 'pending-owned-ui',
      mode: 'agent',
      text: draft.text,
      sourceSnapshots: draft.settings.launch!.sourceSnapshots,
    });
    expect(command).not.toBeNull();
    draft.settings.launch = reviewedBriefingLaunch(
      draft,
      draft.settings.runtimeSelection!,
      inventory,
    );
    saveChatDraft(draft);
    expect(launchDraftDelivery.prepare(draft.id, command!)).toBe(true);
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      Response.json(String(url).includes('/capabilities') ? inventory : []),
    );
    const view = mount(Page, `/chat?draft=${draft.id}`);
    await waitFor(() => expect(view.select).toHaveBeenCalledWith(draft.id));
    expect(view.owned).not.toHaveBeenCalled();
    expect(view.send).not.toHaveBeenCalled();
  });
}

for (const Page of [ChatView, DesktopChatView]) {
  it(`${Page.name} keeps typed launch follow-up text under its existing owner while an owned receipt is pending`, async () => {
    const { draft, inventory } = briefingFixture();
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      Response.json(String(url).includes('/capabilities') ? inventory : []),
    );
    const view = mount(Page, `/chat?draft=${draft.id}`);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send launch prompt' })).toHaveProperty(
        'disabled',
        false,
      ),
    );
    view.owned.mockImplementation((request, opts) =>
      launchDraftDelivery.prepare(
        (opts as { draftId: string }).draftId,
        request as Record<string, unknown>,
      ),
    );
    const input = screen.getByRole('textbox', { name: 'Message Mitzo' });
    fireEvent.change(input, { target: { value: 'Keep my independent unsent follow-up' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send launch prompt' }));
    await waitFor(() => expect(view.owned).toHaveBeenCalledTimes(1));
    expect(input).toHaveProperty('value', 'Keep my independent unsent follow-up');
    view.unmount();
    mount(Page, `/chat?draft=${draft.id}`);
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Message Mitzo' })).toHaveProperty(
        'value',
        'Keep my independent unsent follow-up',
      ),
    );
    expect(screen.getByRole('button', { name: 'Send launch prompt' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(getChatDraft(draft.id)?.settings.launch?.prompt).toBe(draft.text);
    expect(view.send).not.toHaveBeenCalled();
  });
}
