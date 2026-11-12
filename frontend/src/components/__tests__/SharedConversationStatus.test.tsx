// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MitzoApiClient } from '@mitzo/client';
import { SharedConversationHost, SharedConversationBody } from '../SharedConversation';
import { ComposerStatusProvider, ComposerStatusRail } from '../ComposerStatus';
import { sharedConversationView } from '../../../../tests/fixtures/symposium-shared-conversation-data';

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

const proof = () => 'verified-login';
function surface(fetch: ConstructorParameters<typeof MitzoApiClient>[0]) {
  return render(
    <SharedConversationHost
      sourceConversationId="architect"
      api={new MitzoApiClient(fetch)}
      clientId="client"
      authScope={proof()}
      getVerifiedAuthScope={proof}
    >
      <ComposerStatusProvider>
        <SharedConversationBody
          sourceConversationId="architect"
          chat={{
            messages: [],
            current: null,
            running: false,
            permission: null,
            onPermissionRespond: () => {},
          }}
        >
          <ComposerStatusRail />
          <textarea aria-label="Ordinary draft" defaultValue="Keep this edit" />
        </SharedConversationBody>
      </ComposerStatusProvider>
    </SharedConversationHost>,
  );
}

it('keeps a verified fresh ordinary chat quiet without beginning collaboration', async () => {
  const fetch = vi.fn(async () =>
    Response.json({ state: 'unstarted', sourceConversationId: 'architect' }),
  );
  surface(fetch);
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  await act(async () => {});
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText(/Sign in to verify/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Refresh collaboration' })).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('Ready');
  expect(fetch.mock.calls).toHaveLength(1);
});

it.each(['setup', 'view'] as const)(
  'puts a genuine %s failure in the existing rail and retries its owner',
  async (stage) => {
    const view = {
      ...sharedConversationView(),
      participantSessionIds: ['architect'],
      policies: [sharedConversationView().policies[0]],
      messages: [],
      cursor: 0,
    };
    let failed = false;
    let progressReads = 0;
    let confirmView!: (response: Response) => void;
    const confirmation = new Promise<Response>((resolve) => {
      confirmView = resolve;
    });
    const fetch = vi.fn(async (url: string) => {
      if (
        !failed &&
        (stage === 'setup' ? url.includes('/source-setup?') : url.endsWith('/conversation'))
      ) {
        failed = true;
        return Response.json(
          { code: 'unavailable', error: 'Collaboration read unavailable' },
          { status: 503 },
        );
      }
      if (url.includes('source-setup'))
        return Response.json({
          state: 'selected',
          sourceConversationId: 'architect',
          collaboration: {
            version: 1,
            collaborationId: view.collaborationId,
            revision: 1,
            participantSessionIds: view.participantSessionIds,
          },
        });
      if (url.endsWith('/progress')) {
        progressReads++;
        return Response.json({
          collaborationId: view.collaborationId,
          membershipRevision: view.membershipRevision,
          replies: [],
          refusals: [],
        });
      }
      if (url.endsWith('/conversation')) return (await confirmation).clone();
      throw Error('Unexpected request: ' + url);
    });
    surface(fetch);
    const rail = screen.getByRole('region', { name: 'Conversation status' });
    const input = screen.getByRole('textbox', { name: 'Ordinary draft' });
    fireEvent.change(input, { target: { value: 'Unsaved ordinary continuation' } });
    await waitFor(() =>
      expect(within(rail).getByRole('alert').textContent).toContain(
        'Collaboration read unavailable',
      ),
    );
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    fireEvent.click(within(rail).getByRole('button', { name: 'Refresh collaboration' }));
    // Setup clears its error before the conversation read starts. Observe the
    // actual read, then deliver it; a transient Ready label is not completion.
    await waitFor(() =>
      expect(fetch.mock.calls.filter(([url]) => url.endsWith('/conversation'))).toHaveLength(
        stage === 'view' ? 2 : 1,
      ),
    );
    await act(async () => confirmView(Response.json(view)));
    await waitFor(() => expect(within(rail).getByRole('status').textContent).toBe('Ready'));
    expect(screen.getByRole('region', { name: 'Conversation status' })).toBe(rail);
    expect(screen.getByRole('textbox', { name: 'Ordinary draft' })).toBe(input);
    expect(input).toHaveProperty('value', 'Unsaved ordinary continuation');
    expect(fetch.mock.calls.filter(([url]) => url.includes('source-setup'))).toHaveLength(
      stage === 'setup' ? 2 : 1,
    );
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/conversation'))).toHaveLength(
      (stage === 'view' ? 2 : 1) + progressReads,
    );
    expect(progressReads).toBeGreaterThan(0);
  },
);
