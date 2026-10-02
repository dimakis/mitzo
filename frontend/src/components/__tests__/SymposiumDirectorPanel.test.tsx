// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { apiFetch } from '../../lib/api-fetch';
import { SymposiumDirectorPanel } from '../SymposiumDirectorPanel';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../AccountModelPicker', () => ({
  AccountModelPicker: ({
    onChange,
    scope,
  }: {
    onChange: (value: unknown) => void;
    scope: string;
  }) => {
    expect(scope).toBe('symposium');
    return (
      <>
        <button type="button" onClick={() => onChange({ accountId: 'openai-work', model: 'gpt' })}>
          Select OpenAI model
        </button>
        <button
          type="button"
          onClick={() =>
            onChange({ accountId: 'vertex-default', model: 'claude-haiku-4-5@20251001' })
          }
        >
          Select Work Haiku
        </button>
      </>
    );
  },
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
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
  expect(await screen.findByText(/Claude work · claude-sonnet/)).toBeTruthy();
  expect(screen.getByText(/OpenAI work · gpt/)).toBeTruthy();
  expect(screen.getAllByText(/Pending runtime admission/)).toHaveLength(2);
  expect(
    screen.getByRole('button', { name: 'Queue message for approval' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(screen.getAllByRole('button', { name: 'Suspend' })).toHaveLength(1);
  expect(screen.getByText(/Shared artifacts and provider account retention/)).toBeTruthy();
});

it('injects only explicitly selected admitted recipients', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(response(status(true)))
    .mockResolvedValueOnce(response({ deliveryId: 'delivery-1' }))
    .mockResolvedValueOnce(response(status(true)));
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
  await screen.findByText(/OpenAI work · gpt/);
  await userEvent.click(screen.getByRole('checkbox', { name: 'Send to Reviewer' }));
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Message for the selected agents' }),
    'Review this patch',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Queue message for approval' }));
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
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
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
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
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
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
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
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
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
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
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
    await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
    rerender(<SymposiumDirectorPanel sessionId="next" />);
    await screen.findByText(
      'No review team yet. Add a reviewer to get a second opinion on this conversation.',
    );
    await act(async () => {
      if (completion === 'resolve') resolveOld(response(status(true)));
      else rejectOld(new Error('Old session failed'));
    });
    expect(
      screen.getByText(
        'No review team yet. Add a reviewer to get a second opinion on this conversation.',
      ),
    ).toBeTruthy();
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
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
  await screen.findByText(/OpenAI work · gpt/);
  await userEvent.click(screen.getByRole('checkbox', { name: 'Send to Reviewer' }));
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Message for the selected agents' }),
    'Old message',
  );
  rerender(<SymposiumDirectorPanel sessionId="next" />);
  expect(screen.queryByRole('button', { name: 'Suspend' })).toBeNull();
  await screen.findByText(/OpenAI work · gpt/);
  expect(
    (
      screen.getByRole('textbox', {
        name: 'Message for the selected agents',
      }) as HTMLTextAreaElement
    ).value,
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
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
  await screen.findByText(/OpenAI work · gpt/);
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Refresh review team' }));
  expect(await screen.findByText('Queued from the audience composer')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Review team & approvals' }).getAttribute('aria-expanded'),
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
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
  await screen.findByText(/OpenAI work · gpt/);
  await userEvent.click(screen.getByRole('button', { name: 'Suspend' }));
  rerender(<SymposiumDirectorPanel sessionId="next" />);
  await screen.findByText(
    'No review team yet. Add a reviewer to get a second opinion on this conversation.',
  );
  await act(async () => {
    resolveMutation(response({ ok: true }));
  });
  expect(
    screen.getByText(
      'No review team yet. Add a reviewer to get a second opinion on this conversation.',
    ),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Suspend' })).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Create draft Symposium' }).hasAttribute('disabled'),
  ).toBe(false);
});

