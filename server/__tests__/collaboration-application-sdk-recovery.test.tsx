// @vitest-environment node-compatible-dom
import { expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { journey, sdkApplicationState } from './fixtures/symposium-claude-application.js';
import { installDialogStub } from '../../frontend/src/components/__tests__/dialog-stub.js';

const observed = sdkApplicationState();

it('recovers the exact pre-input SDK Stop through the production composer Check action without provider acceptance or replay', async () => {
  if (journey.state.root !== undefined) await journey.restartApplication();
  const h = await journey.getApplicationUiJourney();
  vi.stubGlobal('HTMLDialogElement', window.HTMLDialogElement);
  installDialogStub();
  (await import('../auth.js')).setAuthRevocationStore(h.events);
  const participant = await journey.joinReviewedParticipant({
    accountId: 'offline-claude',
    harness: 'claude-sdk',
    targetId: 'offline-claude-target',
  });
  let view = await h.api.view(h.group);
  for (const policy of view.policies.filter((policy) => policy.readsFutureDiscussion))
    await h.api.setPolicy(h.group, {
      requestId: crypto.randomUUID(),
      expectedMembershipRevision: view.membershipRevision,
      expectedRevision: policy.revision,
      sessionId: policy.sessionId,
      readsFutureDiscussion: false,
      repliesByDefault: false,
    });
  view = await h.api.view(h.group);
  const warm = {
    requestId: crypto.randomUUID(),
    expectedMembershipRevision: view.membershipRevision,
    expectedPolicySequence: view.policySequence,
    text: 'Warm the exact deterministic SDK owner',
    responders: { kind: 'selected' as const, sessionIds: [participant] },
    snapshot: null,
  };
  await h.api.send(h.group, warm);
  await vi.waitFor(
    async () => expect((await h.api.observeSend(h.group, warm)).terminal).toBe(true),
    { timeout: 10000 },
  );
  const { createChatDraft, saveChatDraft, getChatDraft } =
    await import('../../frontend/src/lib/chat-drafts.js');
  const { SharedConversationHost, SharedConversationBody } =
    await import('../../frontend/src/components/SharedConversation.js');
  const draft = createChatDraft();
  expect(
    saveChatDraft({
      ...draft,
      id: 'shared:' + h.group,
      settings: {
        ...draft.settings,
        collaborationResponders: {
          collaborationId: h.group,
          responders: { kind: 'selected', sessionIds: [participant] },
        },
      },
    }),
  ).toBe(true);
  vi.stubGlobal('fetch', h.fetch);
  vi.stubGlobal(
    'EventSource',
    class extends EventTarget {
      readyState = 0;
      onopen = null;
      onerror = null;
      close() {
        this.readyState = 2;
      }
    },
  );
  const auth = await import('../../frontend/src/lib/api-fetch.js');
  expect(await auth.restoreCookieAuthentication()).toBe(true);
  const oldScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  const before = { inputs: observed.inputs.length, interrupts: observed.interrupts };
  const ui = render(
    createElement(
      MemoryRouter,
      null,
      createElement(SharedConversationHost, {
        sourceConversationId: 'existing-chat',
        api: h.typedApi,
        clientId: h.clientId,
        authScope: auth.currentVerifiedAuthSessionId(),
        getVerifiedAuthScope: auth.currentVerifiedAuthSessionId,
        children: createElement(SharedConversationBody, {
          sourceConversationId: 'existing-chat',
          children: null,
          chat: {
            messages: [],
            current: null,
            running: false,
            permission: null,
            onPermissionRespond: () => {},
          },
        }),
      }),
    ),
  );
  try {
    const input = await screen.findByRole('textbox', { name: 'Message Mitzo' });
    fireEvent.change(input, { target: { value: 'Cancel before the SDK receives this prompt' } });
    await waitFor(
      () =>
        expect(
          (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled,
        ).toBe(false),
      { timeout: 10000 },
    );
    observed.holdInputAuthority = true;
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await vi.waitFor(() => expect(observed.releaseInput).toBeTypeOf('function'), {
      timeout: 10000,
    });
    await screen.findByRole('button', { name: /^Stop / });
    const accepted = (await h.api.view(h.group)).messages.find(
      (message) => message.text === 'Cancel before the SDK receives this prompt',
    )!;
    const commandId = accepted.deliveries.find(
      (delivery) => delivery.sessionId === participant,
    )!.commandId!;
    const original = getChatDraft('shared:' + h.group)!.collaborationSend!.input;
    expect(commandId).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Stop / }));
    await vi.waitFor(() =>
      expect(h.events.getSession(participant)?.executionPhase).toBe('STOPPING'),
    );
    // Later edits belong to the same mounted composer, independently of Stop's receipt.
    fireEvent.change(input, { target: { value: 'Keep the draft after pre-input Stop' } });
    await act(async () => observed.releaseInput!());
    await vi.waitFor(() =>
      expect(h.events.getSendCommand(commandId)?.error).toBe('Cancelled before SDK dispatch'),
    );
    const check = screen.queryByRole('button', { name: 'Check original Stop' });
    if (check) fireEvent.click(check);
    else {
      fireEvent.click(screen.getByRole('button', { name: 'Conversation status details' }));
      const status = screen.getByRole('dialog', { name: 'Conversation status' });
      fireEvent.click(within(status).getByRole('button', { name: 'Check original Stop' }));
      fireEvent.click(within(status).getByRole('button', { name: 'Close', exact: true }));
    }
    // The new independent Stop owner settles before the ordinary two-second
    // transcript observer refreshes this composer. Keep its UI assertion bounded.
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Stop / })).toBeNull(), {
      timeout: 5000,
    });
    expect(screen.getByRole('textbox', { name: 'Message Mitzo' })).toBe(input);
    expect((input as HTMLTextAreaElement).value).toBe('Keep the draft after pre-input Stop');
    expect((await h.api.observeSend(h.group, original)).terminal).toBe(true);
    expect(h.events.getOrdinarySdkTurnEvents(participant, commandId)).toEqual([]);
    expect(h.events.getOrdinaryProviderTurnTerminal(participant, commandId)).toBeUndefined();
    expect(observed.inputs).toHaveLength(before.inputs);
    expect(observed.interrupts).toBe(before.interrupts);
  } finally {
    observed.holdInputAuthority = false;
    observed.releaseInput?.();
    ui.unmount();
    cleanup();
    vi.unstubAllGlobals();
    if (oldScroll) Object.defineProperty(HTMLElement.prototype, 'scrollTo', oldScroll);
    else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
    const { registry } = await import('../chat.js');
    const live = registry.findBySessionId(participant);
    if (live) registry.abort(live.clientId);
  }
}, 60000);
