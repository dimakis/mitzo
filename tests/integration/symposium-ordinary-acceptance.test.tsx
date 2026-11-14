// @vitest-environment node-compatible-dom
import React from 'react';
import { afterAll, beforeAll, expect, it, onTestFailed, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createMitzoStore } from '@mitzo/client';
import { CollaborationMessageInputSchema } from '@mitzo/protocol';
import { createApplicationJourney } from '../../server/__tests__/fixtures/symposium-application-journey.js';
import { recordApplicationMessagingRuntime } from '../../server/__tests__/fixtures/symposium-recording-runtime.js';
import { installDialogStub } from '../../frontend/src/components/__tests__/dialog-stub';
import { applicationEventSource } from '../support/application-event-source';
import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Keep the responsive pages, ordinary shared host, authenticated application,
// preparation, admission, stores and reply owners. Replace external RPC only.
const journey = createApplicationJourney();
let h: Awaited<ReturnType<typeof journey.getApplicationUiJourney>>;
let runtime: Awaited<ReturnType<typeof recordApplicationMessagingRuntime>>;
let transport: Awaited<ReturnType<typeof applicationEventSource>>;
beforeAll(async () => {
  console.info(
    'ORDINARY_ACCEPTANCE_SOURCE',
    JSON.stringify({
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      branch:
        execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() ||
        'detached HEAD',
      testSha256: createHash('sha256')
        .update(await readFile(new URL(import.meta.url)))
        .digest('hex'),
      node: process.version,
      build: 'Vitest source transpilation',
      route: '/chat/:sessionId',
      widths: [320, 390, 1280],
      renderer: 'JSDOM; no visual acceptance',
      externalExecution: 'deterministic RPC',
    }),
  );
  h = await journey.getApplicationUiJourney();
  (await import('../../server/auth.js')).setAuthRevocationStore(h.events);
  runtime = await recordApplicationMessagingRuntime(h.events);
  transport = await applicationEventSource(journey.state.app, journey.state.cookie);
  vi.stubGlobal('fetch', h.fetch);
  vi.stubGlobal('addEventListener', window.addEventListener.bind(window));
  vi.stubGlobal('removeEventListener', window.removeEventListener.bind(window));
  vi.stubGlobal('HTMLDialogElement', window.HTMLDialogElement);
  installDialogStub();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'EventSource',
    class extends EventTarget {
      readyState = 0;
      onopen = null;
      onerror = null;
      close() {}
    },
  );
  HTMLElement.prototype.scrollTo = () => {};
  HTMLElement.prototype.scrollIntoView = () => {};
  const auth = await import('../../frontend/src/lib/api-fetch');
  expect(await auth.restoreCookieAuthentication()).toBe(true);
}, 30000);
afterAll(async () => {
  cleanup();
  await transport?.close();
  const { registry } = await import('../../server/chat.js');
  for (const [clientId] of [...registry.entries(true)]) registry.abort(clientId);
  (await import('../../frontend/src/lib/event-bus-singleton')).eventBus.disconnect();
  await vi.waitFor(async () =>
    (await import('../../server/repository-workspace-runtime.js'))
      .getRepositoryWorkspaces(true)
      .closeIdle(),
  );
  runtime?.restore();
  await vi.waitFor(() => journey.close(), { timeout: 10000 });
});

