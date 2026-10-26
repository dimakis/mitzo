// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LegacyNativeContinuation } from '../LegacyNativeContinuation';
import { createTestStore } from '../../test-utils/createTestStore';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
const mocks = vi.hoisted(() => ({ request: vi.fn(), prepare: vi.fn(), runtime: vi.fn() }));
vi.mock('../../hooks/useExplicitLocalChat', () => ({ useExplicitLocalChat: mocks.runtime }));
vi.mock('../../lib/explicit-local-chat', () => ({ prepareLocalFirstCommand: mocks.prepare }));
vi.mock('../../lib/chat-runtime-route', () => ({
  selectedRuntimeRoute: () => ({ harness: 'codex' }),
  runtimeModelAccounts: () => [],
}));
vi.mock('../../lib/api-fetch', () => ({
  apiFetch: mocks.request,
  AUTH_LOST_EVENT: 'auth-lost',
  AUTH_RESTORED_EVENT: 'auth-restored',
  CONVERSATION_JOINING_RECOVERY_PREFIX: 'joining:',
}));
vi.mock('../AccountModelPicker', () => ({
  AccountModelPicker: () => <span>Original account</span>,
}));
vi.mock('../ChatExecutionPicker', () => ({ ChatExecutionPicker: () => <span>Local Mac</span> }));
vi.mock('../ChatAgentProfilePicker', () => ({ ChatAgentProfilePicker: () => <span>Agent</span> }));
vi.mock('../RepositoryChatPicker', () => ({
  RepositoryChatPicker: ({
    onChange,
  }: {
    onChange(value: { repositoryWorkspaceId: string; blocked: boolean }): void;
  }) => (
    <button
      onClick={() =>
        onChange({ repositoryWorkspaceId: '7aa6a744-d27c-4eca-a49c-bde6c305ab10', blocked: false })
      }
    >
      Prepare native workspace
    </button>
  ),
}));
vi.mock('../HomeDialog', () => ({
  HomeDialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
}));
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
});

function fixture(beforeOpenNative?: () => boolean) {
  const binding = {
    version: 2 as const,
    account: { accountId: 'source-account', provider: 'openai' as const, profileRevision: 'r1' },
    harness: { implementation: 'responses' as const },
    execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'r1' },
  };
  const command = {
    runOn: 'local',
    repositoryWorkspaceId: '7aa6a744-d27c-4eca-a49c-bde6c305ab10',
    clientMsgId: 'new-command',
    capabilityRevision: 'cap-r1',
    runtime: { account: binding.account, harness: 'codex', targetId: 'mac', mode: 'agent' },
    selection: {
      version: 1,
      agent: { profileId: 'agent', revision: 1 },
      context: { source: 'none', revision: null },
      permission: { mode: 'agent', revision: 0 },
      model: 'new-model',
      thinking: null,
    },
    payload: { text: 'Inspect actual state' },
  };
  const review = {
    reviewHash: 'a'.repeat(64),
    sourceSessionId: 'legacy-source',
    nativeSessionId: 'native-child',
    commandId: 'new-command',
    sourceRevision: 'b'.repeat(64),
    account: binding.account,
    sourceSelection: { model: 'old-model', thinking: null, mode: 'agent', targetId: 'mac' },
    command,
    uncertainOutcomes: true,
    selectionChanged: true,
    retainedPendingCommands: 2,
    omittedNonTextBlocks: 3,
    omittedEarlierCharacters: 12,
    context: '["Visible historical text"]',
  };
  mocks.runtime.mockReturnValue({
    intent: {
      version: 1,
      account: { accountId: 'source-account', model: 'new-model', reasoningEffort: null },
      accountReference: binding.account,
      execution: { location: 'local', targetId: 'mac' },
      agentProfile: { profileId: 'agent', revision: 1 },
      capabilityRevision: 'cap-r1',
    },
    inventory: { agentProfiles: [], accounts: [], routes: [] },
    visible: true,
    reason: undefined,
    update: vi.fn(),
    refresh: vi.fn(),
  });
  mocks.prepare.mockReturnValue({ request: command });
  mocks.request.mockResolvedValue(new Response(JSON.stringify(review)));
  const store = createTestStore();
  store.setState({
    connection: { ...store.getState().connection, clientId: 'connection', status: 'connected' },
  });
  render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter>
        <LegacyNativeContinuation
          sourceSessionId="legacy-source"
          binding={binding}
          model="old-model"
          thinking={null}
          mode="agent"
          beforeOpenNative={beforeOpenNative}
        />
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  return { review, command };
}

