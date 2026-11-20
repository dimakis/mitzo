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

function startingTree(
  fetch: ConstructorParameters<typeof MitzoApiClient>[0],
  source = 'architect',
  api = new MitzoApiClient(fetch),
) {
  return (
    <SharedConversationHost
      sourceConversationId={source}
      api={api}
      clientId="client"
      authScope={proof()}
      getVerifiedAuthScope={proof}
    >
      <ComposerStatusProvider>
        <SharedConversationBody
          sourceConversationId={source}
          ordinaryComposer={<p>Ordinary composer</p>}
          chat={{
            messages: [
              {
                messageId: 'first-prompt',
                role: 'user',
                blocks: [{ blockId: 'text', blockType: 'text', content: 'Investigate the logs' }],
              },
            ],
            current: null,
            running: true,
            permission: null,
            onPermissionRespond: () => {},
          }}
        >
          <ComposerStatusRail />
        </SharedConversationBody>
      </ComposerStatusProvider>
    </SharedConversationHost>
  );
}
function startingSurface(fetch: ConstructorParameters<typeof MitzoApiClient>[0]) {
  return render(startingTree(fetch));
}
const startupRefusal = () =>
  Response.json({ code: 'unavailable_recipient', error: 'unavailable_recipient' }, { status: 422 });

it('keeps a chat started in this view visible while its session is still starting', async () => {
  let refusals = 0;
  const fetch = vi.fn(async () =>
    refusals++ < 2
      ? startupRefusal()
      : Response.json({ state: 'unstarted', sourceConversationId: 'architect' }),
  );
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const api = new MitzoApiClient(fetch);
  // The new-chat draft has no conversation yet; sending assigns its id in place.
  const view = render(startingTree(fetch, '', api));
  expect(screen.getByText('Investigate the logs')).toBeTruthy();
  view.rerender(startingTree(fetch, 'architect', api));
  expect(screen.getByText('Investigate the logs')).toBeTruthy();
  expect(screen.queryByText('Checking retained discussion history…')).toBeNull();
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  await act(async () => {});
  // Refused setup still retries and gates sending, but never hides the prompt.
  expect(screen.getByText('Investigate the logs')).toBeTruthy();
  expect(screen.queryByText('Checking retained discussion history…')).toBeNull();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3), { timeout: 3000 });
  expect(screen.getByText('Investigate the logs')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('still checks retained history before showing an opened chat that is starting', async () => {
  const fetch = vi.fn(async () => startupRefusal());
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const api = new MitzoApiClient(fetch);
  // Switching from another conversation is not an in-view start.
  const view = render(startingTree(fetch, 'previous', api));
  view.rerender(startingTree(fetch, 'architect', api));
  await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(1));
  expect(screen.queryByText('Investigate the logs')).toBeNull();
  expect(screen.getByText('Checking retained discussion history…')).toBeTruthy();
});

it('retries a new chat refused during startup and then shows its ordinary transcript', async () => {
  let refusals = 0;
  const fetch = vi.fn(async () =>
    refusals++ < 1
      ? startupRefusal()
      : Response.json({ state: 'unstarted', sourceConversationId: 'architect' }),
  );
  vi.spyOn(console, 'info').mockImplementation(() => {});
  startingSurface(fetch);
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  // While the source is still starting, setup remains resolving rather than failed.
  expect(screen.queryByText('Investigate the logs')).toBeNull();
  expect(screen.queryByText(/unavailable_recipient/)).toBeNull();
  await screen.findByText('Investigate the logs', undefined, { timeout: 3000 });
  expect(screen.queryByText('Checking retained discussion history…')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('names a persistent startup refusal after bounded retries and lets the operator retry', async () => {
  vi.useFakeTimers();
  try {
    let available = false;
    const fetch = vi.fn(async () =>
      available
        ? Response.json({ state: 'unstarted', sourceConversationId: 'architect' })
        : startupRefusal(),
    );
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    startingSurface(fetch);
    for (let i = 0; i < 12; i++) await act(() => vi.advanceTimersByTimeAsync(30_000));
    // One initial read plus eight bounded startup retries (~90s), then a named failure.
    expect(fetch).toHaveBeenCalledTimes(9);
    expect(
      screen.getByText(
        'This conversation is not available for collaboration checks yet. Refresh to check again.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/unavailable_recipient/)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      'Collaboration source setup failed',
      expect.objectContaining({ code: 'collaboration_source_setup_unavailable' }),
    );
    available = true;
    fireEvent.click(screen.getAllByRole('button', { name: 'Refresh collaboration' })[0]);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText('Investigate the logs')).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
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
      if (url.includes('/recipients/'))
        return Response.json({
          collaborationId: view.collaborationId,
          sessionId: 'architect',
          membershipRevision: view.membershipRevision,
          policySequence: view.policySequence,
          ready: true,
          reason: null,
        });
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