it('recovers shared files from a reopened saved draft without activating or dispatching', async () => {
  const draft = { ...status(false), config: { ...config, state: 'draft' } };
  let ready = false;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method === 'POST') {
      expect(path).toBe('/api/symposium/sessions/session/artifacts');
      expect(init.body).toBe('{}');
      return response({ state: ready ? 'ready' : 'recovery_required' });
    }
    return response(draft);
  });
  const mounted = render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
  await userEvent.click(
    await screen.findByRole('button', { name: 'Prepare or retry shared files' }),
  );
  expect(await screen.findByText(/Shared files are still unavailable/)).toBeTruthy();
  mounted.unmount();
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
  ready = true;
  await userEvent.click(
    await screen.findByRole('button', { name: 'Prepare or retry shared files' }),
  );
  expect(await screen.findByText(/Shared files are ready/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Activate roster' }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
    2,
  );
});

it('keeps primary lifecycle controls unavailable while reviewer removal remains explicit', async () => {
  const current = status(true);
  current.config = {
    ...config,
    anchorSeatId: 'primary',
    seats: config.seats.map((seat, i) =>
      i === 0 ? { ...seat, id: 'primary', name: 'Primary' } : seat,
    ),
  };
  current.seats = current.seats.map((row, i) =>
    i === 0 ? { ...row, seatId: 'primary', seat: current.config.seats[0] } : row,
  );
  vi.mocked(apiFetch).mockResolvedValue(response(current));
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
  const primary = within(
    (await screen.findByText('Primary', { selector: 'strong' })).closest('li')!,
  );
  const reviewer = within(screen.getByText('Reviewer', { selector: 'strong' }).closest('li')!);
  expect(primary.queryByRole('button', { name: 'Suspend' })).toBeNull();
  expect(primary.queryByRole('button', { name: 'Remove' })).toBeNull();
  expect(
    primary.getByText(
      'Transfer primary ownership before suspending, removing, or rebinding this seat.',
    ),
  ).toBeTruthy();
  expect(reviewer.getByRole('button', { name: 'Suspend' }).hasAttribute('disabled')).toBe(false);
  await userEvent.click(reviewer.getByRole('button', { name: 'Remove' }));
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/sessions/session/symposium/membership',
    expect.objectContaining({ body: expect.stringContaining('"seatId":"reviewer"') }),
  );
});

it('retains explicit admission for an anchor without membership after activation', async () => {
  const current = status(true);
  const unadmitted = {
    ...current,
    seats: current.seats.map((row) => ({ ...row, admitted: false, membership: null })),
  };
  vi.mocked(apiFetch).mockResolvedValue(response(unadmitted));
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
  const anchor = within(
    (await screen.findByText('Architect', { selector: 'strong' })).closest('li')!,
  );
  await userEvent.click(
    screen.getByRole('checkbox', { name: /I acknowledge the shared artifacts/ }),
  );
  await userEvent.click(anchor.getByRole('button', { name: 'Add seat' }));
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/sessions/session/symposium/membership',
    expect.objectContaining({
      body: expect.stringContaining('"seatId":"architect","action":"admit"'),
    }),
  );
});

it('requires an explicit admitted primary selection and confirmation without changing seat permissions', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response(status(true)));
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
  const action = await screen.findByRole('button', { name: 'Transfer primary seat' });
  expect(action.hasAttribute('disabled')).toBe(true);
  await userEvent.selectOptions(screen.getByLabelText('New primary seat'), 'reviewer');
  expect(action.hasAttribute('disabled')).toBe(true);
  await userEvent.type(
    screen.getByLabelText('Type TRANSFER PRIMARY SEAT to confirm'),
    'TRANSFER PRIMARY SEAT',
  );
  await userEvent.click(action);
  const call = vi
    .mocked(apiFetch)
    .mock.calls.find(([path]) => String(path).endsWith('/primary/transfer'))!;
  expect(JSON.parse(call[1]!.body as string)).toMatchObject({
    fromSeatId: 'architect',
    toSeatId: 'reviewer',
    expectedRevision: 4,
    expectedGeneration: 1,
    confirmation: 'TRANSFER PRIMARY SEAT',
  });
  expect(JSON.parse(call[1]!.body as string)).not.toHaveProperty('authorityGrant');
});

it('provides admission recovery after a saved transfer without silently moving primary again', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    response({
      ...status(true),
      seats: status(true).seats.map((seat) => ({ ...seat, admitted: false })),
      runtimeAvailable: true,
      config: { ...config, revision: 5, anchorSeatId: 'reviewer' },
    }),
  );
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
  await userEvent.click(
    await screen.findByRole('button', { name: 'Recheck retained seat admissions' }),
  );
  const call = vi
    .mocked(apiFetch)
    .mock.calls.find(([path]) => String(path).endsWith('/admissions/refresh'))!;
  expect(JSON.parse(call[1]!.body as string)).toEqual({ expectedRevision: 5 });
  expect(
    vi.mocked(apiFetch).mock.calls.some(([path]) => String(path).endsWith('/primary/transfer')),
  ).toBe(false);
});