it.each([true, undefined, false])(
  'offers pre-runtime migration only after native absence is known (%s)',
  async (hasNativeCodexConversation) => {
    fixture();
    cleanup();
    let observed = false;
    mocks.request.mockImplementationOnce(async () => {
      observed = true;
      return new Response(
        JSON.stringify({
          sessionId: 'older-chat',
          cwd: '/sandbox/workspaces/mgmt',
          accountBinding: {
            accountId: 'work',
            provider: 'openai',
            accountLabel: 'Work',
            model: 'offline-fixture',
            profileRevision: 'r1',
          },
          mode: 'agent',
          hasNativeCodexConversation,
        }),
      );
    });
    const store = createTestStore();
    render(
      <MitzoStoreProvider value={store}>
        <MemoryRouter>
          <LegacyNativeContinuation
            sourceSessionId="older-chat"
            binding={null}
            model="offline-fixture"
            thinking={null}
            mode="agent"
          />
        </MemoryRouter>
      </MitzoStoreProvider>,
    );
    await waitFor(() => expect(observed).toBe(true));
    await act(async () => {});
    if (hasNativeCodexConversation === false)
      expect(screen.getByRole('button', { name: 'Continue with Codex' })).toBeTruthy();
    else expect(screen.queryByText(/Historical Responses execution is retired/)).toBeNull();
  },
);

