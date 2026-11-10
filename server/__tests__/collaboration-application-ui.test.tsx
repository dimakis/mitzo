// @vitest-environment node-compatible-dom
import { afterAll, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createApplicationJourney } from './fixtures/symposium-application-journey.js';
import { recordApplicationMessagingRuntime } from './fixtures/symposium-recording-runtime.js';

const journey = createApplicationJourney();
afterAll(() => journey.close());

// Production client, auth, UI, application, storage, dispatch and reply owners.
// Only external source/account/runtime declarations and native RPC are synthetic.
it('sends first and later selected prompts from the production shared composer after remount', async () => {
  const h = await journey.getApplicationUiJourney();
  // JSDOM supplies no scrolling implementation; browser geometry is checked separately.
  const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  (await import('../auth.js')).setAuthRevocationStore(h.events);
  const runtime = await recordApplicationMessagingRuntime(h.events);
  vi.stubGlobal('fetch', h.fetch);
  const auth = await import('../../frontend/src/lib/api-fetch.js');
  expect(await auth.restoreCookieAuthentication()).toBe(true);
  expect(auth.currentVerifiedAuthSessionId()).toBeTruthy();
  expect(await h.typedApi.collaborations.sourceSetup('existing-chat', h.clientId)).toMatchObject({
    state: 'selected',
  });
  const { SharedConversationHost, SharedConversationBody } =
    await import('../../frontend/src/components/SharedConversation.js');
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
            messages: [],
            current: null,
            running: false,
            permission: null,
            onPermissionRespond: () => {},
          }}
        >
          <p>Original discussion remains available.</p>
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
    expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy();
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
    for (let i = 0; i < 25; i++) {
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
    }
    expect((await h.api.view(h.group)).hasEarlierMessages).toBe(true);
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
}, 30000);
