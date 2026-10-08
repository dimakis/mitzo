// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { NewSymposium } from '../NewSymposium';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
const pendingProfiles = vi.hoisted(() => ({
  save: undefined as ((value: unknown) => void) | undefined,
  import: undefined as ((value: unknown) => void) | undefined,
}));
vi.mock('../AccountModelPicker', () => ({
  AccountModelPicker: ({
    scope,
    onChange,
  }: {
    scope: string;
    onChange: (value: unknown) => void;
  }) => {
    expect(scope).toBe('symposium');
    return (
      <button
        onClick={() =>
          onChange({ accountId: 'work', model: 'gpt-5.6-luna', reasoningEffort: null })
        }
      >
        Select owned work Luna
      </button>
    );
  },
}));
vi.mock('../SymposiumProfilePicker', () => ({
  SymposiumProfilePicker: ({
    onChange,
    requiredRole,
  }: {
    onChange: (value: unknown) => void;
    requiredRole?: string;
  }) => (
    <>
      <button
        onClick={() =>
          onChange({ profileId: requiredRole === 'reviewer' ? 'reviewer' : 'builder', revision: 2 })
        }
      >
        Select saved {requiredRole === 'reviewer' ? 'reviewer' : 'builder'}
      </button>
      <button
        onClick={() => {
          pendingProfiles.save = onChange;
        }}
      >
        Start profile save
      </button>
      <button
        onClick={() => {
          pendingProfiles.import = onChange;
        }}
      >
        Start profile import
      </button>
    </>
  ),
}));
function Location() {
  return <output aria-label="Location">{useLocation().pathname}</output>;
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  pendingProfiles.save = undefined;
  pendingProfiles.import = undefined;
});
it('opens before an ordinary account exists, selects dedicated account/profile and navigates without a prompt', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({ sessionId: 'new-symposium' }),
  } as Response);
  render(
    <MemoryRouter initialEntries={['/chat']}>
      <NewSymposium />
      <Location />
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'New Symposium' }));
  const create = screen.getByRole('button', { name: 'Create Symposium draft' });
  expect(create.hasAttribute('disabled')).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: 'Select owned work Luna' }));
  await userEvent.click(screen.getByRole('button', { name: 'Select saved builder' }));
  await userEvent.click(create);
  await waitFor(() =>
    expect(screen.getByLabelText('Location').textContent).toBe('/chat/new-symposium'),
  );
  expect(apiFetch).toHaveBeenCalledTimes(1);
  const [url, init] = vi.mocked(apiFetch).mock.calls[0];
  expect(url).toBe('/api/symposium/sessions');
  expect(JSON.parse(init!.body as string)).toEqual({
    idempotencyKey: expect.any(String),
    title: 'Symposium',
    accountId: 'work',
    model: 'gpt-5.6-luna',
    reasoningEffort: null,
    role: 'coder',
    profileSelection: { profileId: 'builder', revision: 2 },
  });
});
it('retains idempotency after uncertain failure and shows account/profile rejection without navigating', async () => {
  vi.mocked(apiFetch)
    .mockRejectedValueOnce(new Error('Connection interrupted'))
    .mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Account unavailable' }),
    } as Response);
  render(
    <MemoryRouter>
      <NewSymposium />
      <Location />
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'New Symposium' }));
  await userEvent.click(screen.getByRole('button', { name: 'Select owned work Luna' }));
  await userEvent.click(screen.getByRole('button', { name: 'Select saved builder' }));
  await userEvent.click(screen.getByRole('button', { name: 'Create Symposium draft' }));
  await screen.findByText('Connection interrupted');
  await userEvent.click(screen.getByRole('button', { name: 'Create Symposium draft' }));
  await screen.findByText('Account unavailable');
  const bodies = vi.mocked(apiFetch).mock.calls.map(([, init]) => JSON.parse(init!.body as string));
  expect(bodies[1].idempotencyKey).toBe(bodies[0].idempotencyKey);
  expect(screen.getByLabelText('Location').textContent).toBe('/');
});

