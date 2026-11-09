// @vitest-environment node-compatible-dom
import { expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { getApplicationUiJourney } from './collaboration-application-joining-integration.test.js';
import { recordApplicationMessagingRuntime } from './fixtures/symposium-recording-runtime.js';

// Production client, auth, UI, application, storage, dispatch and reply owners.
// Only external source/account/runtime declarations and native RPC are synthetic.
it('sends first and later selected prompts from the production shared composer after remount', async () => {
  const h = await getApplicationUiJourney();
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
      () => expect(screen.getAllByText('Reviewed the selected design.')).toHaveLength(2),
      { timeout: 10000 },
    );
    const turns = runtime.requests.filter((r) => r.method === 'turn/start');
    expect(turns).toHaveLength(2);
    expect(JSON.stringify(turns[1].params)).toContain('Review a second question explicitly.');
    const after = await h.api.view(h.group);
    const answers = after.messages.filter((m) => m.author !== 'operator');
    expect(answers).toHaveLength(2);
    expect(new Set(answers.map((m) => m.source?.commandId)).size).toBe(2);
    expect(new Set(answers.map((m) => m.replyToDeliveryId)).size).toBe(2);
    expect(
      answers.every((m) => m.author !== 'operator' && m.author.sessionId === h.joinedSessionId),
    ).toBe(true);
  } finally {
    cleanup();
    const { registry } = await import('../chat.js');
    const live = registry.findBySessionId(h.joinedSessionId);
    if (live) await act(async () => registry.abort(live.clientId));
    runtime.restore();
    if (originalScrollTo)
      Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  }
}, 30000);
