// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { apiFetch } from '../../lib/api-fetch';
import { SymposiumDirectorPanel } from '../SymposiumDirectorPanel';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../AccountModelPicker', () => ({
  AccountModelPicker: ({ onChange }: { onChange: (value: unknown) => void }) => (
    <button type="button" onClick={() => onChange({ accountId: 'openai-work', model: 'gpt' })}>
      Select OpenAI model
    </button>
  ),
}));
vi.mock('../SymposiumProfilePicker', () => ({
  SymposiumProfilePicker: ({ onChange }: { onChange: (value: unknown) => void }) => (
    <button type="button" onClick={() => onChange({ profileId: 'owner-review', revision: 2 })}>
      Select saved profile
    </button>
  ),
}));

const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
const config = {
  version: 2,
  revision: 4,
  state: 'active',
  anchorSeatId: 'architect',
  activeSeatCap: 3,
  seats: [
    {
      id: 'architect',
      name: 'Architect',
      role: 'architect',
      model: 'claude-sonnet',
      color: '#335577',
      systemPrompt: '',
      accountBinding: {
        accountId: 'claude-work',
        accountLabel: 'Claude work',
        provider: 'anthropic-vertex',
        model: 'claude-sonnet',
        profileRevision: 'rev-1',
      },
    },
    {
      id: 'reviewer',
      name: 'Reviewer',
      role: 'reviewer',
      model: 'gpt',
      color: '#557733',
      systemPrompt: '',
      accountBinding: {
        accountId: 'openai-work',
        accountLabel: 'OpenAI work',
        provider: 'openai',
        model: 'gpt',
        profileRevision: 'rev-2',
      },
    },
  ],
  turnRules: { mode: 'directed', maxTurns: 8 },
  interceptMode: 'manual',
};
const status = (admitted: boolean) => ({
  sessionId: 'session',
  config,
  runtimeAvailable: admitted,
  reservedSeats: 2,
  capacityRemaining: 1,
  sharedBoundary: { trustDomainId: 'shared', placement: 'reuse-compatible' },
  admissions: [],
  deliveries: [],
  seats: config.seats.map((seat) => ({
    seatId: seat.id,
    seat,
    admitted,
    membership: {
      generation: 1,
      state: 'active',
      reconciliation: admitted ? 'confirmed' : 'pending',
    },
    admission: null,
  })),
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it('shows distinct seat accounts and does not offer dispatch while runtime admission is pending', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response(status(false)));
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Director controls' }));
  expect(await screen.findByText(/Claude work · claude-sonnet/)).toBeTruthy();
  expect(screen.getByText(/OpenAI work · gpt/)).toBeTruthy();
  expect(screen.getAllByText(/Pending runtime admission/)).toHaveLength(2);
  expect(
    screen.getByRole('button', { name: 'Inject to selected seats' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(screen.getAllByRole('button', { name: 'Suspend' })).toHaveLength(2);
  expect(screen.getByText(/Shared artifacts and provider account retention/)).toBeTruthy();
});

it('injects only explicitly selected admitted recipients', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(response(status(true)))
    .mockResolvedValueOnce(response({ deliveryId: 'delivery-1' }))
    .mockResolvedValueOnce(response(status(true)));
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Director controls' }));
  await screen.findByText(/OpenAI work · gpt/);
  await userEvent.click(screen.getByRole('checkbox', { name: 'Send to Reviewer' }));
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Director message' }),
    'Review this patch',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Inject to selected seats' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
  const [, request] = vi.mocked(apiFetch).mock.calls[1];
  expect(JSON.parse(String(request?.body))).toMatchObject({
    sourceSeatId: null,
    recipientSeatIds: ['reviewer'],
    originalContent: 'Review this patch',
  });
});

it('adds a configured seat to a draft using a server-resolved account binding', async () => {
  const draft = { ...status(false), config: { ...config, state: 'draft' } };
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(response(draft))
    .mockResolvedValueOnce(response({ binding: config.seats[1].accountBinding }))
    .mockResolvedValueOnce(response({ ok: true }))
    .mockResolvedValueOnce(response(draft));
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Director controls' }));
  await screen.findByText(/Draft — provider seats are not admitted/);
  await userEvent.type(screen.getByRole('textbox', { name: 'New seat name' }), 'Builder');
  await userEvent.type(screen.getByRole('textbox', { name: 'New seat ID' }), 'builder');
  await userEvent.click(screen.getAllByRole('button', { name: 'Select OpenAI model' }).at(-1)!);
  await userEvent.click(screen.getByRole('button', { name: 'Add configured seat' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(4));
  const [, put] = vi.mocked(apiFetch).mock.calls[2];
  expect(JSON.parse(String(put?.body)).config).toMatchObject({
    revision: 5,
    seats: [
      ...config.seats,
      {
        id: 'builder',
        name: 'Builder',
        role: 'implementer',
        accountBinding: { accountId: 'openai-work' },
      },
    ],
  });
});

it('starts a draft from an existing conversation without sending a fabricated grant', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(
      response({
        sessionId: 'session',
        config: null,
        seats: [],
        deliveries: [],
        runtimeAvailable: false,
      }),
    )
    .mockResolvedValueOnce(response({ ...config, state: 'draft' }))
    .mockResolvedValueOnce(response({ ...status(false), config: { ...config, state: 'draft' } }));
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Director controls' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Create draft Symposium' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
  const [, request] = vi.mocked(apiFetch).mock.calls[1];
  expect(request).toMatchObject({ method: 'POST', body: '{}' });
});

it('activates a mixed-account draft only with explicit boundary acknowledgement and typed confirmation', async () => {
  const draft = { ...status(false), config: { ...config, state: 'draft' } };
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(response(draft))
    .mockResolvedValueOnce(response({ ...config, revision: 5 }))
    .mockResolvedValueOnce(response(status(false)));
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Director controls' }));
  await screen.findByText(/Draft — provider seats are not admitted/);
  const activate = screen.getByRole('button', { name: 'Activate roster' });
  expect(activate.hasAttribute('disabled')).toBe(true);
  await userEvent.click(
    screen.getByRole('checkbox', { name: /I acknowledge the shared artifacts/ }),
  );
  await userEvent.type(
    screen.getByRole('textbox', { name: /To add a seat on another account/ }),
    'ADD CROSS-ACCOUNT SEAT',
  );
  await userEvent.click(activate);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
  const [, request] = vi.mocked(apiFetch).mock.calls[1];
  expect(JSON.parse(String(request?.body))).toEqual({
    expectedRevision: 4,
    sharedBoundaryAcknowledged: true,
    crossAccountConfirmation: 'ADD CROSS-ACCOUNT SEAT',
  });
});

it('sends saved profile selection outside draft seat config only when host binding is enforced', async () => {
  const draft = {
    ...status(false),
    profileBindingEnforced: true,
    config: { ...config, state: 'draft' },
  };
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(response(draft))
    .mockResolvedValueOnce(response({ ...config, revision: 5 }))
    .mockResolvedValueOnce(response(draft));
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Director controls' }));
  await screen.findByText(/Draft — provider seats are not admitted/);
  await userEvent.click(screen.getAllByRole('button', { name: 'Select saved profile' })[1]);
  await userEvent.click(
    screen.getByRole('checkbox', { name: /I acknowledge the shared artifacts/ }),
  );
  await userEvent.type(
    screen.getByRole('textbox', { name: /To add a seat on another account/ }),
    'ADD CROSS-ACCOUNT SEAT',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Activate roster' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
  const [, request] = vi.mocked(apiFetch).mock.calls[1];
  expect(JSON.parse(String(request?.body)).profileSelections).toEqual({
    reviewer: { profileId: 'owner-review', revision: 2 },
  });
  expect(draft.config.seats[1]).not.toHaveProperty('profileSelection');
});

it('adds an active-roster seat through host grant revision without sending grant IDs', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(response(status(true)))
    .mockResolvedValueOnce(response({ ...config, revision: 5 }))
    .mockResolvedValueOnce(response(status(true)));
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Director controls' }));
  await screen.findByText(/OpenAI work · gpt/);
  await userEvent.type(screen.getByRole('textbox', { name: 'New seat name' }), 'Builder');
  await userEvent.type(screen.getByRole('textbox', { name: 'New seat ID' }), 'builder');
  await userEvent.click(screen.getAllByRole('button', { name: 'Select OpenAI model' }).at(-1)!);
  await userEvent.click(
    screen.getByRole('checkbox', { name: /I acknowledge the shared artifacts/ }),
  );
  await userEvent.type(
    screen.getByRole('textbox', { name: /To add a seat on another account/ }),
    'ADD CROSS-ACCOUNT SEAT',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Add configured seat' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
  const [path, request] = vi.mocked(apiFetch).mock.calls[1];
  expect(path).toContain('/seats/revise');
  const body = JSON.parse(String(request?.body));
  expect(body).toMatchObject({
    seatId: 'builder',
    accountId: 'openai-work',
    model: 'gpt',
    crossAccountConfirmation: 'ADD CROSS-ACCOUNT SEAT',
  });
  expect(JSON.stringify(body)).not.toMatch(/authorityGrant|contextGrant|isolationRequest/);
});

it.each(['resolve', 'reject'] as const)(
  'ignores an old session status request that completes with %s after navigation',
  async (completion) => {
    let resolveOld!: (value: Response) => void;
    let rejectOld!: (reason: Error) => void;
    const oldRequest = new Promise<Response>((resolve, reject) => {
      resolveOld = resolve;
      rejectOld = reject;
    });
    vi.mocked(apiFetch)
      .mockReturnValueOnce(oldRequest)
      .mockResolvedValueOnce(response({ ...status(true), sessionId: 'next', config: null }));
    const { rerender } = render(<SymposiumDirectorPanel sessionId="session" />);
    await userEvent.click(screen.getByRole('button', { name: 'Director controls' }));
    rerender(<SymposiumDirectorPanel sessionId="next" />);
    await screen.findByText('This conversation has no Symposium roster.');
    await act(async () => {
      if (completion === 'resolve') resolveOld(response(status(true)));
      else rejectOld(new Error('Old session failed'));
    });
    expect(screen.getByText('This conversation has no Symposium roster.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Suspend' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(apiFetch).toHaveBeenLastCalledWith('/api/sessions/next/symposium', undefined);
  },
);

it('clears the previous session roster and form state immediately on navigation', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(response(status(true)))
    .mockResolvedValueOnce(response({ ...status(true), sessionId: 'next' }));
  const { rerender } = render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Director controls' }));
  await screen.findByText(/OpenAI work · gpt/);
  await userEvent.click(screen.getByRole('checkbox', { name: 'Send to Reviewer' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Director message' }), 'Old message');
  rerender(<SymposiumDirectorPanel sessionId="next" />);
  expect(screen.queryByRole('button', { name: 'Suspend' })).toBeNull();
  await screen.findByText(/OpenAI work · gpt/);
  expect(
    (screen.getByRole('textbox', { name: 'Director message' }) as HTMLTextAreaElement).value,
  ).toBe('');
  expect(
    (screen.getByRole('checkbox', { name: 'Send to Reviewer' }) as HTMLInputElement).checked,
  ).toBe(false);
});

it('refreshes externally queued deliveries without closing director controls', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(response(status(true)))
    .mockResolvedValueOnce(
      response({
        ...status(true),
        deliveries: [
          {
            deliveryId: 'audience-delivery',
            recipientSeatIds: ['reviewer'],
            status: 'awaiting_intervention',
            originalContent: 'Queued from the audience composer',
          },
        ],
      }),
    );
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Director controls' }));
  await screen.findByText(/OpenAI work · gpt/);
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Refresh director status' }));
  expect(await screen.findByText('Queued from the audience composer')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Director controls' }).getAttribute('aria-expanded'),
  ).toBe('true');
});

it('keeps old mutation completion and its refresh isolated from the new session', async () => {
  let resolveMutation!: (value: Response) => void;
  const mutation = new Promise<Response>((resolve) => {
    resolveMutation = resolve;
  });
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(response(status(true)))
    .mockReturnValueOnce(mutation)
    .mockResolvedValueOnce(response({ ...status(true), sessionId: 'next', config: null }))
    .mockResolvedValueOnce(response(status(true)));
  const { rerender } = render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Director controls' }));
  await screen.findByText(/OpenAI work · gpt/);
  await userEvent.click(screen.getAllByRole('button', { name: 'Suspend' })[1]);
  rerender(<SymposiumDirectorPanel sessionId="next" />);
  await screen.findByText('This conversation has no Symposium roster.');
  await act(async () => {
    resolveMutation(response({ ok: true }));
  });
  expect(screen.getByText('This conversation has no Symposium roster.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Suspend' })).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Create draft Symposium' }).hasAttribute('disabled'),
  ).toBe(false);
});
