// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { MitzoApiClient } from '@mitzo/client';
import { CollaborationJoinSchema, COLLABORATION_EXECUTION_DISABLED } from '@mitzo/protocol';
import {
  OrdinarySharedConversationHost,
  SharedConversationHost,
  SharedConversationBody,
} from '../SharedConversation';
import {
  sharedConversationView,
  sharedReply,
  settings,
  uuid,
} from '../../../../tests/fixtures/symposium-shared-conversation-data';
import { ChatArea } from '../ChatArea';
import { installDialogStub } from './dialog-stub';

const ordinary = vi.hoisted(() => ({ connection: null as null | { clientId: string } }));
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (state: unknown) => unknown) => select(ordinary),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  ordinary.connection = null;
});

it.each([false, true])(
  'opens targeted sharing while the original agent is running: %s',
  async (running) => {
    installDialogStub();
    HTMLElement.prototype.scrollTo = vi.fn();
    const view = sharedConversationView();
    view.messages = [];
    view.joinedParticipants = [{ sessionId: 'reviewer', name: 'Reviewer' }];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method ?? 'GET').toBe('GET');
      if (url.includes('source-setup'))
        return Response.json({
          state: 'selected',
          sourceConversationId: 'architect',
          collaboration: {
            version: 1,
            collaborationId: view.collaborationId,
            revision: view.membershipRevision,
            participantSessionIds: view.participantSessionIds,
          },
        });
      if (url.endsWith('/conversation')) return Response.json(view);
      if (url.endsWith('/progress'))
        return Response.json({
          collaborationId: view.collaborationId,
          membershipRevision: view.membershipRevision,
          replies: [],
          refusals: [],
        });
      if (url.endsWith('?transcript=durable'))
        return Response.json({
          sourceConversationId: 'architect',
          boundary: { sequence: 1, messageId: 'earlier' },
          messages: [
            {
              conversationId: 'architect',
              sequence: 1,
              messageId: 'earlier',
              author: 'operator',
              source: null,
              blocks: [{ blockId: 'text', content: 'The earlier plan', sha256: 'a'.repeat(64) }],
            },
          ],
        });
      if (url.includes('/context-source-artifacts'))
        return Response.json({ sourceConversationId: 'architect', artifacts: [] });
      throw Error('Unexpected request: ' + url);
    });
    const chat = {
      messages: [
        {
          messageId: 'earlier',
          role: 'user' as const,
          blocks: [{ blockId: 'text', blockType: 'text' as const, content: 'The earlier plan' }],
        },
      ],
      current: null,
      running,
      permission: null,
      onPermissionRespond: () => {},
    };
    render(
      <MemoryRouter>
        <SharedConversationHost
          sourceConversationId="architect"
          api={new MitzoApiClient(fetch)}
          clientId="client"
          authScope="login"
          getVerifiedAuthScope={() => 'login'}
        >
          <SharedConversationBody
            sourceConversationId="architect"
            chat={chat}
            ordinaryHistory={<ChatArea {...chat} />}
            ordinaryComposer={<p>The original agent is working</p>}
          >
            <p>Loading</p>
          </SharedConversationBody>
        </SharedConversationHost>
      </MemoryRouter>,
    );
    const share = await screen.findByText('Share excerpt');
    fireEvent.click(share);
    const dialog = await screen.findByRole('dialog', { name: 'Send selected messages' });
    expect(await within(dialog).findByRole('checkbox', { name: /The earlier plan/ })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Reviewer' }));
    expect(within(dialog).queryByRole('button', { name: 'Attach reviewed context' })).toBeNull();
    expect(fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  },
);