async function mountOrdinary(width = 390, source = 'existing-chat', shared = true) {
  let currentWidth = width;
  const mediaQueries = new Map<
    string,
    { matches: boolean; listeners: Set<(event: { matches: boolean }) => void> }
  >();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => {
      let media = mediaQueries.get(query);
      if (!media) {
        media = {
          matches: query === '(min-width: 768px)' && currentWidth >= 768,
          listeners: new Set(),
        };
        mediaQueries.set(query, media);
      }
      const selectedMedia = media;
      return {
        get matches() {
          return selectedMedia.matches;
        },
        media: query,
        addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) =>
          selectedMedia.listeners.add(listener),
        removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) =>
          selectedMedia.listeners.delete(listener),
      };
    },
  });
  const { ResponsiveChatView } = await import('../../frontend/src/components/ResponsiveChatView');
  const { SessionList } = await import('../../frontend/src/pages/SessionList');
  const { MitzoStoreProvider } = await import('@mitzo/client/hooks');
  const history = await h.typedApi.getSessionMessages(source);
  const store = createMitzoStore({
    transport: { fetch: transport.fetch },
    sseConfig: {
      baseUrl: '',
      fetch: transport.fetch,
      createEventSource: transport.createEventSource,
    },
    wsConfig: {
      buildUrl: () => {
        throw Error('Unexpected socket: application HTTP owns this journey');
      },
      createWebSocket: () => {
        throw Error('Unexpected socket');
      },
    },
  });
  store.setState((state) => ({
    sessions: { ...state.sessions, active: source },
    messages: {
      ...state.messages,
      messages: history,
    },
  }));
  await vi.waitFor(() => expect(store.getState().connection.status).toBe('connected'));
  await store.getState().switchSession(source);
  const ui = render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter initialEntries={['/chat/' + source]}>
        <Routes>
          <Route path="/chat/:sessionId" element={<ResponsiveChatView />} />
          <Route path="/sessions" element={<SessionList />} />
        </Routes>
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  if (shared) await screen.findByRole('button', { name: 'Choose who replies' }, { timeout: 10000 });
  else await screen.findByRole('textbox', { name: 'Message Mitzo' }, { timeout: 10000 });
  return {
    ui,
    store,
    resize(nextWidth: number) {
      currentWidth = nextWidth;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: currentWidth });
      for (const [query, media] of mediaQueries) {
        const matches = query === '(min-width: 768px)' && currentWidth >= 768;
        if (matches === media.matches) continue;
        media.matches = matches;
        for (const listener of media.listeners) listener({ matches });
      }
      window.dispatchEvent(new Event('resize'));
    },
    close() {
      ui.unmount();
      store.getState().invalidateAuthentication();
    },
  };
}

it.each([320, 390, 1280])(
  'ordinary responsive composition at %ipx keeps one transcript/composer after silent joining',
  async (width) => {
    const mounted = await mountOrdinary(width);
    try {
      expect(runtime.requests.filter((row) => row.method === 'turn/start')).toHaveLength(0);
      expect(screen.getAllByRole('textbox', { name: 'Message Mitzo' })).toHaveLength(1);
      expect(screen.getAllByText('Synthetic design requirement')).toHaveLength(1);
      expect(mounted.ui.container.querySelectorAll('.chat-messages')).toHaveLength(1);
    } finally {
      mounted.close();
    }
  },
  30000,
);

