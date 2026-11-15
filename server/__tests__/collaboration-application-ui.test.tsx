// @vitest-environment node-compatible-dom
import { afterAll, beforeAll, expect, it, onTestFailed, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createApplicationJourney } from './fixtures/symposium-application-journey.js';
import { recordApplicationMessagingRuntime } from './fixtures/symposium-recording-runtime.js';

const journey = createApplicationJourney();
let h: Awaited<ReturnType<typeof journey.getApplicationUiJourney>>;
let SharedConversationHost: typeof import('../../frontend/src/components/SharedConversation.js').SharedConversationHost;
let SharedConversationBody: typeof import('../../frontend/src/components/SharedConversation.js').SharedConversationBody;
// Cold application compilation and silent joining are setup, with their own
// bounded deadline. Keep all 27 real ordinary turns inside the interaction
// deadline, rather than charging setup twice on busy CI workers.
beforeAll(async () => {
  h = await journey.getApplicationUiJourney();
  ({ SharedConversationHost, SharedConversationBody } =
    await import('../../frontend/src/components/SharedConversation.js'));
}, 30000);
afterAll(() => journey.close());

// Production client, auth, UI, application, storage, dispatch and reply owners.
// Only external source/account/runtime declarations and native RPC are synthetic.
it('sends first and later selected prompts from the production shared composer after remount', async () => {
  // JSDOM supplies no scrolling implementation; browser geometry is checked separately.
  const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  (await import('../auth.js')).setAuthRevocationStore(h.events);
  const runtime = await recordApplicationMessagingRuntime(h.events);
  // JSDOM has no browser EventSource. Keep the real auth/EventBus owner while
  // replacing only its unrelated external broadcast connection, never chat RPC.
  vi.stubGlobal(
    'EventSource',
    class extends EventTarget {
      readyState = 0;
      onopen = null;
      onerror = null;
      constructor(url: string) {
        super();
        expect(new URL(url, 'http://offline.invalid').pathname).toBe('/api/events');
      }
      close() {
        this.readyState = 2;
      }
    },
  );
  const started = performance.now();
  let stage = 'restore_login';
  let historyTurnsCompleted = 0;
  onTestFailed(() => {
    console.error(
      'SYMPOSIUM_OFFLINE_UI_FAILURE',
      JSON.stringify({
        stage,
        historyTurnsCompleted,
        requestedTurns: runtime.requests.filter((request) => request.method === 'turn/start')
          .length,
        elapsedMs: Math.round(performance.now() - started),
      }),
    );
  });
  vi.stubGlobal('fetch', h.fetch);
  const auth = await import('../../frontend/src/lib/api-fetch.js');
  expect(await auth.restoreCookieAuthentication()).toBe(true);
  expect(auth.currentVerifiedAuthSessionId()).toBeTruthy();
  expect(await h.typedApi.collaborations.sourceSetup('existing-chat', h.clientId)).toMatchObject({
    state: 'selected',
  });
  const initial = await h.api.view(h.group);
  const source = initial.policies.find((p) => p.sessionId === 'existing-chat')!;
  await h.api.setPolicy(h.group, {
    requestId: crypto.randomUUID(),
    expectedMembershipRevision: initial.membershipRevision,
    expectedRevision: source.revision,
    sessionId: source.sessionId,
    readsFutureDiscussion: false,
    repliesByDefault: false,
  });
  const surface = () => (
    <MemoryRouter>
      <SharedConversationHost
        sourceConversationId="existing-chat"
        api={h.typedApi}
        clientId={h.clientId}
        authScope={auth.currentVerifiedAuthSessionId()}
        getVerifiedAuthScope={auth.currentVerifiedAuthSessionId}
      >
        <SharedConversationBody
          sourceConversationId="existing-chat"
          chat={{
            messages: [
              {
                messageId: 'ordinary-history',
                role: 'user',
                blocks: [
                  {
                    blockId: 'text',
                    blockType: 'text',
                    content: 'Original discussion remains available.',
                  },
                ],
              },
            ],
            current: null,
            running: false,
            permission: null,
            onPermissionRespond: () => {},
          }}
        >
          {null}
        </SharedConversationBody>
      </SharedConversationHost>
    </MemoryRouter>
  );
  let ui: ReturnType<typeof render> | undefined;
  try {
    ui = render(surface());
    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Choose who replies' })).toBeTruthy(),
      { timeout: 5000 },
    );
    expect(runtime.requests).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Choose who replies' }));
    // The historical source has no live send owner. Explicitly address only
    // the reviewer, preserving the new initial original-agent selection rule.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Current agent', exact: true }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Independent reviewer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done choosing replies' }));
    const input = screen.getByRole('textbox', { name: 'Message Mitzo' });
    fireEvent.change(input, {
      target: { value: 'Review the selected design from the shared composer.' },
    });
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    stage = 'first_composer_reply';
    await waitFor(
      async () => {
        const view = await h.api.view(h.group);
        expect(view.messages.some((m) => m.author !== 'operator')).toBe(true);
      },
      { timeout: 5000 },
    );
    await waitFor(() => expect(screen.getByText('Reviewed the selected design.')).toBeTruthy(), {
      timeout: 10000,
    });
    expect(screen.getByText('Original discussion remains available.')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy(), {
      timeout: 5000,
    });
    expect(
      (screen.getByRole('textbox', { name: 'Message Mitzo' }) as HTMLTextAreaElement).value,
    ).toBe('');
    expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
    const turn = runtime.requests.find((r) => r.method === 'turn/start')!;
    expect(JSON.stringify(turn.params)).toContain('Edited brief retained exactly');
    expect(JSON.stringify(turn.params)).toContain('Synthetic design requirement');
    expect(JSON.stringify(turn.params)).not.toContain('DO_NOT_LEAK');
    const view = await h.api.view(h.group);
    const reply = view.messages.find((m) => m.author !== 'operator')!;
    expect(reply.author).toEqual({ sessionId: h.joinedSessionId });
    expect(reply.replyToDeliveryId).toBeTruthy();
    ui.unmount();
    stage = 'remount_original_reply';
    ui = render(surface());
    await waitFor(() =>
      expect(screen.getAllByText('Reviewed the selected design.')).toHaveLength(1),
    );
    expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
    // A later explicit prompt must reuse the ordinary owner and retained
    // recipient intent after remount, without replaying the first delivery.
    await waitFor(() =>
      expect(
        h.events.getOrdinaryProviderTurnTerminal(h.joinedSessionId, reply.source!.commandId),
      ).toBe('completed'),
    );
    // Grow real acknowledged prompt/reply history beyond the display page.
    // Keep the production composer mounted: its readiness must survive paging,
    // and its next explicit send must still reach the ordinary native owner.
    await act(async () => {
      for (let i = 0; i < 25; i++) {
        stage = 'grow_acknowledged_history';
        const current = await h.api.view(h.group);
        const accepted = await h.api.send(h.group, {
          requestId: crypto.randomUUID(),
          expectedMembershipRevision: current.membershipRevision,
          expectedPolicySequence: current.policySequence,
          text: `Long discussion question ${i}`,
          responders: { kind: 'selected', sessionIds: [h.joinedSessionId] },
          snapshot: null,
        });
        await vi.waitFor(() =>
          expect(
            h.events.getOrdinaryProviderTurnTerminal(
              h.joinedSessionId,
              accepted.deliveries[0].commandId!,
            ),
          ).toBe('completed'),
        );
        historyTurnsCompleted++;
      }
    });
    expect((await h.api.view(h.group)).hasEarlierMessages).toBe(true);
    stage = 'final_composer_after_paging';
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Mitzo' }), {
      target: { value: 'Review a second question explicitly.' },
    });
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(
      async () => {
        const view = await h.api.view(h.group);
        const prompt = view.messages.find(
          (m) => m.text === 'Review a second question explicitly.',
        )!;
        expect(prompt).toBeTruthy();
        const delivery = prompt.deliveries.find((d) => d.purpose === 'reply')!;
        const finalReply = view.messages.find((m) => m.replyToDeliveryId === delivery.deliveryId)!;
        expect(finalReply).toMatchObject({
          text: 'Reviewed the selected design.',
          author: { sessionId: h.joinedSessionId },
          source: { commandId: delivery.commandId },
        });
        expect(
          document.querySelector(`[data-reply-source="${finalReply.projectionId}"]`)?.textContent,
        ).toContain('Reviewed the selected design.');
      },
      { timeout: 10000 },
    );
    const turns = runtime.requests.filter((r) => r.method === 'turn/start');
    expect(turns).toHaveLength(27);
    expect(JSON.stringify(turns[26].params)).toContain('Review a second question explicitly.');
    expect(JSON.stringify(turns[26].params)).not.toContain('Long discussion question 0');
    const after = await h.api.view(h.group);
    const answers = after.messages.filter((m) => m.author !== 'operator');
    expect(answers).toHaveLength(25);
    expect(new Set(answers.map((m) => m.source?.commandId)).size).toBe(25);
    expect(new Set(answers.map((m) => m.replyToDeliveryId)).size).toBe(25);
    expect(
      answers.every((m) => m.author !== 'operator' && m.author.sessionId === h.joinedSessionId),
    ).toBe(true);
  } finally {
    cleanup();
    (await import('../../frontend/src/lib/event-bus-singleton.js')).eventBus.disconnect();
    const { registry } = await import('../chat.js');
    const live = registry.findBySessionId(h.joinedSessionId);
    if (live) await act(async () => registry.abort(live.clientId));
    const { getRepositoryWorkspaces } = await import('../repository-workspace-runtime.js');
    await vi.waitFor(() => getRepositoryWorkspaces(true).closeIdle());
    runtime.restore();
    if (originalScrollTo)
      Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  }
  // This journey performs 27 real application turns, including paged history.
  // Allow their aggregate cost on shared CI workers; individual readiness/reply
  // waits above retain their existing deadlines and assertions.
}, 60000);
