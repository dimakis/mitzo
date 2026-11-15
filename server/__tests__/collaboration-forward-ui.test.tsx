// @vitest-environment node-compatible-dom
import { afterAll, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createApplicationJourney } from './fixtures/symposium-application-journey.js';
import { recordApplicationMessagingRuntime } from './fixtures/symposium-recording-runtime.js';
import { installDialogStub } from '../../frontend/src/components/__tests__/dialog-stub.js';
import { registerSymposiumSourceOutput } from './fixtures/symposium-source-output.js';

const journey = createApplicationJourney();
afterAll(() => journey.close());

it('forwards inspected context through the production UI and recovers a lost confirmation without another turn or forward', async () => {
  const h = await journey.getApplicationUiJourney();
  vi.stubGlobal('HTMLDialogElement', window.HTMLDialogElement);
  installDialogStub();
  const scrolling = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  (await import('../auth.js')).setAuthRevocationStore(h.events);
  const runtime = await recordApplicationMessagingRuntime(h.events);
  vi.stubGlobal('fetch', h.fetch);
  const auth = await import('../../frontend/src/lib/api-fetch.js');
  expect(await auth.restoreCookieAuthentication()).toBe(true);
  const { SharedConversationHost, SharedConversationBody } =
    await import('../../frontend/src/components/SharedConversation.js');
  const initial = await h.api.view(h.group);
  const policy = initial.policies.find((p) => p.sessionId === 'existing-chat')!;
  await h.api.setPolicy(h.group, {
    requestId: crypto.randomUUID(),
    expectedMembershipRevision: initial.membershipRevision,
    expectedRevision: policy.revision,
    sessionId: policy.sessionId,
    readsFutureDiscussion: false,
    repliesByDefault: false,
  });
  const exact = 'Forward this exact saved design • 台灣\r\n';
  registerSymposiumSourceOutput(h.events, 'existing-chat', exact);
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
    fireEvent.click(await screen.findByRole('button', { name: 'Choose who replies' }));
    // This journey forwards to the reviewer only. The historical source has no
    // live ordinary owner and must not remain selected by the new-draft default.
    const sourceReply = screen.getByRole('checkbox', { name: 'Current agent', exact: true });
    if ((sourceReply as HTMLInputElement).checked) fireEvent.click(sourceReply);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Independent reviewer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done choosing replies' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Mitzo' }), {
      target: { value: 'Only send this after forwarding.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review prompt context' }));
    let dialog = await screen.findByRole('dialog', { name: 'Context for this prompt' });
    await waitFor(() =>
      expect(
        (within(dialog).getByRole('textbox', { name: 'Purpose' }) as HTMLInputElement).disabled,
      ).toBe(false),
    );
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Purpose' }), {
      target: { value: 'Forward inspected design' },
    });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Context', exact: true }), {
      target: { value: 'conversation_so_far' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review context', exact: true }));
    const prepare = () =>
      within(dialog).getByRole('button', { name: 'Prepare context forward' }) as HTMLButtonElement;
    await waitFor(() => expect(prepare().disabled).toBe(false));
    fireEvent.click(within(dialog).getByText('Review included context', { exact: false }));
    expect(within(dialog).getByLabelText('Saved contents, version 1').textContent).toBe(exact);
    expect(runtime.requests).toEqual([]);
    fireEvent.click(prepare());
    const confirm = () =>
      within(dialog).getByRole('button', { name: 'Confirm context forward' }) as HTMLButtonElement;
    await waitFor(() => expect(confirm().disabled).toBe(false));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Purpose' }), {
      target: { value: 'Keep this newer context edit' },
    });
    expect(confirm().disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Inspect original context' }));
    const original = await within(dialog).findByRole('region', {
      name: 'Original forward context',
    });
    expect(within(original).getByText('Independent reviewer')).toBeTruthy();
    expect(within(original).getByLabelText('Saved contents, version 1').textContent).toBe(exact);
    await waitFor(() => expect(confirm().disabled).toBe(false));
    expect(
      (within(dialog).getByRole('textbox', { name: 'Purpose' }) as HTMLInputElement).value,
    ).toBe('Keep this newer context edit');
    const realConfirm = h.typedApi.collaborations.confirmForward.bind(h.typedApi.collaborations);
    const confirmation = vi
      .spyOn(h.typedApi.collaborations, 'confirmForward')
      .mockImplementationOnce(async (...args) => {
        await realConfirm(...args);
        throw Error('Synthetic response loss after durable confirmation');
      });
    fireEvent.click(confirm());
    await within(dialog).findByText('Synthetic response loss after durable confirmation');
    expect(runtime.requests).toEqual([]);
    ui.unmount();
    ui = render(surface());
    const reviewContext = await screen.findByRole('button', { name: 'Review prompt context' });
    await waitFor(() => expect((reviewContext as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(reviewContext);
    dialog = await screen.findByRole('dialog', { name: 'Context for this prompt' });
    expect(
      (within(dialog).getByRole('textbox', { name: 'Purpose' }) as HTMLInputElement).value,
    ).toBe('Keep this newer context edit');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check original forward' }));
    await within(dialog).findByText(
      'Forward recorded. Delivery remains visible in the conversation.',
    );
    expect(confirmation).toHaveBeenCalledTimes(1);
    expect(runtime.requests).toEqual([]);
    const forwarded = (await h.api.view(h.group)).messages;
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      responders: [],
      deliveries: [{ purpose: 'context', status: 'pending', commandId: null }],
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close prompt context' }));
    expect(
      (screen.getByRole('textbox', { name: 'Message Mitzo' }) as HTMLTextAreaElement).value,
    ).toBe('Only send this after forwarding.');
    const send = screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(
      async () =>
        expect((await h.api.view(h.group)).messages.some((m) => m.author !== 'operator')).toBe(
          true,
        ),
      { timeout: 10000 },
    );
    const turns = runtime.requests.filter((r) => r.method === 'turn/start');
    expect(turns).toHaveLength(1);
    const text = (turns[0].params.input as Array<{ text?: string }>)
      .map((p) => p.text ?? '')
      .join('');
    const packet = JSON.parse(text.split('\n')[2]);
    expect(
      packet.discussion.find((m: { forwardedContext?: unknown }) => m.forwardedContext)
        .forwardedContext.artifacts[0].content,
    ).toBe(exact);
    expect(text).not.toContain('DO_NOT_LEAK');
    confirmation.mockRestore();
  } finally {
    vi.restoreAllMocks();
    ui?.unmount();
    const { registry } = await import('../chat.js');
    for (const id of (await h.api.view(h.group)).participantSessionIds) {
      const live = registry.findBySessionId(id);
      if (live) registry.abort(live.clientId);
    }
    const { getRepositoryWorkspaces } = await import('../repository-workspace-runtime.js');
    await vi.waitFor(() => getRepositoryWorkspaces(true).closeIdle());
    await act(async () => cleanup());
    runtime.restore();
    vi.unstubAllGlobals();
    if (scrolling) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrolling);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  }
}, 30000);