it('refreshes a partially saved primary transfer and repairs admissions at its new revision', async () => {
  const failure = 'Primary transfer saved; retained seat admissions require rechecking';
  let transferred = false;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (String(path).endsWith('/primary/transfer')) {
      transferred = true;
      return { ok: false, status: 409, json: async () => ({ error: failure }) } as Response;
    }
    if (String(path).endsWith('/admissions/refresh')) {
      expect(JSON.parse(init!.body as string)).toEqual({ expectedRevision: 5 });
      return response({ seatIds: ['architect', 'reviewer'] });
    }
    const current = status(true);
    return response(
      transferred
        ? {
            ...current,
            config: { ...config, revision: 5, anchorSeatId: 'reviewer' },
            seats: current.seats.map((seat) => ({ ...seat, admitted: false })),
          }
        : current,
    );
  });
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
  await userEvent.selectOptions(await screen.findByLabelText('New primary seat'), 'reviewer');
  await userEvent.type(
    screen.getByLabelText('Type TRANSFER PRIMARY SEAT to confirm'),
    'TRANSFER PRIMARY SEAT',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Transfer primary seat' }));
  expect(await screen.findByText(failure, { exact: false })).toBeTruthy();
  await userEvent.click(
    await screen.findByRole('button', { name: 'Recheck retained seat admissions' }),
  );
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([path]) => String(path).endsWith('/admissions/refresh')),
  ).toHaveLength(1);
});

it('does not offer retained admission recheck for pending membership or a current refused admission', async () => {
  const pending = status(false);
  vi.mocked(apiFetch).mockResolvedValue(response({ ...pending, runtimeAvailable: true }));
  const mounted = render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
  await screen.findByText(/OpenAI work · gpt/);
  expect(screen.queryByRole('button', { name: 'Recheck retained seat admissions' })).toBeNull();
  mounted.unmount();
  vi.mocked(apiFetch).mockResolvedValue(
    response({
      ...status(true),
      seats: status(true).seats.map((seat) => ({
        ...seat,
        admitted: false,
        admission: { configRevision: 4, membershipGeneration: 1, decision: 'refused' },
      })),
    }),
  );
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
  await screen.findByText(/OpenAI work · gpt/);
  expect(screen.queryByRole('button', { name: 'Recheck retained seat admissions' })).toBeNull();
});

it('offers failed primary cleanup only from host capability and requires typed confirmation', async () => {
  const initial = status(true);
  const failed = {
    ...initial,
    seats: initial.seats.map((seat, index) =>
      index
        ? seat
        : {
            ...seat,
            admitted: false,
            creationDiagnostic: { phase: 'upload', code: 'SEAT_UPLOAD_FAILED', canCleanup: true },
          },
    ),
  };
  vi.mocked(apiFetch).mockResolvedValue(response(failed));
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
  const button = await screen.findByRole('button', { name: 'Clean up failed seat' });
  expect(button.hasAttribute('disabled')).toBe(true);
  await userEvent.type(
    screen.getByLabelText('Type CLEAN UP FAILED SEAT for Architect'),
    'CLEAN UP FAILED SEAT',
  );
  await userEvent.click(button);
  const call = vi
    .mocked(apiFetch)
    .mock.calls.find(([url]) => String(url).endsWith('/creation/recover'))!;
  expect(JSON.parse(call[1]!.body as string)).toMatchObject({
    seatId: 'architect',
    expectedRevision: 4,
    expectedGeneration: 1,
    confirmation: 'CLEAN UP FAILED SEAT',
  });
});
it('resumes a durable failed cleanup after remount using the retained operation key and fresh confirmation', async () => {
  const base = status(true);
  const failed = {
    ...base,
    seats: base.seats.map((seat, index) =>
      index
        ? seat
        : {
            ...seat,
            admitted: false,
            creationDiagnostic: {
              phase: 'upload',
              code: 'SEAT_UPLOAD_FAILED',
              canCleanup: true,
              recoveryIdempotencyKey: 'retained-cleanup-key',
            },
          },
    ),
  };
  vi.mocked(apiFetch).mockResolvedValue(response(failed));
  const first = render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
  await userEvent.type(
    await screen.findByLabelText('Type CLEAN UP FAILED SEAT for Architect'),
    'CLEAN UP FAILED SEAT',
  );
  first.unmount();
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
  const button = await screen.findByRole('button', { name: 'Clean up failed seat' });
  expect(button.hasAttribute('disabled')).toBe(true);
  await userEvent.type(
    screen.getByLabelText('Type CLEAN UP FAILED SEAT for Architect'),
    'CLEAN UP FAILED SEAT',
  );
  await userEvent.click(button);
  const call = vi
    .mocked(apiFetch)
    .mock.calls.find(([url]) => String(url).endsWith('/creation/recover'))!;
  expect(JSON.parse(call[1]!.body as string)).toMatchObject({
    idempotencyKey: 'retained-cleanup-key',
    expectedRevision: 4,
    expectedGeneration: 1,
  });
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Clean up failed seat' }).hasAttribute('disabled'),
    ).toBe(true),
  );
});

