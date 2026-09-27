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
      <button type="button" onClick={() => onChange({ accountId: 'openai-work', model: 'gpt' })}>
        Select OpenAI model
      </button>
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
  await userEvent.click(screen.getByRole('button', { name: 'Director controls' }));
  expect(await screen.findByText(/Claude work · claude-sonnet/)).toBeTruthy();
  expect(screen.getByText(/OpenAI work · gpt/)).toBeTruthy();
  expect(screen.getAllByText(/Pending runtime admission/)).toHaveLength(2);
  expect(
    screen.getByRole('button', { name: 'Inject to selected seats' }).hasAttribute('disabled'),
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
  await userEvent.click(screen.getByRole('button', { name: 'Suspend' }));
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
  await userEvent.click(screen.getByRole('button', { name: 'Director controls' }));
  await userEvent.click(
    await screen.findByRole('button', { name: 'Prepare or retry shared files' }),
  );
  expect(await screen.findByText(/Shared files are still unavailable/)).toBeTruthy();
  mounted.unmount();
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Director controls' }));
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
  await userEvent.click(screen.getByRole('button', { name: 'Director controls' }));
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
  await userEvent.click(screen.getByRole('button', { name: 'Director controls' }));
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
  await userEvent.click(screen.getByRole('button', { name: 'Director controls' }));
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
  await userEvent.click(screen.getByRole('button', { name: 'Director controls' }));
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
  await userEvent.click(screen.getByRole('button', { name: 'Director controls' }));
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
  await userEvent.click(screen.getByRole('button', { name: 'Director controls' }));
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
  await userEvent.click(screen.getByRole('button', { name: 'Director controls' }));
  await screen.findByText(/OpenAI work · gpt/);
  expect(screen.queryByRole('button', { name: 'Recheck retained seat admissions' })).toBeNull();
});