it('observes remote rejoining and its reply after the last other participant leaves, without a local send or refresh', async () => {
  const view = sharedConversationView();
  view.messages = [];
  let progressFailure = false;
  const policies = structuredClone(view.policies);
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    expect(options?.method ?? 'GET').toBe('GET');
    if (url.includes('source-setup'))
      return Response.json({
        state: 'selected',
        sourceConversationId: 'architect',
        collaboration: {
          version: 1,
          collaborationId: view.collaborationId,
          revision: view.membershipRevision,
          participantSessionIds: view.participantSessionIds,
        },
      });
    if (url.endsWith('/progress'))
      if (progressFailure)
        return Response.json(
          { error: 'Could not observe shared discussion', code: 'execution_unavailable' },
          { status: 503 },
        );
    if (url.endsWith('/progress'))
      return Response.json({
        collaborationId: view.collaborationId,
        membershipRevision: view.membershipRevision,
        replies: [],
        refusals: [],
      });
    if (url.endsWith('/conversation')) return Response.json(view);
    throw Error('Unexpected observer request: ' + url);
  });
  const proof = () => 'login';
  render(
    <MemoryRouter>
      <SharedConversationHost
        sourceConversationId="architect"
        api={new MitzoApiClient(fetch)}
        clientId="client"
        authScope="login"
        getVerifiedAuthScope={proof}
      >
        <SharedConversationBody
          sourceConversationId="architect"
          ordinaryHistory={<p>Ordinary discussion remains available</p>}
          chat={{
            messages: [],
            current: null,
            running: false,
            permission: null,
            onPermissionRespond: () => {},
          }}
        >
          <p>Ordinary discussion remains available</p>
        </SharedConversationBody>
      </SharedConversationHost>
    </MemoryRouter>,
  );
  await screen.findByRole('button', { name: 'Choose who replies' });
  view.participantSessionIds = ['architect'];
  view.membershipRevision++;
  view.policies = policies.filter((policy) => policy.sessionId === 'architect');
  await waitFor(
    () => expect(screen.queryByRole('button', { name: 'Choose who replies' })).toBeNull(),
    { timeout: 5000 },
  );
  progressFailure = true;
  await screen.findByText('Could not observe shared discussion', {}, { timeout: 5000 });
  expect(screen.getByText('Ordinary discussion remains available')).toBeTruthy();
  progressFailure = false;
  view.participantSessionIds = ['architect', 'reviewer'];
  view.membershipRevision++;
  view.policies = policies.filter((policy) =>
    view.participantSessionIds.includes(policy.sessionId),
  );
  view.messages = [{ ...sharedReply, text: 'Remote answer after rejoining' }];
  view.cursor = 3;
  await screen.findByText('Remote answer after rejoining', {}, { timeout: 5000 });
  expect(
    fetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET'),
  ).toBe(true);
}, 15000);
it('mounts the retained shared transcript through the production wrapper while preserving ordinary history', async () => {
  const view = sharedConversationView();
  view.joinedParticipants = [{ sessionId: 'reviewer', name: 'Reviewer' }];
  view.joins.push(
    CollaborationJoinSchema.parse({
      version: 1,
      joinId: uuid(100),
      name: 'Reviewer',
      membershipRevision: 1,
      settings,
      snapshot: { snapshotId: uuid(101), sha256: 'a'.repeat(64) },
      allocationOperationId: uuid(102),
      state: 'linked',
      sessionId: 'reviewer',
      linkedFromRevision: 1,
      execution: COLLABORATION_EXECUTION_DISABLED,
    }),
  );
  const fetch = vi.fn(async (url: string) => {
    if (url.includes('source-setup'))
      return Response.json({
        state: 'selected',
        sourceConversationId: 'architect',
        collaboration: {
          version: 1,
          collaborationId: view.collaborationId,
          revision: view.membershipRevision,
          participantSessionIds: view.participantSessionIds,
        },
      });
    if (url.endsWith('/conversation')) return Response.json(view);
    throw Error('Unexpected read: ' + url);
  });
  const proof = () => 'login';
  const scrollRef = createRef<HTMLDivElement>();
  const stop = vi.fn();
  const api = new MitzoApiClient(fetch);
  const surface = (running = false) => (
    <MemoryRouter>
      <SharedConversationHost
        sourceConversationId="architect"
        api={api}
        clientId="client"
        authScope="login"
        getVerifiedAuthScope={proof}
      >
        <SharedConversationBody
          sourceConversationId="architect"
          ordinaryHistory={
            <div ref={scrollRef} data-testid="ordinary-history">
              Original ordinary history
            </div>
          }
          ordinaryComposer={<button onClick={stop}>Stop source turn</button>}
          chat={{
            messages: [],
            current: null,
            running,
            scrollRef,
            permission: null,
            onPermissionRespond: () => {},
          }}
        >
          <p>Original ordinary history</p>
        </SharedConversationBody>
      </SharedConversationHost>
    </MemoryRouter>
  );
  const rendered = render(surface());
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Choose who replies' })).toBeTruthy(),
  );
  expect(screen.getByText('Original ordinary history')).toBeTruthy();
  expect(scrollRef.current).toBe(screen.getByTestId('ordinary-history'));
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/messages'))).toBe(false);
  rendered.rerender(surface(true));
  fireEvent.click(screen.getByRole('button', { name: 'Stop source turn' }));
  expect(stop).toHaveBeenCalledOnce();
  expect(screen.getByText(view.messages[1].text)).toBeTruthy();
});

it('preserves the ordinary screen while the first source identity is assigned or changes', () => {
  const surface = (sourceConversationId: string | null) => (
    <OrdinarySharedConversationHost sourceConversationId={sourceConversationId}>
      <input aria-label="Ordinary draft" defaultValue="Keep this edit" />
    </OrdinarySharedConversationHost>
  );
  const rendered = render(surface(null));
  const input = screen.getByRole('textbox', { name: 'Ordinary draft' });
  fireEvent.change(input, { target: { value: 'Unsaved ordinary continuation' } });
  rendered.rerender(surface('first'));
  expect(screen.getByRole('textbox', { name: 'Ordinary draft' })).toBe(input);
  expect((input as HTMLInputElement).value).toBe('Unsaved ordinary continuation');
  rendered.rerender(surface('second'));
  expect(screen.getByRole('textbox', { name: 'Ordinary draft' })).toBe(input);
});

it('observes the existing login owner without starting another authentication request', async () => {
  ordinary.connection = { clientId: 'ordinary-client' };
  const request = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Unexpected auth request'));
  render(
    <OrdinarySharedConversationHost sourceConversationId="ordinary">
      <p>Ordinary conversation</p>
    </OrdinarySharedConversationHost>,
  );
  await act(async () => {});
  expect(request).not.toHaveBeenCalled();
  expect(screen.getByText('Ordinary conversation')).toBeTruthy();
});
