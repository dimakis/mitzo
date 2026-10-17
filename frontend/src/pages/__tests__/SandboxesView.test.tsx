import type { ReactNode } from 'react';
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SandboxesView } from '../SandboxesView';
import { readApiJson } from '../../lib/api-json-read';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../components/HomeDialog', () => ({
  HomeDialog: ({
    title,
    onClose,
    children,
  }: {
    title: string;
    onClose(): void;
    children: ReactNode;
  }) => (
    <section role="dialog" aria-label={title}>
      <button onClick={onClose}>Close</button>
      {children}
    </section>
  ),
}));
vi.mock('../../lib/api-json-read', () => ({ readApiJson: vi.fn() }));
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
const snapshot = {
  revision: 1,
  settings: {
    enabled: false,
    capacity: 1,
    refill: 'auto',
    expiryMinutes: 120,
    cpu: 2,
    memoryGiB: 4,
  },
  available: true,
  reason: null,
  busy: false,
  resting: false,
  spares: [],
  owned: [],
  conversations: [],
  capabilities: { cpu: true, memory: true, disk: false, diskReason: 'Disk limits unavailable.' },
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function mount() {
  render(
    <MemoryRouter>
      <SandboxesView />
    </MemoryRouter>,
  );
}
it('shows physical counts and historical sandboxes independently of the conversation ledger', async () => {
  vi.mocked(readApiJson).mockResolvedValue({
    ...snapshot,
    physicalInventory: {
      available: true,
      total: 122,
      counts: { Ready: 42, Stopped: 74, Error: 6 },
      items: [
        { id: 'old', name: 'historical-sandbox', state: 'Stopped', management: 'needs_review' },
      ],
    },
  });
  mount();
  await screen.findByText('122 sandboxes on this gateway');
  expect(screen.getByText(/42 Ready.*74 Stopped.*6 Error/)).toBeTruthy();
  expect(screen.getByText('historical-sandbox')).toBeTruthy();
});
it('makes immediate deletion a separately reviewed action and exposes retention consent', async () => {
  const item = {
    conversationId: 'c',
    sandboxName: 'sandbox-c',
    state: 'retained',
    title: 'My chat',
    account: 'Work',
    canReviewCleanup: true,
  };
  vi.mocked(readApiJson).mockImplementation(async (path) =>
    path === '/api/sandboxes'
      ? { ...snapshot, conversations: [item] }
      : {
          token: path.includes('intent=delete') ? 'delete-review' : 'stop-review',
          action: path.includes('intent=delete') ? 'stop_and_delete' : 'stop',
          blockers: [],
          retention: { enabled: false, days: 7, deleteAfter: null },
        },
  );
  vi.mocked(apiFetch).mockResolvedValue(new Response('{}', { status: 200 }));
  mount();
  await screen.findByText('My chat');
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Delete sandbox…' }));
  await screen.findByText(/without the retention wait/);
  expect(apiFetch).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByLabelText('I reviewed this lifecycle action and its effect on sandbox files.'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Delete sandbox' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
  expect(JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string)).toEqual({
    token: 'delete-review',
  });
});
it('reads inventory without mutation and exposes editable settings with truthful disk availability', async () => {
  vi.mocked(readApiJson).mockResolvedValue(snapshot);
  mount();
  await screen.findByLabelText('Warm spares');
  expect(apiFetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Resources per sandbox' }));
  expect((screen.getByLabelText('Disk') as HTMLSelectElement).disabled).toBe(true);
  expect(screen.getByText('Disk limits unavailable.')).toBeTruthy();
});
it('Cancel discards configuration edits without a write', async () => {
  vi.mocked(readApiJson).mockResolvedValue(snapshot);
  mount();
  await screen.findByLabelText('Warm spares');
  fireEvent.change(screen.getByLabelText('Warm spares'), { target: { value: '2' } });
  expect(screen.getByText('Unsaved changes')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect((screen.getByLabelText('Warm spares') as HTMLSelectElement).value).toBe('1');
  expect(apiFetch).not.toHaveBeenCalled();
});
it('saves a revision-fenced configuration once and disables duplicate submission', async () => {
  vi.mocked(readApiJson).mockResolvedValue(snapshot);
  let settle!: (r: Response) => void;
  vi.mocked(apiFetch).mockImplementation(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  mount();
  await screen.findByLabelText('Warm spares');
  fireEvent.change(screen.getByLabelText('Warm spares'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
  expect((screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  const body = JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string);
  expect(body).toMatchObject({
    action: 'settings',
    revision: 1,
    settings: { capacity: 2, enabled: false },
  });
  expect(body.requestId).toBeTypeOf('string');
  vi.mocked(readApiJson).mockResolvedValue({
    ...snapshot,
    revision: 2,
    settings: { ...snapshot.settings, capacity: 2 },
  });
  settle(new Response(JSON.stringify({ ...snapshot, revision: 2 }), { status: 200 }));
  await screen.findByText('Sandbox settings saved.');
});
it('a failed save retains edited values and exposes the server refusal without automatic replay', async () => {
  vi.mocked(readApiJson).mockResolvedValue(snapshot);
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(
      JSON.stringify({ error: 'Settings changed elsewhere. Refresh before retrying.' }),
      { status: 409 },
    ),
  );
  mount();
  await screen.findByLabelText('Warm spares');
  fireEvent.change(screen.getByLabelText('Warm spares'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await screen.findByText('Settings changed elsewhere. Refresh before retrying.');
  expect((screen.getByLabelText('Warm spares') as HTMLSelectElement).value).toBe('2');
  expect(apiFetch).toHaveBeenCalledOnce();
});

it('cannot apply a late cleanup preview to a different selected conversation', async () => {
  let resolveA!: (value: unknown) => void;
  const conversations = ['a', 'b'].map((id) => ({
    conversationId: id,
    sandboxName: 'sandbox-' + id,
    state: 'retained',
    title: 'Conversation ' + id,
    account: 'Work',
    canReviewCleanup: true,
  }));
  vi.mocked(readApiJson).mockImplementation(async (path) =>
    path === '/api/sandboxes'
      ? { ...snapshot, conversations }
      : path.includes('/a/')
        ? new Promise((resolve) => {
            resolveA = resolve;
          })
        : { token: 'b', action: 'none', blockers: ['active_session'] },
  );
  mount();
  await screen.findByText('Conversation a');
  fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[1]);
  await screen.findByText('Cleanup is blocked: active session.');
  await act(async () => resolveA({ token: 'a', action: 'delete', blockers: [] }));
  expect(screen.queryByRole('button', { name: 'Delete retained sandbox' })).toBeNull();
  expect(screen.getByText('Cleanup is blocked: active session.')).toBeTruthy();
});
it('explicit refresh preserves the refused draft and allows a retry against the fresh revision', async () => {
  vi.mocked(readApiJson).mockResolvedValue(snapshot);
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ error: 'Stale settings. Refresh before retrying.' }), {
      status: 409,
    }),
  );
  mount();
  await screen.findByLabelText('Warm spares');
  fireEvent.change(screen.getByLabelText('Warm spares'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await screen.findByText('Stale settings. Refresh before retrying.');
  vi.mocked(readApiJson).mockResolvedValue({ ...snapshot, revision: 2 });
  fireEvent.click(screen.getByRole('button', { name: 'Retry inventory' }));
  await waitFor(() => expect(vi.mocked(readApiJson).mock.calls.length).toBe(2));
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  expect((screen.getByLabelText('Warm spares') as HTMLSelectElement).value).toBe('2');
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ error: 'Still refused' }), { status: 409 }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
  expect(JSON.parse(vi.mocked(apiFetch).mock.calls[1][1]!.body as string).revision).toBe(2);
});
it('preparing a spare preserves unsaved settings and requires review against the new inventory revision', async () => {
  vi.mocked(readApiJson).mockResolvedValue(snapshot);
  vi.mocked(apiFetch).mockResolvedValue(new Response('{}', { status: 200 }));
  mount();
  await screen.findByLabelText('Warm spares');
  fireEvent.change(screen.getByLabelText('Warm spares'), { target: { value: '2' } });
  vi.mocked(readApiJson).mockResolvedValue({ ...snapshot, revision: 9 });
  fireEvent.click(screen.getByRole('button', { name: 'Prepare now' }));
  await screen.findByText('Pool prepared.');
  expect((screen.getByLabelText('Warm spares') as HTMLSelectElement).value).toBe('2');
  expect(screen.getByText('Unsaved changes')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
  expect(JSON.parse(vi.mocked(apiFetch).mock.calls[1][1]!.body as string).revision).toBe(1);
});
it.each([
  ['paused', 'replace'],
  ['paused', 'remove'],
  ['manual', 'replace'],
  ['manual', 'remove'],
])(
  'exposes guarded %s pool recovery through %s for a verified obsolete spare',
  async (mode, action) => {
    const spare = {
      id: 'old-spare',
      name: 'old-recipe-spare',
      physicalId: 'physical-old',
      state: 'ready',
      observedState: 'unverified',
      canRetire: true,
      resources: { cpu: 2, memoryGiB: 4 },
      failure: 'Sandbox uses an older runtime recipe; replace or remove it.',
    };
    vi.mocked(readApiJson).mockResolvedValue({
      ...snapshot,
      settings: {
        ...snapshot.settings,
        enabled: mode === 'manual',
        refill: mode === 'manual' ? 'manual' : 'auto',
      },
      spares: [spare],
    });
    vi.mocked(apiFetch).mockResolvedValue(new Response('{}', { status: 200 }));
    mount();
    await screen.findByText('Warm spare 1');
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByRole('button', { name: 'Recheck ownership' })).toBeTruthy();
    if (action === 'remove') {
      fireEvent.click(screen.getByRole('button', { name: 'Remove spare' }));
      expect(apiFetch).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Remove spare and pause' }));
    } else fireEvent.click(screen.getByRole('button', { name: 'Replace spare' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string)).toMatchObject({
      action,
      id: spare.id,
      revision: 1,
    });
  },
);
it('keeps retirement hidden for physically unverified or unsettled spares', async () => {
  vi.mocked(readApiJson).mockResolvedValue({
    ...snapshot,
    spares: [
      {
        id: 'unknown',
        name: 'unsettled-spare',
        physicalId: null,
        state: 'uncertain',
        observedState: 'unverified',
        canRetire: false,
        resources: { cpu: 2, memoryGiB: 4 },
        failure: 'Create outcome is unsettled',
      },
    ],
  });
  mount();
  await screen.findByText('Warm spare 1');
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  expect(screen.getByRole('button', { name: 'Recheck ownership' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Remove spare' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Replace spare' })).toBeNull();
});