it('requires a matching profile after changing the first role without discarding account selection', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({ sessionId: 'reviewer-draft' }),
  } as Response);
  render(
    <MemoryRouter>
      <NewSymposium />
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'New Symposium' }));
  await userEvent.click(screen.getByRole('button', { name: 'Select owned work Luna' }));
  await userEvent.click(screen.getByRole('button', { name: 'Select saved builder' }));
  await userEvent.selectOptions(screen.getByLabelText('First seat role'), 'reviewer');
  const create = screen.getByRole('button', { name: 'Create Symposium draft' });
  expect(create.hasAttribute('disabled')).toBe(true);
  expect(apiFetch).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Select saved reviewer' }));
  expect(create.hasAttribute('disabled')).toBe(false);
  await userEvent.click(create);
  expect(JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string)).toMatchObject({
    accountId: 'work',
    role: 'reviewer',
    profileSelection: { profileId: 'reviewer', revision: 2 },
  });
});

it.each([
  ['save', false],
  ['import', false],
  ['save', true],
  ['import', true],
] as const)(
  'ignores late profile %s after role change (round trip: %s)',
  async (operation, roundTrip) => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ sessionId: 'fresh-draft' }),
    } as Response);
    render(
      <MemoryRouter>
        <NewSymposium />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'New Symposium' }));
    await userEvent.click(screen.getByRole('button', { name: 'Select owned work Luna' }));
    await userEvent.click(screen.getByRole('button', { name: `Start profile ${operation}` }));
    await userEvent.selectOptions(screen.getByLabelText('First seat role'), 'reviewer');
    if (roundTrip) await userEvent.selectOptions(screen.getByLabelText('First seat role'), 'coder');
    act(() => pendingProfiles[operation]!({ profileId: 'old-builder', revision: 2 }));
    const create = screen.getByRole('button', { name: 'Create Symposium draft' });
    expect(create.hasAttribute('disabled')).toBe(true);
    await userEvent.click(create);
    expect(apiFetch).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole('button', {
        name: roundTrip ? 'Select saved builder' : 'Select saved reviewer',
      }),
    );
    // A late completion must also leave the current selection untouched.
    act(() => pendingProfiles[operation]!({ profileId: 'old-builder', revision: 2 }));
    await userEvent.click(create);
    expect(JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string)).toMatchObject({
      accountId: 'work',
      role: roundTrip ? 'coder' : 'reviewer',
      profileSelection: { profileId: roundTrip ? 'builder' : 'reviewer', revision: 2 },
    });
  },
);
it('keeps a pending draft accessible and retries its shared files without creating another session', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sessionId: 'pending', artifacts: { state: 'recovery_required' } }),
    } as Response)
    .mockResolvedValueOnce({ ok: true, json: async () => ({ state: 'ready' }) } as Response);
  render(
    <MemoryRouter>
      <NewSymposium />
      <Location />
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'New Symposium' }));
  await userEvent.click(screen.getByRole('button', { name: 'Select owned work Luna' }));
  await userEvent.click(screen.getByRole('button', { name: 'Select saved builder' }));
  await userEvent.click(screen.getByRole('button', { name: 'Create Symposium draft' }));
  await screen.findByRole('button', { name: 'Open draft' });
  expect(screen.getByLabelText('Location').textContent).toBe('/');
  await userEvent.click(screen.getByRole('button', { name: 'Retry shared files' }));
  await waitFor(() => expect(screen.getByLabelText('Location').textContent).toBe('/chat/pending'));
  expect(vi.mocked(apiFetch).mock.calls[1][0]).toBe('/api/symposium/sessions/pending/artifacts');
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('keeps a quarantined draft accessible and directs the operator without offering a retry', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      sessionId: 'quarantined',
      artifacts: {
        state: 'recovery_required',
        nextAction: 'operator_reconcile_retained_artifact',
      },
    }),
  } as Response);
  render(
    <MemoryRouter>
      <NewSymposium />
      <Location />
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'New Symposium' }));
  await userEvent.click(screen.getByRole('button', { name: 'Select owned work Luna' }));
  await userEvent.click(screen.getByRole('button', { name: 'Select saved builder' }));
  await userEvent.click(screen.getByRole('button', { name: 'Create Symposium draft' }));
  expect(await screen.findByRole('button', { name: 'Open draft' })).toBeTruthy();
  expect(screen.getByText(/ask an operator to reconcile the retained shared files/i)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Retry shared files' })).toBeNull();
  expect(screen.getByLabelText('Location').textContent).toBe('/');
  expect(apiFetch).toHaveBeenCalledTimes(1);
});