it('requires review of displayed context and explicit uncertainty and changed-selection acknowledgements', async () => {
  fixture();
  fireEvent.click(screen.getByRole('button', { name: 'Continue with Codex' }));
  fireEvent.click(screen.getByRole('button', { name: 'Prepare native workspace' }));
  fireEvent.change(screen.getByLabelText('New request'), {
    target: { value: 'Inspect actual state' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Review native continuation' }));
  await screen.findByText('["Visible historical text"]');
  const confirm = screen.getByRole('button', { name: 'Start reviewed native continuation' });
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/I reviewed the exact context/));
  fireEvent.click(screen.getByLabelText(/I understand earlier effects/));
  fireEvent.click(screen.getByLabelText(/I approve the displayed model/));
  await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
  expect(mocks.request).toHaveBeenCalledTimes(1);
});

it('keeps the source conversation when its original draft cannot be saved', async () => {
  const save = vi.fn(() => false);
  fixture(save);
  fireEvent.click(screen.getByRole('button', { name: 'Continue with Codex' }));
  fireEvent.click(screen.getByRole('button', { name: 'Prepare native workspace' }));
  fireEvent.change(screen.getByLabelText('New request'), {
    target: { value: 'Inspect actual state' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Review native continuation' }));
  await screen.findByText('["Visible historical text"]');
  fireEvent.click(screen.getByLabelText(/I reviewed the exact context/));
  fireEvent.click(screen.getByLabelText(/I understand earlier effects/));
  fireEvent.click(screen.getByLabelText(/I approve the displayed model/));
  fireEvent.click(screen.getByRole('button', { name: 'Start reviewed native continuation' }));
  await screen.findByText(/Could not save the original conversation draft/);
  expect(save).toHaveBeenCalledTimes(1);
  expect(mocks.request).toHaveBeenCalledTimes(1);
});

it('does not restore a delayed review after the authenticated login changes', async () => {
  const { review } = fixture();
  let finish!: (response: Response) => void;
  mocks.request.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Continue with Codex' }));
  fireEvent.click(screen.getByRole('button', { name: 'Prepare native workspace' }));
  fireEvent.change(screen.getByLabelText('New request'), {
    target: { value: 'Inspect actual state' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Review native continuation' }));
  act(() => window.dispatchEvent(new Event('auth-lost')));
  await act(async () => finish(new Response(JSON.stringify(review))));
  fireEvent.click(screen.getByRole('button', { name: 'Continue with Codex' }));
  expect(screen.queryByText('["Visible historical text"]')).toBeNull();
  expect(sessionStorage.getItem('joining:legacy-native:legacy-source')).toBeNull();
});

it.each(['expired', 'stale'])(
  'allows a fresh review only after the backend confirms and discards an unclaimed %s attempt',
  async () => {
    const { review } = fixture();
    mocks.request.mockImplementation(async (url: string, input?: RequestInit) => {
      if (url.endsWith('/preview')) return new Response(JSON.stringify(review));
      if (url.endsWith('/commit'))
        return new Response(JSON.stringify({ error: 'Review unavailable' }), { status: 409 });
      if (url.endsWith('/discard'))
        return new Response(
          JSON.stringify({
            reviewHash: review.reviewHash,
            sourceSessionId: review.sourceSessionId,
            nativeSessionId: review.nativeSessionId,
            commandId: review.commandId,
            state: 'discarded',
          }),
        );
      expect(input?.method ?? 'GET').toBe('GET');
      return new Response(
        JSON.stringify({
          links: [
            {
              reviewHash: review.reviewHash,
              sourceSessionId: review.sourceSessionId,
              nativeSessionId: review.nativeSessionId,
              commandId: review.commandId,
              state: 'reviewed',
              createdAt: 1,
              canReviewAgain: true,
            },
          ],
        }),
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Codex' }));
    fireEvent.click(screen.getByRole('button', { name: 'Prepare native workspace' }));
    fireEvent.change(screen.getByLabelText('New request'), {
      target: { value: 'Inspect actual state' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review native continuation' }));
    await screen.findByText('["Visible historical text"]');
    fireEvent.click(screen.getByLabelText(/I reviewed the exact context/));
    fireEvent.click(screen.getByLabelText(/I understand earlier effects/));
    fireEvent.click(screen.getByLabelText(/I approve the displayed model/));
    fireEvent.click(screen.getByRole('button', { name: 'Start reviewed native continuation' }));
    const discard = await screen.findByRole('button', {
      name: 'Discard rejected attempt and review again',
    });
    fireEvent.click(discard);
    await screen.findByRole('button', { name: 'Review native continuation' });
    expect((screen.getByLabelText('New request') as HTMLTextAreaElement).value).toBe(
      'Inspect actual state',
    );
    expect(mocks.request.mock.calls.filter(([url]) => url.endsWith('/commit'))).toHaveLength(1);
    expect(mocks.request.mock.calls.filter(([url]) => url.endsWith('/discard'))).toHaveLength(1);
  },
);

it('explains missing legacy execution details without claiming that zero commands were pending', async () => {
  const { review } = fixture();
  mocks.request.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        ...review,
        historicalStateUnavailable: true,
        retainedPendingCommands: 0,
      }),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Continue with Codex' }));
  fireEvent.click(screen.getByRole('button', { name: 'Prepare native workspace' }));
  fireEvent.change(screen.getByLabelText('New request'), {
    target: { value: 'Inspect actual state' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Review native continuation' }));
  expect(
    await screen.findByText(/Earlier queued work cannot be counted from the saved conversation/),
  ).toBeTruthy();
  expect(screen.queryByText(/0 pending commands remain/)).toBeNull();
  expect(
    (
      screen.getByRole('button', {
        name: 'Start reviewed native continuation',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
