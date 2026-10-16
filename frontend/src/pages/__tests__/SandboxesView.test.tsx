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
  fireEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[1]);
  await screen.findByText('Cleanup is blocked: active session.');
  await act(async () => resolveA({ token: 'a', action: 'delete', blockers: [] }));
  expect(screen.queryByRole('button', { name: 'Delete retained sandbox' })).toBeNull();
  expect(screen.getByText('Cleanup is blocked: active session.')).toBeTruthy();
});