it.each(['reauthorization_required', 'cleanup_fenced'])(
  'distinguishes pending cleanup %s from lost physical custody',
  async (state) => {
    const initial = status(true);
    vi.mocked(apiFetch).mockResolvedValue(
      response({
        ...initial,
        seats: initial.seats.map((seat, index) =>
          index
            ? seat
            : {
                ...seat,
                admitted: false,
                creationDiagnostic: {
                  phase: 'upload',
                  code: 'SEAT_UPLOAD_FAILED',
                  canCleanup: false,
                  recoveryAuthorization: { operationId: 'a'.repeat(64), revision: 1, state },
                },
              },
        ),
      }),
    );
    render(<SymposiumDirectorPanel sessionId="session" />);
    await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
    await screen.findByText(
      state === 'cleanup_fenced' ? /Cleanup is fenced/ : /Fresh app reauthorization is required/,
    );
    expect(screen.queryByText(/Exact retained creation proof is unavailable/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clean up failed seat' })).toBeNull();
  },
);

it.each(['success', 'auth-rejected', 'auth-expired', 'handoff-rejected'])(
  'reauthorizes exact pending cleanup through fresh app auth (%s) without the old private key',
  async (mode) => {
    const initial = status(true);
    let authorized = false;
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url) === '/api/sessions/session/symposium/creation/recovery/app-reauthorize') {
        if (mode === 'auth-rejected')
          return { ok: false, json: async () => ({ error: 'Passphrase rejected' }) } as Response;
        return response({
          csrf: 'fresh-csrf',
          expiresAt: Date.now() + (mode === 'auth-expired' ? -1 : 60000),
        });
      }
      if (String(url).endsWith('/creation/recovery/reauthorize')) {
        if (mode === 'handoff-rejected')
          return {
            ok: false,
            json: async () => ({ error: 'App authentication expired' }),
          } as Response;
        authorized = true;
        return response({ authorizationRevision: 2 });
      }
      return response({
        ...initial,
        seats: initial.seats.map((seat, index) =>
          index
            ? seat
            : {
                ...seat,
                admitted: false,
                creationDiagnostic: {
                  phase: 'upload',
                  code: 'SEAT_UPLOAD_FAILED',
                  canCleanup: authorized,
                  ...(authorized ? { recoveryIdempotencyKey: 'server-owned-cleanup-key' } : {}),
                  recoveryAuthorization: {
                    operationId: 'a'.repeat(64),
                    revision: authorized ? 2 : 1,
                    state: authorized ? 'authorized' : 'reauthorization_required',
                  },
                },
              },
        ),
      });
    });
    render(<SymposiumDirectorPanel sessionId="session" />);
    await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
    const passphrase = await screen.findByLabelText('App passphrase for Architect cleanup');
    const action = screen.getByRole('button', { name: 'Authorize pending cleanup' });
    expect(action.hasAttribute('disabled')).toBe(true);
    await userEvent.type(passphrase, 'fresh-passphrase');
    await userEvent.type(
      screen.getByLabelText('Type RESUME FAILED SEAT CLEANUP for Architect'),
      'RESUME FAILED SEAT CLEANUP',
    );
    await userEvent.click(action);
    await waitFor(() =>
      expect(
        vi
          .mocked(apiFetch)
          .mock.calls.some(
            ([url]) => url === '/api/sessions/session/symposium/creation/recovery/app-reauthorize',
          ),
      ).toBe(true),
    );
    const authCall = vi
      .mocked(apiFetch)
      .mock.calls.find(
        ([url]) => url === '/api/sessions/session/symposium/creation/recovery/app-reauthorize',
      )!;
    expect(JSON.parse(authCall[1]!.body as string)).toEqual({ passphrase: 'fresh-passphrase' });
    if (mode === 'success') {
      const cleanup = await screen.findByRole('button', { name: 'Clean up failed seat' });
      expect(cleanup.hasAttribute('disabled')).toBe(true);
      const handoff = vi
        .mocked(apiFetch)
        .mock.calls.find(([url]) => String(url).endsWith('/creation/recovery/reauthorize'))!;
      expect(handoff[1]!.headers).toMatchObject({ 'x-csrf-token': 'fresh-csrf' });
      expect(JSON.parse(handoff[1]!.body as string)).toEqual({
        seatId: 'architect',
        expectedRevision: 4,
        expectedGeneration: 1,
        operationId: 'a'.repeat(64),
        expectedAuthorizationRevision: 1,
        idempotencyKey: expect.any(String),
        confirmation: 'RESUME FAILED SEAT CLEANUP',
      });
    } else {
      await screen.findByText(
        mode === 'auth-rejected'
          ? 'Passphrase rejected'
          : mode === 'auth-expired'
            ? 'Recent app authorization expired. Enter the passphrase again.'
            : 'App authentication expired',
      );
      expect((passphrase as HTMLInputElement).value).toBe('');
      expect(screen.queryByRole('button', { name: 'Clean up failed seat' })).toBeNull();
      if (mode !== 'handoff-rejected')
        expect(
          vi
            .mocked(apiFetch)
            .mock.calls.some(([url]) => String(url).endsWith('/creation/recovery/reauthorize')),
        ).toBe(false);
    }
    expect(
      vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/creation/recover')),
    ).toBe(false);
  },
);