it('retains the ordinary unsent draft while real fresh setup/review silently joins', async () => {
  let stage = 'ordinary_source_bootstrap';
  let diagnosticGroup = '';
  onTestFailed(async () => {
    console.error(
      'OFFLINE_ACCEPTANCE_STAGE',
      JSON.stringify({
        stage,
        nativeTurns: runtime.requests.filter((r) => r.method === 'turn/start').length,
        deliveries: diagnosticGroup
          ? (await h.api.view(diagnosticGroup)).messages
              .filter((m) => m.author === 'operator')
              .map((m) => ({ text: m.text, deliveries: m.deliveries }))
          : [],
        messagesPosted: h.fetch.mock.calls
          .filter(([url, init]) => url.endsWith('/messages') && init?.method === 'POST')
          .map(([, init]) => JSON.parse(String(init!.body))),
        input: screen.queryByRole('textbox', { name: 'Message Mitzo' })?.outerHTML,
        composer: screen
          .queryByRole('textbox', { name: 'Message Mitzo' })
          ?.closest('.chat-input-wrapper')?.textContent,
        sourceEvents: transport.receipts.slice(-30),
      }),
    );
    const lines = (await readFile(journey.state.root! + '/app.log', 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    for (const row of lines.filter(
      (row) => row.code === 'collaboration_recipient_readiness_failed',
    ))
      console.error(
        'OFFLINE_READINESS_DIAGNOSTIC',
        JSON.stringify({
          code: row.code,
          stage: row.stage,
          collaborationId: row.collaborationId,
          sessionId: row.sessionId,
          error: row.err,
        }),
      );
  });
  // Bootstrap a real admitted ordinary owner through the existing application;
  // the historical source-only fixture has no owning admission and cannot type.
  const bootstrap = await mountOrdinary();
  // index.ts normally creates this physical task root; the fixture mounts app.ts.
  await mkdir(journey.state.root! + '/.claude/repository-tasks', { recursive: true });
  const { ordinaryRepositoryRuntimeInventory } =
    await import('../../server/ordinary-local-codex-entry.js');
  const inventory = ordinaryRepositoryRuntimeInventory('local', 'codex').result;
  const route = inventory.routes.find((r) => r.account.accountId === 'offline-personal')!;
  const preview = await h.fetch('/api/repository-workspaces/preview', {
    method: 'POST',
    body: JSON.stringify({
      accountId: route.account.accountId,
      model: 'fixture-model',
      connectionId: journey.state.connections!.connectionId,
      repository: 'example/acceptance',
      ordinaryRuntime: {
        runOn: 'local',
        runtime: { account: route.account, harness: 'codex', targetId: route.targetId },
      },
    }),
  });
  expect(preview.status).toBe(200);
  const workspace = await preview.json();
  const prepared = await h.fetch(`/api/repository-workspaces/${workspace.id}/prepare`, {
    method: 'POST',
    body: JSON.stringify({ accountId: route.account.accountId, model: 'fixture-model' }),
  });
  expect(prepared.status).toBe(200);
  const commandId = crypto.randomUUID();
  const seeded = await transport.fetch('/api/chat/local-codex/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Connection-ID': bootstrap.store.getState().connection.clientId!,
    },
    body: JSON.stringify({
      runOn: 'local',
      capabilityRevision: inventory.capabilityRevision,
      runtime: {
        account: route.account,
        harness: 'codex',
        targetId: route.targetId,
        mode: 'agent',
      },
      selection: {
        version: 1,
        model: 'fixture-model',
        thinking: 'low',
        agent: { kind: 'builtin', profileId: 'default-mitzo', revision: 1 },
        context: { source: 'none', revision: null },
        permission: { mode: 'agent', revision: 0 },
      },
      repositoryWorkspaceId: workspace.id,
      clientMsgId: commandId,
      payload: { text: 'Establish the independent ordinary source history.' },
    }),
  });
  const receipt = await seeded.json();
  expect(seeded.status, JSON.stringify(receipt)).toBe(202);
  const source: string = receipt.sessionId;
  await vi.waitFor(() =>
    expect(h.events.getOrdinaryProviderTurnTerminal(source, commandId)).toBe('completed'),
  );
  bootstrap.close();
  expect(await h.typedApi.collaborations.sourceSetup(source, h.clientId)).toMatchObject({
    state: 'unstarted',
  });
  let mounted = await mountOrdinary(390, source, false);
  try {
    stage = 'fresh_setup_review_join';
    await waitFor(() =>
      expect(
        (screen.getByRole('textbox', { name: 'Message Mitzo' }) as HTMLTextAreaElement).disabled,
      ).toBe(false),
    );
    const original = screen.getByRole('textbox', { name: 'Message Mitzo' });
    fireEvent.change(original, { target: { value: 'Original unsent ordinary draft' } });
    fireEvent.click(await screen.findByRole('button', { name: /^Agents/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add agent', exact: true }));
    const dialog = screen.getByRole('dialog', { name: 'Add agent' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name in this chat' }), {
      target: { value: 'AcceptanceReviewer' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Purpose' }), {
      target: { value: 'Review the original conversation' },
    });
    fireEvent.click(await within(dialog).findByRole('button', { name: /^Agent,/ }));
    const reviewer = await within(dialog).findByRole('button', { name: /^Reviewer ·/ });
    await waitFor(() => expect((reviewer as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(reviewer);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Thinking,/ }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'low' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Where it runs,/ }));
    await userEvent
      .setup({ document: window.document })
      .click(within(dialog).getByRole('radio', { name: 'Mac host' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add repository' }));
    const repos = await within(dialog).findByRole('combobox', { name: 'Local repository' });
    const option = await within(repos).findByRole('option', { name: 'external-github-source' });
    fireEvent.change(repos, { target: { value: (option as HTMLOptionElement).value } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use repository' }));
    await within(dialog).findByText(
      'Ready. The worktree starts from latest upstream main.',
      {},
      { timeout: 10000 },
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    const review = within(dialog).getByRole('button', { name: 'Review joining brief' });
    await waitFor(() =>
      expect((review as HTMLButtonElement).disabled, dialog.textContent ?? '').toBe(false),
    );
    fireEvent.click(review);
    const before = await screen.findByRole('dialog', { name: 'Before joining' });
    const brief = await within(before).findByRole('textbox', { name: /Joining brief/ });
    fireEvent.change(brief, { target: { value: 'Acceptance: exact edited brief retained.' } });
    const join = within(before).getByRole('button', { name: 'Join conversation', exact: true });
    await waitFor(() => expect((join as HTMLButtonElement).disabled).toBe(false));
    expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
    fireEvent.click(join);
    let group = '';
    let recipient = '';
    await waitFor(
      async () => {
        const setup = await h.typedApi.collaborations.sourceSetup(source, h.clientId);
        expect(setup.state).toBe('selected');
        if (setup.state !== 'selected') throw Error('Ordinary association not retained');
        const view = await h.api.view(setup.collaboration.collaborationId);
        const participant = view.joinedParticipants.find((p) => p.name === 'AcceptanceReviewer');
        expect(participant).toBeTruthy();
        group = setup.collaboration.collaborationId;
        diagnosticGroup = group;
        recipient = participant!.sessionId;
      },
      { timeout: 10000 },
    );
    fireEvent.keyDown(before, { key: 'Escape' });
    expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
    const currentInput = screen.getByRole('textbox', { name: 'Message Mitzo' });
    expect.soft(currentInput).toBe(original);
    expect.soft((currentInput as HTMLTextAreaElement).value).toBe('Original unsent ordinary draft');
    expect.soft(mounted.ui.container.querySelectorAll('.chat-messages')).toHaveLength(1);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Choose who replies' }, { timeout: 10000 }),
    );
    const choices = screen.getByRole('group', { name: 'Who replies to this prompt' });
    for (const checkbox of within(choices).getAllByRole('checkbox')) {
      const wanted =
        checkbox.getAttribute('aria-label') === 'AcceptanceReviewer' ||
        checkbox.closest('label')?.textContent?.includes('AcceptanceReviewer');
      if ((checkbox as HTMLInputElement).checked !== !!wanted) fireEvent.click(checkbox);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Done choosing replies' }));
    runtime.holdTurn(2);
    stage = 'first_explicit_streamed_reply';
    fireEvent.change(currentInput, {
      target: { value: 'First explicit accepted review from ordinary chat.' },
    });
    const send = () => screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement;
    await waitFor(() => expect(send().disabled).toBe(false));
    fireEvent.click(send());
    await waitFor(() =>
      expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(2),
    );
    expect(
      JSON.stringify(runtime.requests.filter((r) => r.method === 'turn/start')[1].params),
    ).toContain('Acceptance: exact edited brief retained.');
    expect(
      JSON.stringify(runtime.requests.filter((r) => r.method === 'turn/start')[1].params),
    ).not.toContain('DO_NOT_LEAK');
    await waitFor(() => runtime.streamTurn(2, 'Acceptance streamed reply'));
    await screen.findByText('Acceptance streamed reply', {}, { timeout: 10000 });
    expect(screen.getByLabelText('Message details for AcceptanceReviewer')).toBeTruthy();
    await act(async () => runtime.finishTurn(2, 'completed'));
    await waitFor(async () => {
      const view = await h.api.view(group);
      const answer = view.messages.find((m) => m.author !== 'operator')!;
      expect(answer.author).toEqual({ sessionId: recipient });
      expect(answer.source?.conversationId).toBe(recipient);
      expect(answer.source?.commandId).toBeTruthy();
      expect(view.messages.filter((m) => m.author !== 'operator')).toHaveLength(1);
    });
    await waitFor(
      () => {
        expect(screen.getAllByText('Acceptance streamed reply')).toHaveLength(1);
        expect(
          screen.getByText('Acceptance streamed reply').closest('.msg-turn--streaming'),
        ).toBeNull();
      },
      { timeout: 10000 },
    );
    expect.soft(mounted.ui.container.querySelectorAll('.chat-messages')).toHaveLength(1);
    const call = h.fetch.mock.calls.find(
      ([url, init]) =>
        url.endsWith('/messages') &&
        init?.method === 'POST' &&
        String(init.body).includes('First explicit accepted review'),
    )!;
    expect(call).toBeTruthy();
    const input = CollaborationMessageInputSchema.parse(JSON.parse(String(call[1]!.body)));
    await h.api.send(group, input);
    await h.api.send(group, input);
    expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(2);
    await mounted.store.getState().refreshSessions();
    expect(
      mounted.store
        .getState()
        .sessions.list!.filter((s) => [source, recipient].includes(s.id))
        .map((s) => s.id),
    ).toEqual([source]);
    fireEvent.click(screen.getByRole('link', { name: 'Back to chats' }));
    await waitFor(
      () =>
        expect(mounted.ui.container.querySelectorAll(`[data-motion-key="${source}"]`)).toHaveLength(
          1,
        ),
      { timeout: 10000 },
    );
    expect(mounted.ui.container.querySelectorAll(`[data-motion-key="${recipient}"]`)).toHaveLength(
      0,
    );
    fireEvent.click(
      mounted.ui.container.querySelector(`[data-motion-key="${source}"] .session-item`)!,
    );
    await screen.findByRole('button', { name: 'Choose who replies' }, { timeout: 10000 });
    expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(2);
    const retainedInput = screen.getByRole('textbox', {
      name: 'Message Mitzo',
    }) as HTMLTextAreaElement;
    await waitFor(() => expect(retainedInput.value).toBe(''), { timeout: 10000 });
    fireEvent.change(retainedInput, {
      target: { value: 'Draft while changing responsive owners' },
    });
    retainedInput.focus();
    retainedInput.setSelectionRange(3, 10);
    stage = 'responsive_owner_transition';
    for (const width of [1280, 320, 390]) {
      act(() => mounted.resize(width));
      expect.soft(screen.getByRole('textbox', { name: 'Message Mitzo' })).toBe(retainedInput);
      await waitFor(
        () => expect(screen.getByRole('textbox', { name: 'Message Mitzo' })).toBe(retainedInput),
        { timeout: 5000 },
      );
      expect(retainedInput.value).toBe('Draft while changing responsive owners');
      expect(document.activeElement).toBe(retainedInput);
      expect([retainedInput.selectionStart, retainedInput.selectionEnd]).toEqual([3, 10]);
      expect(mounted.ui.container.querySelectorAll('.chat-messages')).toHaveLength(1);
      expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(2);
    }
    await waitFor(
      () =>
        expect(
          (screen.getByRole('button', { name: 'Choose who replies' }) as HTMLButtonElement)
            .disabled,
        ).toBe(false),
      { timeout: 10000 },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose who replies' }));
    fireEvent.click(screen.getByRole('button', { name: 'All agents', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Done choosing replies' }));
    runtime.holdTurn(3);
    stage = 'concurrent_source_fanout';
    runtime.holdTurn(4);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Mitzo' }), {
      target: { value: 'Concurrent ordinary responders with partial failure.' },
    });
    await waitFor(
      () => expect(send().disabled, mounted.ui.container.textContent ?? '').toBe(false),
      { timeout: 5000 },
    );
    await userEvent.click(send());
    await waitFor(
      () => expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(4),
      { timeout: 10000 },
    );
    // Native ordinary activity is command-scoped. The legacy messages.running
    // flag is not the authoritative native busy state.
    const acceptedFanout = (await h.api.view(group)).messages.find(
      (m) => m.text === 'Concurrent ordinary responders with partial failure.',
    )!;
    const sourceCommand = acceptedFanout.deliveries.find((d) => d.sessionId === source)!.commandId!;
    expect(sourceCommand).toBeTruthy();
    const activeTurns = runtime.requests.filter((r) => r.method === 'turn/start');
    const sourceTurn =
      activeTurns.findIndex(
        (r, i) => i >= 2 && r.params.threadId === activeTurns[0].params.threadId,
      ) + 1;
    const reviewerTurn =
      activeTurns.findIndex(
        (r, i) => i >= 2 && r.params.threadId === activeTurns[1].params.threadId,
      ) + 1;
    expect([sourceTurn, reviewerTurn].sort()).toEqual([3, 4]);
    await waitFor(() => runtime.streamTurn(sourceTurn, 'Live original ordinary source activity'));
    await screen.findByText('Live original ordinary source activity', {}, { timeout: 10000 });
    expect.soft(screen.queryByRole('button', { name: 'Choose who replies' })).not.toBeNull();
    const busyInput = screen.getByRole('textbox', { name: 'Message Mitzo' });
    fireEvent.change(busyInput, {
      target: { value: 'Draft retained during concurrent source work' },
    });
    busyInput.focus();
    await waitFor(() => runtime.streamTurn(reviewerTurn, 'Partial reviewer output'));
    await act(async () => {
      runtime.finishTurn(sourceTurn, 'completed');
      runtime.finishTurn(reviewerTurn, 'failed', 'context');
    });
    await waitFor(
      async () => {
        const view = await h.api.view(group);
        const fanout = view.messages.find(
          (m) => m.text === 'Concurrent ordinary responders with partial failure.',
        )!;
        expect(fanout.deliveries.filter((d) => d.outcome === 'completed')).toHaveLength(1);
        expect(fanout.deliveries.filter((d) => d.outcome === 'failed')).toHaveLength(1);
      },
      { timeout: 10000 },
    );
    await waitFor(
      () => expect(screen.getAllByText('Live original ordinary source activity')).toHaveLength(1),
      { timeout: 10000 },
    );
    expect.soft(screen.getByRole('textbox', { name: 'Message Mitzo' })).toBe(busyInput);
    expect
      .soft((screen.getByRole('textbox', { name: 'Message Mitzo' }) as HTMLTextAreaElement).value)
      .toBe('Draft retained during concurrent source work');
    const fanout = (await h.api.view(group)).messages.find(
      (m) => m.text === 'Concurrent ordinary responders with partial failure.',
    )!;
    const failed = fanout.deliveries.find((d) => d.outcome === 'failed')!.sessionId;
    stage = 'selected_failed_recipient_retry';
    // Retry only the failed participant with a new explicit request.
    const next = await h.api.view(group);
    await h.api.send(group, {
      requestId: crypto.randomUUID(),
      expectedMembershipRevision: next.membershipRevision,
      expectedPolicySequence: next.policySequence,
      text: 'Retry only the failed participant.',
      responders: { kind: 'selected', sessionIds: [failed] },
      snapshot: null,
    });
    await waitFor(() =>
      expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(5),
    );
    const turns = runtime.requests.filter((r) => r.method === 'turn/start');
    expect(turns[4].params.threadId).toBe(turns[reviewerTurn - 1].params.threadId);
    expect(turns[4].params.threadId).not.toBe(turns[sourceTurn - 1].params.threadId);
    await waitFor(async () =>
      expect(
        (await h.api.view(group)).messages.some(
          (m) =>
            m.text === 'Retry only the failed participant.' &&
            m.deliveries.some((d) => d.outcome === 'completed'),
        ),
      ).toBe(true),
    );
    stage = 'long_history';
    // Grow acknowledged history beyond the shared page while the real
    // responsive ordinary composition and original draft remain mounted.
    await act(async () => {
      for (let index = 0; index < 25; index++) {
        const before = await h.api.view(group);
        const accepted = await h.api.send(group, {
          requestId: crypto.randomUUID(),
          expectedMembershipRevision: before.membershipRevision,
          expectedPolicySequence: before.policySequence,
          text: `Acceptance long-history turn ${index}`,
          responders: { kind: 'selected', sessionIds: [failed] },
          snapshot: null,
        });
        await vi.waitFor(() =>
          expect(
            h.events.getOrdinaryProviderTurnTerminal(failed, accepted.deliveries[0].commandId!),
          ).toBe('completed'),
        );
      }
    });
    expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(30);
    expect((await h.api.view(group)).hasEarlierMessages).toBe(true);
    await screen.findByText(
      'Earlier messages are outside this retained page.',
      {},
      { timeout: 10000 },
    );
    expect(mounted.ui.container.querySelectorAll('.chat-messages')).toHaveLength(1);
    expect(screen.getAllByRole('textbox', { name: 'Message Mitzo' })).toHaveLength(1);
    await waitFor(
      () =>
        expect(
          (screen.getByRole('button', { name: 'Choose who replies' }) as HTMLButtonElement)
            .disabled,
        ).toBe(false),
      { timeout: 10000 },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose who replies' }));
    const selection = screen.getByRole('group', { name: 'Who replies to this prompt' });
    const failedName = failed === source ? 'Current agent' : 'AcceptanceReviewer';
    for (const checkbox of within(selection).getAllByRole('checkbox')) {
      const wanted = checkbox.closest('label')?.textContent?.trim() === failedName;
      if ((checkbox as HTMLInputElement).checked !== !!wanted) fireEvent.click(checkbox);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Done choosing replies' }));
    let loseSend = true;
    stage = 'lost_send_and_stop_response';
    let loseStop = true;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const response = await h.fetch(url, init);
      if (
        response.ok &&
        init?.method === 'POST' &&
        String(init.body).includes('Retain original operation through lost response and Stop.')
      ) {
        if (loseSend && url.endsWith('/messages')) {
          loseSend = false;
          throw Error('Offline committed send response lost');
        }
        if (loseStop && url.endsWith('/messages/stop')) {
          loseStop = false;
          throw Error('Offline committed Stop response lost');
        }
      }
      return response;
    });
    runtime.holdTurn(31);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Mitzo' }), {
      target: { value: 'Retain original operation through lost response and Stop.' },
    });
    await waitFor(() => expect(send().disabled).toBe(false));
    fireEvent.click(send());
    await waitFor(
      () => expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(31),
      { timeout: 10000 },
    );
    await waitFor(() => expect(loseSend).toBe(false), { timeout: 10000 });
    // An exact background observation can consume the submitted prompt. A new
    // independent edit must survive that observation and all later recovery.
    const uncertainDraft = 'Independent draft while original request is uncertain';
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Mitzo' }), {
      target: { value: uncertainDraft },
    });
    // Recovery is inspectable through the actual current composer status owner.
    fireEvent.click(screen.getByRole('button', { name: 'Conversation status details' }));
    const statusDetails = await screen.findByRole('dialog', {
      name: 'Conversation status',
      exact: true,
    });
    fireEvent.click(
      await within(statusDetails).findByRole('button', { name: 'Check original request' }),
    );
    fireEvent.keyDown(statusDetails, { key: 'Escape' });
    expect(
      (screen.getByRole('textbox', { name: 'Message Mitzo' }) as HTMLTextAreaElement).value,
    ).toBe(uncertainDraft);
    expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(31);
    const lostCall = h.fetch.mock.calls.find(
      ([url, init]) =>
        url.endsWith('/messages') &&
        init?.method === 'POST' &&
        String(init.body).includes('Retain original operation through lost response and Stop.'),
    )!;
    const held = CollaborationMessageInputSchema.parse(JSON.parse(String(lostCall[1]!.body)));
    const observed = await h.api.observeSend(group, held);
    expect(observed.message?.messageId).toBe(
      h.events.collaborationConversation.getMessageForRequest(group, held)?.messageId,
    );
    expect(observed.message?.responders).toEqual([failed]);
    await h.api.send(group, held);
    expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(31);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop generation' }));
    await waitFor(() => expect(loseStop).toBe(false));
    await h.api.stopSend(group, held);
    expect(runtime.requests.filter((r) => r.method === 'turn/interrupt')).toHaveLength(1);
    await waitFor(() => runtime.streamTurn(31, 'Last observed partial text'));
    await act(async () => runtime.finishTurn(31, 'failed'));
    expect((await h.api.observeSend(group, held)).terminal).toBe(false);
    const previousConnection = mounted.store.getState().connection.clientId;
    stage = 'transport_reconnect_and_remount';
    await act(async () => mounted.store.getState().forceReconnect());
    await waitFor(() =>
      expect(mounted.store.getState().connection.clientId).not.toBe(previousConnection),
    );
    expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(31);
    mounted.close();
    mounted = await mountOrdinary(390, source);
    expect(
      (screen.getByRole('textbox', { name: 'Message Mitzo' }) as HTMLTextAreaElement).value,
    ).toBe(uncertainDraft);
    expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(31);
    await mounted.store.getState().refreshSessions();
    const listing = mounted.store.getState().sessions.list!;
    expect
      .soft(listing.filter((s) => [source, recipient].includes(s.id)).map((s) => s.id))
      .toEqual([source]);
    fireEvent.click(await screen.findByRole('button', { name: /^Agents/ }));
    expect(
      (await screen.findAllByText('AcceptanceReviewer', { exact: true })).length,
    ).toBeGreaterThan(0);
    mounted.close();
    await transport.close();
    stage = 'application_restart';
    const { registry } = await import('../../server/chat.js');
    for (const [clientId] of [...registry.entries(true)]) registry.abort(clientId);
    await vi.waitFor(async () =>
      (await import('../../server/repository-workspace-runtime.js'))
        .getRepositoryWorkspaces(true)
        .closeIdle(),
    );
    runtime.restore();
    // Registry abort/query finalization and in-flight HTTP reads settle through
    // their real owners before the idle application can release resources.
    await vi.waitFor(() => journey.restartApplication(), { timeout: 10000 });
    h = await journey.getApplicationUiJourney();
    (await import('../../server/auth.js')).setAuthRevocationStore(h.events);
    runtime = await recordApplicationMessagingRuntime(h.events);
    transport = await applicationEventSource(journey.state.app, journey.state.cookie);
    vi.stubGlobal('fetch', h.fetch);
    // Fresh frontend auth proof and a new SSE welcome, with the original DB,
    // request, command and participant identities; no warm provider is reused.
    expect(
      await (await import('../../frontend/src/lib/api-fetch')).restoreCookieAuthentication(),
    ).toBe(true);
    mounted = await mountOrdinary(390, source);
    expect(
      (screen.getByRole('textbox', { name: 'Message Mitzo' }) as HTMLTextAreaElement).value,
    ).toBe(uncertainDraft);
    const restarted = await h.api.observeSend(group, held);
    expect(restarted.message?.messageId).toBe(observed.message?.messageId);
    expect(restarted.message?.deliveries.map((d) => d.commandId)).toEqual(
      observed.message?.deliveries.map((d) => d.commandId),
    );
    expect(restarted.terminal).toBe(false);
    expect(runtime.requests).toHaveLength(0);
    await mounted.store.getState().refreshSessions();
    expect(
      mounted.store
        .getState()
        .sessions.list!.filter((s) => [source, recipient].includes(s.id))
        .map((s) => s.id),
    ).toEqual([source]);
    expect(
      (await h.api.view(group)).joinedParticipants.some(
        (p) => p.sessionId === recipient && p.name === 'AcceptanceReviewer',
      ),
    ).toBe(true);
    expect(h.events.getSession(recipient)?.isHidden).not.toBe(true);
    expect(mounted.ui.container.querySelectorAll('.chat-messages')).toHaveLength(1);
    expect(screen.getAllByRole('textbox', { name: 'Message Mitzo' })).toHaveLength(1);
    fireEvent.click(await screen.findByRole('button', { name: /^Agents/ }));
    expect(
      (await screen.findAllByText('AcceptanceReviewer', { exact: true })).length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Close Agents', exact: true }));
    fireEvent.click(screen.getByRole('link', { name: 'Back to chats' }));
    await waitFor(
      () =>
        expect(mounted.ui.container.querySelectorAll(`[data-motion-key="${source}"]`)).toHaveLength(
          1,
        ),
      { timeout: 10000 },
    );
    expect(mounted.ui.container.querySelectorAll(`[data-motion-key="${recipient}"]`)).toHaveLength(
      0,
    );
    expect(runtime.requests).toHaveLength(0);
    console.info(
      'ORDINARY_ACCEPTANCE_COMPLETE',
      JSON.stringify({
        stages: [
          'history_and_unsent_draft',
          'fresh_setup_review_silent_join',
          'explicit_attributed_stream',
          'exact_success_retry',
          'responsive_focus_selection',
          'concurrent_source_and_reviewer',
          'partial_failure_selected_retry',
          'long_history',
          'lost_committed_send_and_stop_response',
          'sse_reconnect',
          'remount',
          'application_owner_restart',
          'one_chats_conversation_inspectable_participants',
        ],
        beforeRestartNativeTurns: 31,
        afterRestartNativeRequests: runtime.requests.length,
        retainedUncertainRequest: held.requestId,
        retainedMessageId: restarted.message?.messageId,
        retainedCommandIds: restarted.message?.deliveries.map((d) => d.commandId),
        physicalDevice: 'unobserved',
      }),
    );
  } catch (error) {
    console.error(
      'OFFLINE_COMPOSER_DIAGNOSTIC',
      JSON.stringify({
        stage,
        input: (
          screen.queryByRole('textbox', { name: 'Message Mitzo' }) as HTMLTextAreaElement | null
        )?.value,
        send: screen.queryByRole('button', { name: 'Send message' })?.outerHTML,
        notices: [
          ...mounted.ui.container.querySelectorAll(
            '[role="alert"], .chat-status-message, .composer-responders',
          ),
        ].map((node) => node.textContent),
        lastFetches: h.fetch.mock.calls
          .slice(-12)
          .map(([url, init]) => ({ url, method: init?.method })),
      }),
    );
    throw error;
  } finally {
    mounted.close();
  }
}, 90000);
