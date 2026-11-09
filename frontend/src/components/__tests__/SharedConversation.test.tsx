// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  settings,
  uuid,
} from '../../../../tests/fixtures/symposium-shared-conversation-data';

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