it('requires freshly typed cleanup confirmation after another session handoff and reauthorization', async () => {
  const initial = status(true);
  let phase: 'original' | 'foreign' | 'returned' = 'original';
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (url === '/api/sessions/session/symposium/creation/recovery/app-reauthorize')
      return response({ csrf: 'csrf', expiresAt: Date.now() + 60000 });
    if (String(url).endsWith('/creation/recovery/reauthorize')) {
      phase = 'returned';
      return response({ authorizationRevision: 2 });
    }
    return response({
      ...initial,
      seats: initial.seats.map((seat, index) =>
        index
          ? seat
          : {
              ...seat,
              admitted: false,
              creationDiagnostic: {
                phase: 'upload',
                code: 'SEAT_UPLOAD_FAILED',
                canCleanup: phase !== 'foreign',
                recoveryIdempotencyKey: phase !== 'foreign' ? 'cleanup-key' : undefined,
                recoveryAuthorization: {
                  operationId: 'a'.repeat(64),
                  revision: phase === 'original' ? 0 : phase === 'foreign' ? 1 : 2,
                  state: phase === 'foreign' ? 'reauthorization_required' : 'authorized',
                },
              },
            },
      ),
    });
  });
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
  await userEvent.type(
    await screen.findByLabelText('Type CLEAN UP FAILED SEAT for Architect'),
    'CLEAN UP FAILED SEAT',
  );
  expect(
    screen.getByRole('button', { name: 'Clean up failed seat' }).hasAttribute('disabled'),
  ).toBe(false);
  phase = 'foreign';
  await userEvent.click(screen.getByRole('button', { name: 'Refresh review team' }));
  await userEvent.type(
    await screen.findByLabelText('App passphrase for Architect cleanup'),
    'fresh-passphrase',
  );
  await userEvent.type(
    screen.getByLabelText('Type RESUME FAILED SEAT CLEANUP for Architect'),
    'RESUME FAILED SEAT CLEANUP',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Authorize pending cleanup' }));
  const cleanup = await screen.findByRole('button', { name: 'Clean up failed seat' });
  expect(cleanup.hasAttribute('disabled')).toBe(true);
  const confirmation = screen.getByLabelText(
    'Type CLEAN UP FAILED SEAT for Architect',
  ) as HTMLInputElement;
  expect(confirmation.value).toBe('');
  expect(
    vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/creation/recover')),
  ).toBe(false);
  await userEvent.type(confirmation, 'CLEAN UP FAILED SEAT');
  expect(cleanup.hasAttribute('disabled')).toBe(false);
});

