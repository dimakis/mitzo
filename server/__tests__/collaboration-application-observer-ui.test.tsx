// @vitest-environment node-compatible-dom
import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createApplicationJourney } from './fixtures/symposium-application-journey.js';
import { recordApplicationMessagingRuntime } from './fixtures/symposium-recording-runtime.js';
import { installDialogStub } from '../../frontend/src/components/__tests__/dialog-stub.js';

const journey = createApplicationJourney();
afterAll(() => journey.close());
it('hands off live and between-sample finalized replies to an observer with no local send journal', async () => {
  const h = await journey.getApplicationUiJourney();
  vi.stubGlobal('HTMLDialogElement', window.HTMLDialogElement);
  installDialogStub();
  const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  (await import('../auth.js')).setAuthRevocationStore(h.events);
  const runtime = await recordApplicationMessagingRuntime(h.events);
  const initial = await h.api.view(h.group);
  await h.api.setPolicy(h.group, {
    requestId: randomUUID(),
    expectedMembershipRevision: initial.membershipRevision,
    expectedRevision: initial.policies.find((p) => p.sessionId === 'existing-chat')!.revision,
    sessionId: 'existing-chat',
    readsFutureDiscussion: false,
    repliesByDefault: false,
  });
  vi.stubGlobal('fetch', h.fetch);
  const auth = await import('../../frontend/src/lib/api-fetch.js');
  expect(await auth.restoreCookieAuthentication()).toBe(true);
  const { SharedConversationHost, SharedConversationBody } =
    await import('../../frontend/src/components/SharedConversation.js');
  const { getChatDraft } = await import('../../frontend/src/lib/chat-drafts.js');
  const noLocalSend = () =>
    expect(
      Object.keys(localStorage)
        .filter((k) => k.startsWith('mitzo-chat-draft:'))
        .map((k) => getChatDraft(k.slice('mitzo-chat-draft:'.length))?.collaborationSend)
        .filter(Boolean),
    ).toEqual([]);
  try {
    render(
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
            <p>Observed ordinary discussion</p>
          </SharedConversationBody>
        </SharedConversationHost>
      </MemoryRouter>,
    );
    await screen.findByRole('button', { name: 'Refresh conversation', exact: true });
    const externalSend = async (text: string) => {
      const view = await h.api.view(h.group);
      return h.api.send(h.group, {
        requestId: randomUUID(),
        expectedMembershipRevision: view.membershipRevision,
        expectedPolicySequence: view.policySequence,
        text,
        snapshot: null,
        responders: { kind: 'selected', sessionIds: [h.joinedSessionId!] },
      });
    };
    noLocalSend();
    runtime.holdTurn(1);
    await act(async () => {
      await externalSend('Sent from another device while this viewer only observes.');
    });
    await waitFor(() =>
      expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1),
    );
    await waitFor(() => runtime.streamTurn(1, 'Reviewed the selected design.'));
    const live = await screen.findByText('Reviewed the selected design.', {}, { timeout: 5000 });
    expect(live.closest('.msg-turn--streaming')).not.toBeNull();
    noLocalSend();
    await act(async () => runtime.finishTurn(1, 'completed'));
    await waitFor(
      () => {
        expect(
          screen.getByText('Reviewed the selected design.').closest('.msg-turn--streaming'),
        ).toBeNull();
        expect(screen.getByText('Reply completed')).toBeTruthy();
      },
      { timeout: 5000 },
    );
    noLocalSend();
    h.events.upsertSession({ sessionId: 'external-linked-peer', conversationSource: 'mitzo' });
    const previous = await h.api.view(h.group);
    const changed = await h.fetch('/api/session-collaborations/' + h.group, {
      method: 'PUT',
      body: JSON.stringify({
        expectedRevision: previous.membershipRevision,
        participantSessionIds: [...previous.participantSessionIds, 'external-linked-peer'],
      }),
    });
    expect(changed.status).toBe(200);
    // This turn finishes in10ms, normally between the observer's1500ms samples.
    await act(async () => {
      await externalSend('A second external request completes before the next live sample.');
    });
    await waitFor(
      () => expect(screen.getAllByText('Reviewed the selected design.')).toHaveLength(2),
      { timeout: 7000 },
    );
    noLocalSend();
    expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(2);
  } finally {
    cleanup();
    const { registry } = await import('../chat.js');
    for (const id of (await h.api.view(h.group)).participantSessionIds) {
      const live = registry.findBySessionId(id);
      if (live) await act(async () => registry.abort(live.clientId));
    }
    const { getRepositoryWorkspaces } = await import('../repository-workspace-runtime.js');
    await vi.waitFor(() => getRepositoryWorkspaces(true).closeIdle());
    runtime.restore();
    if (scroll) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scroll);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  }
}, 30000);
