// @vitest-environment node-compatible-dom
import { afterEach, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MitzoStoreProvider, useMitzoStore } from '@mitzo/client/hooks';
import { ChatInput } from '../../../frontend/src/components/ChatInput';
import { chatStorage } from '../../../frontend/src/lib/large-chat-storage';
import { createReviewedOutboxStorage } from '../../../frontend/src/lib/reviewed-outbox-storage';
import { composerDraftRevisionKey } from '../../../frontend/src/lib/composer-draft-proof';
import { sha256Hex } from '../../../frontend/src/lib/browser-crypto';
import { preparedRepositoryDeliveryFlow } from '../../../server/__tests__/fixtures/prepared-repository-delivery-flow.js';
import { preparedRepositoryBrowser } from '../../../server/__tests__/fixtures/prepared-repository-browser.js';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ChatView } from '../../../frontend/src/pages/ChatView';
import { apiFetch } from '../../../frontend/src/lib/api-fetch';
import { localInventoryFixture } from '../../../frontend/src/test-utils/local-inventory-fixture';

vi.mock('../../../packages/client/src/sse-connection.js', async () => ({
  SseConnection: (await import('../../../server/__tests__/fixtures/prepared-repository-browser.js'))
    .PreparedRepositorySseConnection,
}));
vi.mock('../../../frontend/src/components/SlashPicker', () => ({ SlashPicker: () => null }));
vi.mock('../../../frontend/src/components/MicButton', () => ({ MicButton: () => null }));
vi.mock('../../../frontend/src/components/SessionResourcesDialog', () => ({
  SessionResourcesDialog: () => null,
}));
vi.mock('../../../frontend/src/lib/haptics', () => ({ impactMedium: vi.fn() }));
vi.mock('../../../frontend/src/lib/api-fetch', () => ({
  apiFetch: vi.fn(),
  getApiBaseUrl: () => '',
  AUTH_LOST_EVENT: 'auth-lost',
  AUTH_RESTORED_EVENT: 'auth-restored',
}));
vi.mock('../../../frontend/src/lib/quick-settings-context', async (original) => ({
  ...(await original<typeof import('../../../frontend/src/lib/quick-settings-context')>()),
  useQuickSettings: () => null,
}));
vi.mock('../../../frontend/src/components/SymposiumConversation', () => ({
  SymposiumConversation: ({ ordinaryComposer }: { ordinaryComposer: React.ReactNode }) => (
    <>{ordinaryComposer}</>
  ),
}));
vi.mock('../../../frontend/src/components/CommandCenter', () => ({ CommandCenter: () => null }));
vi.mock('../../../frontend/src/components/ScrollFab', () => ({ ScrollFab: () => null }));
vi.mock('../../../frontend/src/components/VoiceSettings', () => ({ VoiceSettings: () => null }));
vi.mock('../../../frontend/src/components/WebSearchConsent', () => ({
  WebSearchConsent: () => null,
}));
vi.mock('../../../frontend/src/components/ChatArea', () => ({
  ChatArea: ({ afterMessages }: { afterMessages?: React.ReactNode }) => <>{afterMessages}</>,
}));
vi.mock('../../../frontend/src/hooks/useProgress', () => ({
  useProgressByToolId: () => new Map(),
}));
vi.mock('../../../frontend/src/hooks/useVoice', () => ({
  useVoice: () => ({ available: false, stopSpeaking: vi.fn(), voices: [] }),
}));
vi.mock('../../../frontend/src/hooks/useBriefingChat', () => ({ useBriefingChat: () => ({}) }));
vi.mock('../../../frontend/src/lib/keyboard', () => ({ onKeyboardToggle: () => () => {} }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

it('refreshes genuinely retained pre-adoption metadata in the mounted ChatView before a new request reaches the real canonical router', async () => {
  const f = await preparedRepositoryDeliveryFlow();
  const runtimeBinding = f.f.events.getSessionRuntimeBinding(f.sessionId)!;
  if (runtimeBinding.version !== 2) throw Error('Fixture requires its actual version-2 runtime');
  const inventory: import('../../../frontend/src/lib/explicit-local-chat').ExplicitLocalInventory =
    localInventoryFixture();
  inventory.capabilityRevision = f.originalBody.capabilityRevision;
  inventory.accounts = [
    {
      account: f.originalBody.runtime.account,
      label: 'Offline selected account',
      models: [
        {
          id: f.originalBody.selection.model,
          label: 'Offline selected model',
          reasoningEfforts: ['low'],
        },
      ],
      modelDiscovery: { source: 'configured', stale: false },
    },
  ];
  inventory.targets = [
    {
      targetId: f.originalBody.runtime.targetId,
      targetRevision: runtimeBinding.execution.targetRevision,
      location: 'local',
      harness: 'codex',
      label: 'Offline selected Mac',
    },
  ];
  inventory.routes = [
    {
      ...inventory.routes[0],
      account: f.originalBody.runtime.account,
      targetId: f.originalBody.runtime.targetId,
    },
  ];
  inventory.agentProfiles = [f.f.agentProfile];
  let adopted = false,
    hold = false;
  const pending: Array<(response: Response) => void> = [];
  // Workspace/account/profile identities come from the real EventStore on each
  // side of actual adoption. This simulates the old response retained by an
  // already mounted browser, then its fresh public metadata projection.
  const metadata = () => ({
    ...(adopted ? f.f.events.getSession(f.sessionId)! : f.originalMetadata!),
    sessionId: f.sessionId,
    runtimeBinding,
    runtimeCommandScope: 'conversation',
    modelSelection: {
      model: f.originalBody.selection.model,
      reasoningEffort: f.originalBody.selection.thinking,
      models: inventory.accounts[0].models,
    },
  });
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const path = String(url);
    if (path.includes('/capabilities')) return Response.json(inventory);
    if (path.endsWith('/meta'))
      return hold ? new Promise((resolve) => pending.push(resolve)) : Response.json(metadata());
    if (path.endsWith('/symposium/status'))
      return Response.json({ sessionId: f.sessionId, config: null, seats: [] });
    return Response.json([]);
  });
  f.store.setState({
    modeChangeReady: true,
    connection: { status: 'connected', clientId: preparedRepositoryBrowser.id },
  });
  preparedRepositoryBrowser.listener({
    type: 'session_info',
    sessionId: f.sessionId,
    branch: f.adopted.featureBranch,
    cwd: f.originalMetadata!.cwd,
    worktree: false,
  });
  render(
    <MitzoStoreProvider value={f.store}>
      <MemoryRouter initialEntries={[`/chat/${f.sessionId}`]}>
        <Routes>
          <Route path="/chat/:sessionId" element={<ChatView />} />
        </Routes>
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  const input = await screen.findByLabelText('Message Mitzo');
  fireEvent.change(input, { target: { value: 'so is it not operational now?' } });
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  hold = true;
  adopted = true;
  const before = f.requests.filter((request) => !request.path.endsWith('/receipt')).length;
  const sameBranch = f.store.getState().messages.branch ?? 'same-task-branch';
  act(() =>
    preparedRepositoryBrowser.listener({
      type: 'session_info',
      sessionId: f.sessionId,
      cwd: f.adopted.directory,
      branch: sameBranch,
      worktree: false,
    }),
  );
  expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(input).toHaveProperty('value', 'so is it not operational now?');
  expect(f.requests.filter((request) => !request.path.endsWith('/receipt'))).toHaveLength(before);
  await waitFor(() => expect(pending.length).toBeGreaterThan(0));
  hold = false;
  await act(async () => {
    for (const resolve of pending) resolve(Response.json(metadata()));
  });
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(
    () =>
      expect(f.requests.filter((request) => !request.path.endsWith('/receipt'))).toHaveLength(
        before + 1,
      ),
    { timeout: 120000 },
  );
  const submitted = f.requests.filter((request) => !request.path.endsWith('/receipt')).at(-1)!;
  expect(submitted).toMatchObject({
    path: '/api/chat/local-codex/continue',
    status: 202,
    body: {
      sessionId: f.sessionId,
      repositoryWorkspaceId: f.adopted.id,
      selection: f.originalBody.selection,
      payload: { text: 'so is it not operational now?' },
    },
  });
  await act(() => f.complete(String(submitted.body.clientMsgId)));
  await waitFor(() => expect(input).toHaveProperty('value', ''));
  expect(f.f.events.getSession(f.sessionId)?.repositoryWorkspaceId).toBe(f.adopted.id);
}, 420000);

it('keeps the newer composer draft and sends repeated prompts after exact screenshot acceptance at quota, including lost-response reconnect', async () => {
  localStorage.clear();
  const realSet = Storage.prototype.setItem;
  let quota = Infinity;
  const used = () =>
    Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!).reduce(
      (sum, key) => sum + key.length + localStorage.getItem(key)!.length,
      0,
    );
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    const current = this.getItem(key);
    const next =
      used() - (current === null ? 0 : key.length + current.length) + key.length + value.length;
    if (this === localStorage && next > quota)
      throw new DOMException('Web Storage is full', 'QuotaExceededError');
    realSet.call(this, key, value);
  });
  const newerText = 'yep lets open the pr to fix it';
  const f = await preparedRepositoryDeliveryFlow({
    images: [
      {
        mediaType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf6kAAAAASUVORK5CYII=',
      },
    ],
    storage(seed) {
      const storage = createReviewedOutboxStorage(
        chatStorage,
        'https://mitzo.test/api/chat/local-codex/send',
        'local',
      );
      storage.getItem('queue');
      storage.setItem('queue', seed);
      chatStorage.setItem('original-composer', newerText);
      chatStorage.setItem(
        composerDraftRevisionKey('original-composer'),
        JSON.stringify({
          revisionToken: 'newer-unsent-revision',
          textSha256: sha256Hex(newerText),
          richDraftSignature: '',
        }),
      );
      return storage;
    },
  });
  let next = 0;
  function Composer() {
    const command = useMitzoStore((state) => state.localCommand);
    return (
      <ChatInput
        sessionId={f.sessionId}
        draftStorageKey="original-composer"
        running={false}
        guardedConversation
        onStop={() => {}}
        sendDisabledReason={
          command && command.state !== 'consumed' ? 'Delivery not confirmed.' : undefined
        }
        acceptedComposerDraft={command?.state === 'consumed' ? command.composerDraft : undefined}
        onSend={(text, _images, _context, onDelivery, _assigned, composerDraft) =>
          f.store.getState().sendLocalFirstCommand(
            {
              ...f.originalBody,
              sessionId: f.sessionId,
              repositoryWorkspaceId: f.adopted.id,
              clientMsgId: `composer-${++next}`,
              payload: { text },
            },
            { onDelivery, composerDraft },
          )
        }
      />
    );
  }
  render(
    React.createElement(MitzoStoreProvider, { value: f.store }, React.createElement(Composer)),
  );
  const input = screen.getByLabelText('Message Mitzo');
  expect(input).toHaveProperty('value', newerText);
  expect(screen.getByText('Delivery not confirmed.')).toBeTruthy();
  await chatStorage.flush();
  const newerRevision = chatStorage.getItem(composerDraftRevisionKey('original-composer'));
  quota = used();
  const nativeBefore = f.f.native.commands(f.sessionId, f.binding);
  act(() => f.store.getState().selectLocalCommandSession(f.sessionId));
  await waitFor(() =>
    expect(f.requests[0]).toMatchObject({
      path: '/api/chat/local-codex/send/receipt',
      body: f.originalBody,
      status: 202,
    }),
  );
  await waitFor(() => {
    expect(f.store.getState().localCommand?.state).toBe('consumed');
    expect(f.saved()).toEqual([]);
  });
  expect(f.f.native.commands(f.sessionId, f.binding)).toEqual(nativeBefore);
  expect(input).toHaveProperty('value', newerText);
  expect(chatStorage.getItem(composerDraftRevisionKey('original-composer'))).toBe(newerRevision);
  expect(screen.queryByText('Delivery not confirmed.')).toBeNull();
  expect(f.saved()).toEqual([]);
  for (const id of ['composer-1', 'composer-2', 'composer-3']) {
    if (id !== 'composer-1') fireEvent.change(input, { target: { value: `Explicit ${id}` } });
    if (id === 'composer-2') f.loseNextResponse();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(
      f.store.getState().localCommand?.request?.clientMsgId,
      f.store.getState().sendError ?? 'Composer did not enqueue this explicit prompt',
    ).toBe(id);
    await act(() => f.complete(id));
    if (id === 'composer-2') {
      await waitFor(() => expect(f.store.getState().localCommand?.state).toBe('uncertain'));
      expect(input).toHaveProperty('value', `Explicit ${id}`);
      await act(async () => {
        f.reconnect();
        await f.waitForReceipt(id);
      });
    }
    await waitFor(() => expect(input).toHaveProperty('value', ''));
    expect(f.saved()).toEqual([]);
    expect(
      f.requests.filter(
        (request) => request.body.clientMsgId === id && !request.path.endsWith('/receipt'),
      ),
    ).toHaveLength(1);
  }
}, 420000);