it('drops the previous thinking level when a draft reviewer switches from Luna to Haiku', async () => {
  const previous = {
    ...config.seats[1],
    model: 'gpt-5.6-luna',
    reasoningEffort: 'low',
    accountBinding: {
      ...config.seats[1].accountBinding,
      accountId: 'personal-chatgpt',
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
    },
  };
  const draftConfig = { ...config, state: 'draft', seats: [config.seats[0], previous] };
  const draft = {
    ...status(false),
    config: draftConfig,
    seats: draftConfig.seats.map((seat) => ({
      seatId: seat.id,
      seat,
      admitted: false,
      membership: null,
      admission: null,
    })),
  };
  const binding = {
    accountId: 'vertex-default',
    accountLabel: 'Work Vertex',
    provider: 'anthropic-vertex',
    model: 'claude-haiku-4-5@20251001',
    profileRevision: 'vertex-revision',
  };
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(response(draft))
    .mockResolvedValueOnce(response({ binding }))
    .mockResolvedValueOnce(response({ ok: true }))
    .mockResolvedValueOnce(response(draft));
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
  await screen.findByText(/Draft — provider seats are not admitted/);
  const reviewer = screen
    .getAllByRole('button', { name: 'Save seat model' })[1]
    .closest('.symposium-seat-selection') as HTMLElement;
  await userEvent.click(within(reviewer).getByRole('button', { name: 'Select Work Haiku' }));
  await userEvent.click(within(reviewer).getByRole('button', { name: 'Save seat model' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(4));
  expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls[1][1]?.body))).toEqual({
    accountId: binding.accountId,
    model: binding.model,
  });
  const updated = JSON.parse(String(vi.mocked(apiFetch).mock.calls[2][1]?.body)).config.seats[1];
  expect(updated).toMatchObject({ id: 'reviewer', model: binding.model, accountBinding: binding });
  expect(updated).not.toHaveProperty('reasoningEffort');
  expect(previous.reasoningEffort).toBe('low');
});

it('explains the approval workflow and opens only for a matching reviewer handoff', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response(status(true)));
  render(<SymposiumDirectorPanel sessionId="session" />);
  const trigger = screen.getByRole('button', { name: 'Review team & approvals' });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  act(() =>
    window.dispatchEvent(
      new CustomEvent('symposium-open-team', { detail: { sessionId: 'other' } }),
    ),
  );
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  act(() =>
    window.dispatchEvent(
      new CustomEvent('symposium-open-team', { detail: { sessionId: 'session' } }),
    ),
  );
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(await screen.findByText(/You direct the team/)).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Review requests' })).toBeTruthy();
  expect(screen.getByText(/No review requests yet/)).toBeTruthy();
});

it('refreshes queued requests on a matching handoff when the panel is already open', async () => {
  const initial = status(true);
  const updated = {
    ...initial,
    deliveries: [
      {
        deliveryId: 'new-review',
        recipientSeatIds: ['reviewer'],
        status: 'awaiting_intervention',
        originalContent: 'Review the newly added reviewer request',
      },
    ],
  };
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(response(initial))
    .mockResolvedValueOnce(response(updated));
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Review team & approvals' }));
  await screen.findByText(/No review requests yet/);
  act(() =>
    window.dispatchEvent(
      new CustomEvent('symposium-open-team', {
        detail: { sessionId: 'other' },
      }),
    ),
  );
  expect(apiFetch).toHaveBeenCalledTimes(1);
  act(() =>
    window.dispatchEvent(
      new CustomEvent('symposium-open-team', {
        detail: { sessionId: 'session' },
      }),
    ),
  );
  expect(await screen.findByText(updated.deliveries[0].originalContent)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  expect(apiFetch).toHaveBeenCalledTimes(2);
});
