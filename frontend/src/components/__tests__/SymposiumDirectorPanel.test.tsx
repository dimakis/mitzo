// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { apiFetch } from '../../lib/api-fetch';
import { SymposiumDirectorPanel, getSymposiumEnableActions } from '../SymposiumDirectorPanel';

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

async function openAdvancedSettings() {
  const agents = screen.getByRole('button', { name: 'Agents' });
  if (agents.getAttribute('aria-expanded') !== 'true') await userEvent.click(agents);
  await waitFor(() => expect(screen.queryByText('Checking agent status…')).toBeNull());
  const advanced = screen.queryByRole('button', { name: 'Advanced and troubleshooting' });
  if (!advanced) return;
  if (advanced.getAttribute('aria-expanded') !== 'true') await userEvent.click(advanced);
  for (const details of screen.queryAllByRole('button', { name: 'View details' })) {
    if (details.getAttribute('aria-expanded') !== 'true') await userEvent.click(details);
  }
}

afterEach(() => {
  cleanup();
  getSymposiumEnableActions().update(() => ({}));
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it('shows distinct seat accounts and does not offer dispatch while runtime admission is pending', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response(status(false)));
  render(<SymposiumDirectorPanel sessionId="session" />);
  await openAdvancedSettings();
  expect(await screen.findByText(/Claude work · claude-sonnet/)).toBeTruthy();
  expect(screen.getByText(/OpenAI work · gpt/)).toBeTruthy();
  expect(screen.getAllByText(/Pending runtime admission/)).toHaveLength(2);
  expect(
    screen
      .getByRole('button', { name: 'Queue message for selected agents' })
      .hasAttribute('disabled'),
  ).toBe(true);
  expect(screen.getAllByRole('button', { name: 'Suspend' })).toHaveLength(1);
  expect(screen.getByText(/Agents can access shared workspace files/)).toBeTruthy();
});

it('injects only explicitly selected admitted recipients', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(response(status(true)))
    .mockResolvedValueOnce(response({ deliveryId: 'delivery-1' }))
    .mockResolvedValueOnce(response(status(true)));
  render(<SymposiumDirectorPanel sessionId="session" />);
  await openAdvancedSettings();
  await screen.findByText(/OpenAI work · gpt/);
  await userEvent.click(screen.getByRole('checkbox', { name: 'Send to Reviewer' }));
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Director message' }),
    'Review this patch',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Queue message for selected agents' }));
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
  await openAdvancedSettings();
  await screen.findByText(/Your setup is saved. Agents cannot run/);
  await userEvent.click(screen.getByText('Configure agents manually'));
  await userEvent.type(screen.getByRole('textbox', { name: 'New seat name' }), 'Builder');
  await userEvent.type(screen.getByRole('textbox', { name: 'New seat ID' }), 'builder');
  await userEvent.click(screen.getAllByRole('button', { name: 'Select OpenAI model' }).at(-1)!);
  await userEvent.click(screen.getByRole('button', { name: 'Save agent configuration' }));
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
  await openAdvancedSettings();
  await userEvent.click(await screen.findByRole('button', { name: 'Set up agents' }));
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
  await openAdvancedSettings();
  await screen.findByText(/Your setup is saved. Agents cannot run/);
  const activate = screen.getByRole('button', { name: 'Enable agents' });
  expect(activate.hasAttribute('disabled')).toBe(true);
  await userEvent.click(screen.getByRole('checkbox', { name: /I understand these agents/ }));
  await userEvent.type(
    screen.getByRole('textbox', { name: /To use another account/ }),
    'ADD CROSS-ACCOUNT SEAT',
  );
  await userEvent.click(activate);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(4));
  const [, request] = vi.mocked(apiFetch).mock.calls[1];
  expect(JSON.parse(String(request?.body))).toEqual({
    expectedRevision: 4,
    sharedBoundaryAcknowledged: true,
    crossAccountConfirmation: 'ADD CROSS-ACCOUNT SEAT',
  });
});

function initialEnableFixture(sessionId = 'initial-enable', seatCount = 2) {
  const rows = status(false).seats;
  if (seatCount === 3)
    rows.push({
      ...rows[1],
      seatId: 'auditor',
      seat: { ...rows[1].seat, id: 'auditor', name: 'Auditor' },
    });
  const draft = {
    ...status(false),
    sessionId,
    config: { ...config, state: 'draft', seats: rows.map((row) => row.seat).reverse() },
    seats: rows.map((seat) => ({ ...seat, membership: null })),
  };
  const activeConfig = { ...draft.config, state: 'active', revision: 5 };
  const membership = (seatId: string, reconciliation = 'confirmed') => ({
    sessionId,
    seatId,
    configRevision: 5,
    generation: 1,
    state: 'active',
    reconciliation,
    idempotencyKey: '',
    action: 'admit',
  });
  const current = {
    ...draft,
    config: activeConfig,
    seats: draft.seats.map((seat) => ({
      ...seat,
      membership: null as ReturnType<typeof membership> | null,
    })),
  };
  return { draft, activeConfig, current, membership };
}

async function enableInitialRoster() {
  await userEvent.click(screen.getByRole('button', { name: 'Agents' }));
  await screen.findByRole('button', { name: 'Enable agents' });
  await userEvent.click(screen.getByRole('checkbox', { name: /I understand these agents/ }));
  await userEvent.type(
    screen.getByRole('textbox', { name: /To use another account/ }),
    'ADD CROSS-ACCOUNT SEAT',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Enable agents' }));
}

it.each([2, 3])(
  'enables a %s-seat initial roster with one click, admitting the anchor first at the activated revision',
  async (seatCount) => {
    const { draft, activeConfig, current, membership } = initialEnableFixture(
      'initial-enable',
      seatCount,
    );
    const requests: Record<string, unknown>[] = [];
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/activate')) return response(activeConfig);
      if (String(url).endsWith('/membership')) {
        const input = JSON.parse(String(init?.body));
        requests.push(input);
        const record = { ...membership(input.seatId), idempotencyKey: input.idempotencyKey };
        current.seats = current.seats.map((seat) =>
          seat.seatId === input.seatId ? { ...seat, membership: record } : seat,
        ) as typeof current.seats;
        return response(record);
      }
      return response(
        requests.length ||
          vi.mocked(apiFetch).mock.calls.some(([path]) => String(path).endsWith('/activate'))
          ? current
          : draft,
      );
    });
    render(<SymposiumDirectorPanel sessionId="initial-enable" />);
    await enableInitialRoster();
    await waitFor(() => expect(requests).toHaveLength(seatCount));
    expect(requests.map((input) => input.seatId)).toEqual(
      seatCount === 3 ? ['architect', 'auditor', 'reviewer'] : ['architect', 'reviewer'],
    );
    for (const input of requests)
      expect(input).toMatchObject({
        action: 'admit',
        expectedGeneration: 0,
        configRevision: 5,
        sharedBoundaryAcknowledged: true,
        crossAccountConfirmation: 'ADD CROSS-ACCOUNT SEAT',
      });
    expect(new Set(requests.map((input) => input.idempotencyKey)).size).toBe(seatCount);
  },
);

it('stops after a recovery-required membership receipt and preserves the partially enabled roster', async () => {
  const { draft, activeConfig, current, membership } = initialEnableFixture('initial-failure');
  let activated = false;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/activate')) {
      activated = true;
      return response(activeConfig);
    }
    if (String(url).endsWith('/membership')) {
      const record = {
        ...membership('architect', 'recovery_required'),
        idempotencyKey: JSON.parse(String(init?.body)).idempotencyKey,
      };
      current.seats = current.seats.map((seat) =>
        seat.seatId === 'architect' ? { ...seat, membership: record } : seat,
      ) as typeof current.seats;
      return response(record);
    }
    return response(activated ? current : draft);
  });
  render(<SymposiumDirectorPanel sessionId="initial-failure" />);
  await enableInitialRoster();
  await screen.findByText(/Enablement stopped/);
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/membership')),
  ).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Enable agents' })).toBeNull();
});

it.each(['close', 'session', 'unmount'])(
  'does not continue initial admission after %s while activation is pending',
  async (change) => {
    const sessionId = `initial-${change}`;
    const { draft, activeConfig } = initialEnableFixture(sessionId);
    let resolve!: (value: Response) => void;
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      String(url).endsWith('/activate')
        ? new Promise<Response>((done) => {
            resolve = done;
          })
        : response(draft),
    );
    const view = render(<SymposiumDirectorPanel sessionId={sessionId} />);
    await enableInitialRoster();
    if (change === 'close') await userEvent.click(screen.getByRole('button', { name: 'Agents' }));
    else if (change === 'session')
      view.rerender(<SymposiumDirectorPanel sessionId="other-initial-session" />);
    else view.unmount();
    await act(async () => {
      resolve(response(activeConfig));
    });
    expect(
      vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/membership')),
    ).toBe(false);
  },
);

it.each([
  'session',
  'seat',
  'revision',
  'generation',
  'pending',
  'transport',
  'status-generation',
  'key',
  'action',
])('stops initial enablement on a %s mismatch without another admission', async (kind) => {
  const sessionId = `initial-mismatch-${kind}`;
  const { draft, activeConfig, current, membership } = initialEnableFixture(sessionId);
  let activated = false;
  let membershipRequests = 0;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/activate')) {
      activated = true;
      return response(activeConfig);
    }
    if (String(url).endsWith('/membership')) {
      membershipRequests++;
      if (kind === 'transport') throw new Error('Lost connection');
      const record = {
        ...membership('architect'),
        idempotencyKey: JSON.parse(String(init?.body)).idempotencyKey,
        ...(kind === 'session' ? { sessionId: 'other' } : {}),
        ...(kind === 'seat' ? { seatId: 'reviewer' } : {}),
        ...(kind === 'revision' ? { configRevision: 4 } : {}),
        ...(kind === 'generation' ? { generation: 2 } : {}),
        ...(kind === 'key' ? { idempotencyKey: 'unrelated-key' } : {}),
        ...(kind === 'action' ? { action: 'restore' } : {}),
        ...(kind === 'pending' ? { reconciliation: 'pending' } : {}),
      };
      current.seats = current.seats.map((seat) =>
        seat.seatId === 'architect'
          ? {
              ...seat,
              membership: {
                ...record,
                ...(kind === 'status-generation' ? { generation: 2 } : {}),
              },
            }
          : seat,
      );
      return response(record);
    }
    return response(activated ? current : draft);
  });
  render(<SymposiumDirectorPanel sessionId={sessionId} />);
  await enableInitialRoster();
  await screen.findByText(/Enablement stopped/);
  expect(membershipRequests).toBe(1);
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/deliveries'))).toBe(
    false,
  );
});

it('keeps an uncertain activation fenced after a finite deadline and a keyed remount', async () => {
  const { draft } = initialEnableFixture('initial-deadline');
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).endsWith('/activate') ? new Promise<Response>(() => {}) : response(draft),
  );
  let deadline!: () => void;
  const originalTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 5 * 60 * 1000) deadline = callback;
    return originalTimeout(callback, delay, ...args);
  }) as typeof setTimeout);
  const view = render(<SymposiumDirectorPanel sessionId="initial-deadline" />);
  await enableInitialRoster();
  await act(async () => {
    deadline();
  });
  expect(screen.getByText(/Enablement stopped/).textContent).toContain('timed out');
  vi.useRealTimers();
  view.unmount();
  render(<SymposiumDirectorPanel sessionId="initial-deadline" />);
  await userEvent.click(screen.getByRole('button', { name: 'Agents' }));
  const enable = await screen.findByRole('button', { name: 'Enable agents' });
  expect(enable.hasAttribute('disabled')).toBe(true);
  await userEvent.click(enable);
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/activate')),
  ).toHaveLength(1);
});

it('preserves the activated configuration when its first status read fails', async () => {
  const { draft, activeConfig } = initialEnableFixture('initial-status-failure');
  let activated = false;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).endsWith('/activate')) {
      activated = true;
      return response(activeConfig);
    }
    if (activated) throw new Error('Status unavailable');
    return response(draft);
  });
  render(<SymposiumDirectorPanel sessionId="initial-status-failure" />);
  await enableInitialRoster();
  await screen.findByText(/Enablement stopped/);
  expect(screen.queryByRole('button', { name: 'Enable agents' })).toBeNull();
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/membership'))).toBe(
    false,
  );
});

it.each(['close', 'session', 'unmount'])(
  'does not continue the next initial seat after %s during admission',
  async (change) => {
    const sessionId = `initial-admission-${change}`;
    const { draft, activeConfig, current, membership } = initialEnableFixture(sessionId);
    let activated = false;
    let resolve!: (value: Response) => void;
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).endsWith('/activate')) {
        activated = true;
        return response(activeConfig);
      }
      if (String(url).endsWith('/membership'))
        return new Promise<Response>((done) => {
          resolve = done;
        });
      return response(activated ? current : draft);
    });
    const view = render(<SymposiumDirectorPanel sessionId={sessionId} />);
    await enableInitialRoster();
    await waitFor(() => expect(resolve).toBeDefined());
    if (change === 'close') await userEvent.click(screen.getByRole('button', { name: 'Agents' }));
    else if (change === 'session')
      view.rerender(<SymposiumDirectorPanel sessionId="other-admission-session" />);
    else view.unmount();
    await act(async () => {
      resolve(response(membership('architect')));
    });
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/membership')),
    ).toHaveLength(1);
  },
);

it('holds the initial enablement lock across duplicate clicks and a remount before activation settles', async () => {
  const { draft, activeConfig } = initialEnableFixture('initial-lock');
  let resolve!: (value: Response) => void;
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).endsWith('/activate')
      ? new Promise<Response>((done) => {
          resolve = done;
        })
      : response(draft),
  );
  const view = render(<SymposiumDirectorPanel sessionId="initial-lock" />);
  await enableInitialRoster();
  const enable = screen.getByRole('button', { name: 'Enable agents' });
  fireEvent.click(enable);
  fireEvent.click(enable);
  view.unmount();
  render(<SymposiumDirectorPanel sessionId="initial-lock" />);
  await userEvent.click(screen.getByRole('button', { name: 'Agents' }));
  const reopened = await screen.findByRole('button', { name: 'Enable agents' });
  expect(reopened.hasAttribute('disabled')).toBe(true);
  await act(async () => {
    resolve(response(activeConfig));
  });
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/activate')),
  ).toHaveLength(1);
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/membership'))).toBe(
    false,
  );
  expect(reopened.hasAttribute('disabled')).toBe(true);
});

it('fences an uncertain initial admission across failed status, refresh, and remount until its exact receipt is saved', async () => {
  const sessionId = 'initial-uncertain-seat';
  const { draft, activeConfig, current, membership } = initialEnableFixture(sessionId);
  draft.runtimeAvailable = true;
  current.runtimeAvailable = true;
  let activated = false;
  let admissionAttempted = false;
  let statusUnavailable = true;
  let key = '';
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/activate')) {
      activated = true;
      return response(activeConfig);
    }
    if (String(url).endsWith('/membership')) {
      admissionAttempted = true;
      key = JSON.parse(String(init?.body)).idempotencyKey;
      throw new Error('Membership response lost');
    }
    if (admissionAttempted && statusUnavailable) throw new Error('Status unavailable');
    return response(activated ? current : draft);
  });
  const view = render(<SymposiumDirectorPanel sessionId={sessionId} />);
  await enableInitialRoster();
  await screen.findByText(/Enablement stopped/);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Refresh status' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  await userEvent.click(
    within(screen.getByRole('listitem', { name: 'Architect agent' })).getByRole('button', {
      name: 'View details',
    }),
  );
  const enable = within(screen.getByRole('listitem', { name: 'Architect agent' })).getByRole(
    'button',
    { name: 'Enable agent' },
  );
  expect(enable.hasAttribute('disabled')).toBe(true);
  await userEvent.click(enable);
  statusUnavailable = false;
  await userEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  await waitFor(() => expect(screen.queryByText('Checking agent status…')).toBeNull());
  expect(enable.hasAttribute('disabled')).toBe(true);
  view.unmount();
  render(<SymposiumDirectorPanel sessionId={sessionId} />);
  await openAdvancedSettings();
  const remounted = within(screen.getByRole('listitem', { name: 'Architect agent' })).getByRole(
    'button',
    { name: 'Enable agent' },
  );
  expect(remounted.hasAttribute('disabled')).toBe(true);
  current.seats = current.seats.map((seat) =>
    seat.seatId === 'architect'
      ? { ...seat, membership: { ...membership('architect'), idempotencyKey: 'unrelated-key' } }
      : seat,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  await waitFor(() => expect(screen.queryByText('Checking agent status…')).toBeNull());
  expect(
    getSymposiumEnableActions().snapshot()[`/api/sessions/${sessionId}/symposium`]
      .uncertainAdmission,
  ).toBeDefined();
  current.seats = current.seats.map((seat) =>
    seat.seatId === 'architect'
      ? { ...seat, membership: { ...membership('architect'), idempotencyKey: key } }
      : seat,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  await waitFor(() =>
    expect(
      getSymposiumEnableActions().snapshot()[`/api/sessions/${sessionId}/symposium`]
        .uncertainAdmission,
    ).toBeUndefined(),
  );
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/membership')),
  ).toHaveLength(1);
});

it('does not activate an initial draft whose configured roster exceeds its seat cap', async () => {
  const { draft } = initialEnableFixture('initial-capacity', 3);
  draft.config.activeSeatCap = 2;
  vi.mocked(apiFetch).mockResolvedValue(response(draft));
  render(<SymposiumDirectorPanel sessionId="initial-capacity" />);
  await enableInitialRoster();
  await screen.findByRole('alert');
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/activate'))).toBe(
    false,
  );
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
  await openAdvancedSettings();
  await screen.findByText(/Your setup is saved. Agents cannot run/);
  await userEvent.click(screen.getAllByRole('button', { name: 'Select saved profile' })[1]);
  await userEvent.click(screen.getByRole('checkbox', { name: /I understand these agents/ }));
  await userEvent.type(
    screen.getByRole('textbox', { name: /To use another account/ }),
    'ADD CROSS-ACCOUNT SEAT',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Enable agents' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(4));
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
  await openAdvancedSettings();
  await screen.findByText(/OpenAI work · gpt/);
  await userEvent.click(screen.getByText('Configure agents manually'));
  await userEvent.type(screen.getByRole('textbox', { name: 'New seat name' }), 'Builder');
  await userEvent.type(screen.getByRole('textbox', { name: 'New seat ID' }), 'builder');
  await userEvent.click(screen.getAllByRole('button', { name: 'Select OpenAI model' }).at(-1)!);
  await userEvent.click(screen.getByRole('checkbox', { name: /I understand these agents/ }));
  await userEvent.type(
    screen.getByRole('textbox', { name: /To use another account/ }),
    'ADD CROSS-ACCOUNT SEAT',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Save agent configuration' }));
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
    await userEvent.click(screen.getByRole('button', { name: 'Agents' }));
    rerender(<SymposiumDirectorPanel sessionId="next" />);
    await screen.findByText('This conversation has no agents configured.');
    await act(async () => {
      if (completion === 'resolve') resolveOld(response(status(true)));
      else rejectOld(new Error('Old session failed'));
    });
    expect(screen.getByText('This conversation has no agents configured.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Suspend' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(apiFetch).toHaveBeenLastCalledWith('/api/sessions/next/symposium/status', undefined);
  },
);

it('clears the previous session roster and form state immediately on navigation', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(response(status(true)))
    .mockResolvedValueOnce(response({ ...status(true), sessionId: 'next' }));
  const { rerender } = render(<SymposiumDirectorPanel sessionId="session" />);
  await openAdvancedSettings();
  await screen.findByText(/OpenAI work · gpt/);
  await userEvent.click(screen.getByRole('checkbox', { name: 'Send to Reviewer' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Director message' }), 'Old message');
  rerender(<SymposiumDirectorPanel sessionId="next" />);
  expect(screen.queryByRole('button', { name: 'Suspend' })).toBeNull();
  await openAdvancedSettings();
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
  await openAdvancedSettings();
  await screen.findByText(/OpenAI work · gpt/);
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  expect(await screen.findByText('Queued from the audience composer')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Agents' }).getAttribute('aria-expanded')).toBe('true');
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
  await openAdvancedSettings();
  await screen.findByText(/OpenAI work · gpt/);
  await userEvent.click(screen.getByRole('button', { name: 'Suspend' }));
  rerender(<SymposiumDirectorPanel sessionId="next" />);
  await screen.findByText('This conversation has no agents configured.');
  await act(async () => {
    resolveMutation(response({ ok: true }));
  });
  expect(screen.getByText('This conversation has no agents configured.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Suspend' })).toBeNull();
  await openAdvancedSettings();
  expect(screen.getByRole('button', { name: 'Set up agents' }).hasAttribute('disabled')).toBe(
    false,
  );
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
  await openAdvancedSettings();
  await userEvent.click(await screen.findByRole('button', { name: 'Prepare shared workspace' }));
  await userEvent.click(await screen.findByRole('button', { name: 'View request error' }));
  expect(await screen.findByText(/Shared files are still unavailable/)).toBeTruthy();
  mounted.unmount();
  render(<SymposiumDirectorPanel sessionId="session" />);
  await openAdvancedSettings();
  ready = true;
  await userEvent.click(await screen.findByRole('button', { name: 'Prepare shared workspace' }));
  expect(await screen.findByText(/Shared files are ready/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Enable agents' }).hasAttribute('disabled')).toBe(true);
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
  await openAdvancedSettings();
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
  await openAdvancedSettings();
  const anchor = within(
    (await screen.findByText('Architect', { selector: 'strong' })).closest('li')!,
  );
  await userEvent.click(screen.getByRole('checkbox', { name: /I understand these agents/ }));
  await userEvent.click(anchor.getByRole('button', { name: 'Enable agent' }));
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
  await openAdvancedSettings();
  await userEvent.click(await screen.findByText('Change conversation owner'));
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
  await openAdvancedSettings();
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
  await openAdvancedSettings();
  await userEvent.click(await screen.findByText('Change conversation owner'));
  await userEvent.selectOptions(await screen.findByLabelText('New primary seat'), 'reviewer');
  await userEvent.type(
    screen.getByLabelText('Type TRANSFER PRIMARY SEAT to confirm'),
    'TRANSFER PRIMARY SEAT',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Transfer primary seat' }));
  await userEvent.click(await screen.findByRole('button', { name: 'View request error' }));
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
  await openAdvancedSettings();
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
  await openAdvancedSettings();
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
  await openAdvancedSettings();
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
  await openAdvancedSettings();
  await userEvent.type(
    await screen.findByLabelText('Type CLEAN UP FAILED SEAT for Architect'),
    'CLEAN UP FAILED SEAT',
  );
  first.unmount();
  render(<SymposiumDirectorPanel sessionId="session" />);
  await openAdvancedSettings();
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
    await openAdvancedSettings();
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
    await openAdvancedSettings();
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
  await openAdvancedSettings();
  await userEvent.type(
    await screen.findByLabelText('Type CLEAN UP FAILED SEAT for Architect'),
    'CLEAN UP FAILED SEAT',
  );
  expect(
    screen.getByRole('button', { name: 'Clean up failed seat' }).hasAttribute('disabled'),
  ).toBe(false);
  phase = 'foreign';
  await userEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
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
  await openAdvancedSettings();
  await screen.findByText(/Your setup is saved. Agents cannot run/);
  const reviewer = screen
    .getAllByRole('button', { name: 'Save account and model' })[1]
    .closest('.symposium-seat-selection') as HTMLElement;
  await userEvent.click(within(reviewer).getByRole('button', { name: 'Select Work Haiku' }));
  await userEvent.click(within(reviewer).getByRole('button', { name: 'Save account and model' }));
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

it('keeps account confirmation and manual administration out of same-account settings', async () => {
  const sameAccount = status(true);
  sameAccount.config = {
    ...config,
    seats: config.seats.map((seat) => ({
      ...seat,
      accountBinding: { ...seat.accountBinding, accountId: 'claude-work' },
    })),
  };
  sameAccount.seats = sameAccount.seats.map((seat, index) => ({
    ...seat,
    seat: sameAccount.config.seats[index],
  }));
  vi.mocked(apiFetch).mockResolvedValue(response(sameAccount));
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Agents' }));
  await screen.findByRole('listitem', { name: 'Architect agent' });
  expect(screen.queryByRole('textbox', { name: /To use another account/ })).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'New seat name' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Transfer primary seat' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Advanced and troubleshooting' }));
  await userEvent.click(screen.getByText('Configure agents manually'));
  await userEvent.click(screen.getAllByRole('button', { name: 'Select OpenAI model' }).at(-1)!);
  expect(screen.getByRole('textbox', { name: /To use another account/ })).toBeTruthy();
});

it('shows a compact failed agent card without exposing recovery operations', async () => {
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
              creationDiagnostic: { phase: 'mount', code: 'SEAT_MOUNT_FAILED', canCleanup: true },
            },
      ),
    }),
  );
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Agents' }));
  const card = await screen.findByRole('listitem', { name: 'Architect agent' });
  expect(within(card).getByText('Couldn’t connect this agent')).toBeTruthy();
  expect(within(card).getByText('Workspace setup failed. No message was sent.')).toBeTruthy();
  expect(screen.queryByText(/SEAT_MOUNT_FAILED/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Clean up failed seat' })).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Director message' })).toBeNull();
  await userEvent.click(within(card).getByRole('button', { name: 'View details' }));
  expect(within(card).getByText(/SEAT_MOUNT_FAILED/)).toBeTruthy();
  expect(
    within(card).getByRole('button', { name: 'Clean up failed seat' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(
    vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET'),
  ).toBe(true);
});

it('offers recorded agents as request targets without claiming a fresh connection', async () => {
  const durable = {
    ...status(true),
    statusMode: 'durable',
    runtimeVerification: 'not_checked',
    runtimeAvailable: false,
    seats: status(true).seats.map((seat, index) => ({
      ...seat,
      admitted: false,
      admissionRecorded: index === 1,
      savedRuntimeState: 'ready',
    })),
  };
  vi.mocked(apiFetch).mockResolvedValue(response(durable));
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Agents' }));
  expect(await screen.findByText('Added')).toBeTruthy();
  expect(screen.queryByText('Connected')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Advanced and troubleshooting' }));
  expect(screen.queryByRole('checkbox', { name: 'Send to Architect' })).toBeNull();
  await userEvent.click(screen.getByRole('checkbox', { name: 'Send to Reviewer' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Director message' }), 'Review this');
  await userEvent.click(screen.getByRole('button', { name: 'Queue message for selected agents' }));
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.some(
        ([url, init]) => String(url).endsWith('/deliveries') && init?.method === 'POST',
      ),
  ).toBe(true);
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.some(([url, init]) => String(url) === '/api/sessions/session/symposium' && !init),
  ).toBe(false);
});

it.each(['unrecorded', 'stopped', 'pending', 'failed'])(
  'does not offer %s saved agents as message targets',
  async (condition) => {
    const durable = {
      ...status(true),
      statusMode: 'durable',
      runtimeVerification: 'not_checked',
      runtimeAvailable: false,
      seats: status(true).seats.map((seat) => ({
        ...seat,
        admitted: false,
        admissionRecorded: condition !== 'unrecorded',
        savedRuntimeState: condition === 'stopped' ? 'stopped' : 'ready',
        membership: {
          ...seat.membership,
          reconciliation: condition === 'pending' ? 'pending' : 'confirmed',
        },
        ...(condition === 'failed'
          ? { creationDiagnostic: { phase: 'mount', code: 'FAILED', canCleanup: false } }
          : {}),
      })),
    };
    vi.mocked(apiFetch).mockResolvedValue(response(durable));
    render(<SymposiumDirectorPanel sessionId="session" />);
    await userEvent.click(screen.getByRole('button', { name: 'Agents' }));
    await screen.findByRole('listitem', { name: 'Architect agent' });
    expect(screen.queryByText('Connected')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Advanced and troubleshooting' }));
    expect(screen.queryByRole('checkbox', { name: 'Send to Reviewer' })).toBeNull();
    expect(
      screen
        .getByRole('button', { name: 'Queue message for selected agents' })
        .hasAttribute('disabled'),
    ).toBe(true);
  },
);

it('checks failure details only on request and discards a reply after newer durable status', async () => {
  const initial = status(true);
  const durable = {
    ...initial,
    statusMode: 'durable',
    runtimeVerification: 'not_checked',
    runtimeAvailable: false,
    seats: initial.seats.map((seat) => ({
      ...seat,
      admitted: false,
      admissionRecorded: false,
      savedRuntimeState: 'reserved',
      creationDiagnostic: { phase: 'mount', code: 'SEAT_MOUNT_FAILED', canCleanup: false },
    })),
  };
  let finish!: (value: Response) => void;
  const check = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  vi.mocked(apiFetch).mockImplementation((url) =>
    String(url).endsWith('/status') ? Promise.resolve(response(durable)) : check,
  );
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Agents' }));
  const card = await screen.findByRole('listitem', { name: 'Architect agent' });
  expect(apiFetch).toHaveBeenCalledTimes(1);
  await userEvent.click(within(card).getByRole('button', { name: 'View details' }));
  expect(within(card).getByText('Checking connection details…')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Refresh status' }).hasAttribute('disabled')).toBe(
    false,
  );
  expect(within(card).queryByRole('button', { name: 'Clean up failed seat' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  await waitFor(() => expect(within(card).queryByText('Checking connection details…')).toBeNull());
  await act(async () =>
    finish(
      response({
        ...durable,
        seats: durable.seats.map((seat) => ({
          ...seat,
          creationDiagnostic: { ...seat.creationDiagnostic, canCleanup: true },
        })),
      }),
    ),
  );
  expect(within(card).queryByRole('button', { name: 'Clean up failed seat' })).toBeNull();
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.filter(([url]) => String(url) === '/api/sessions/session/symposium'),
  ).toHaveLength(1);
});

it('keeps rejected detail checks local and never retries them automatically', async () => {
  const initial = status(true);
  const durable = {
    ...initial,
    statusMode: 'durable',
    runtimeVerification: 'not_checked',
    runtimeAvailable: false,
    seats: initial.seats.map((seat) => ({
      ...seat,
      admitted: false,
      creationDiagnostic: { phase: 'mount', code: 'FAILED', canCleanup: false },
    })),
  };
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).endsWith('/status')
      ? response(durable)
      : ({ ok: false, json: async () => ({ error: 'Proof is unavailable' }) } as Response),
  );
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Agents' }));
  const card = await screen.findByRole('listitem', { name: 'Architect agent' });
  await userEvent.click(within(card).getByRole('button', { name: 'View details' }));
  expect(await within(card).findByText('Couldn’t check connection details.')).toBeTruthy();
  expect(within(card).queryByRole('button', { name: 'Clean up failed seat' })).toBeNull();
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it.each(['missing', 'null', 'unavailable', 'current'])(
  'retains saved creation failure unless the detail check returns a current diagnostic (%s)',
  async (diagnostic) => {
    const initial = status(false);
    const durable = {
      ...initial,
      statusMode: 'durable',
      runtimeVerification: 'not_checked',
      seats: initial.seats.map((seat) => ({
        ...seat,
        creationDiagnostic: {
          phase: 'mount',
          code: 'SEAT_MOUNT_FAILED',
          canCleanup: diagnostic === 'unavailable',
          recoveryAuthorization: {
            operationId: 'recovery-operation',
            revision: 2,
            state: 'cleanup_fenced',
          },
        },
      })),
    };
    const checked = {
      ...initial,
      runtimeAvailable: diagnostic !== 'unavailable',
      seats: initial.seats.map((seat) => ({
        ...seat,
        ...(diagnostic === 'missing'
          ? {}
          : {
              creationDiagnostic:
                diagnostic === 'null'
                  ? null
                  : { phase: 'mount', code: 'SEAT_MOUNT_FAILED', canCleanup: true },
            }),
      })),
    };
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      response(String(url).endsWith('/status') ? durable : checked),
    );
    render(<SymposiumDirectorPanel sessionId="session" />);
    await userEvent.click(screen.getByRole('button', { name: 'Agents' }));
    const card = await screen.findByRole('listitem', { name: 'Architect agent' });
    await userEvent.click(within(card).getByRole('button', { name: 'View details' }));
    await waitFor(() =>
      expect(within(card).queryByText('Checking connection details…')).toBeNull(),
    );
    expect(within(card).getByText('Workspace setup failed. No message was sent.')).toBeTruthy();
    expect(within(card).getByText(/Creation failed during mount: SEAT_MOUNT_FAILED/)).toBeTruthy();
    if (diagnostic === 'current') {
      expect(within(card).getByRole('button', { name: 'Clean up failed seat' })).toBeTruthy();
      expect(within(card).queryByText(/Cleanup is fenced:/)).toBeNull();
    } else {
      expect(within(card).getByText(/Cleanup is fenced:/)).toBeTruthy();
      expect(within(card).getByText('Couldn’t check connection details.')).toBeTruthy();
      expect(within(card).queryByRole('button', { name: 'Clean up failed seat' })).toBeNull();
    }
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method)).toBe(true);
  },
);

it.each([
  'wrong-session',
  'durable-projection',
  'wrong-revision',
  'wrong-generation',
  'wrong-seat',
])('does not accept %s as checked cleanup proof', async (kind) => {
  const initial = status(true);
  const durable = {
    ...initial,
    statusMode: 'durable',
    runtimeVerification: 'not_checked',
    runtimeAvailable: false,
    seats: initial.seats.map((seat) => ({
      ...seat,
      admitted: false,
      creationDiagnostic: { phase: 'mount', code: 'FAILED', canCleanup: false },
    })),
  };
  const checked = {
    ...durable,
    runtimeAvailable: true,
    sessionId: kind === 'wrong-session' ? 'other' : 'session',
    statusMode: kind === 'durable-projection' ? 'durable' : undefined,
    runtimeVerification: kind === 'durable-projection' ? 'not_checked' : undefined,
    config: { ...durable.config, revision: kind === 'wrong-revision' ? 5 : 4 },
    seats: durable.seats.map((seat) => ({
      ...seat,
      seatId: kind === 'wrong-seat' ? `other-${seat.seatId}` : seat.seatId,
      membership: { ...seat.membership, generation: kind === 'wrong-generation' ? 2 : 1 },
      creationDiagnostic: { ...seat.creationDiagnostic, canCleanup: true },
    })),
  };
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    response(String(url).endsWith('/status') ? durable : checked),
  );
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Agents' }));
  const card = await screen.findByRole('listitem', { name: 'Architect agent' });
  await userEvent.click(within(card).getByRole('button', { name: 'View details' }));
  expect(await within(card).findByText('Couldn’t check connection details.')).toBeTruthy();
  expect(
    within(card).getByText('Agent details changed. Refresh the agent list before continuing.'),
  ).toBeTruthy();
  expect(within(card).queryByRole('button', { name: 'Clean up failed seat' })).toBeNull();
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it.each(['model', 'profile'] as const)(
  'preserves explicit read-only authority and custom guidance when editing a paused coder %s',
  async (edit) => {
    const initial = status(true);
    const guidance = {
      role: 'coder',
      systemPrompt: 'Inspect the code without making changes',
      expectedOutput: 'A concise code report',
      acceptanceCriteria: ['Explain the evidence', 'Leave files unchanged'],
      authorityRequest: { filesystem: 'read', tools: 'read', network: 'restricted' },
    };
    const customSeats = initial.config.seats.map((seat, index) =>
      index ? { ...seat, ...guidance } : seat,
    );
    const paused = {
      ...initial,
      profileBindingEnforced: true,
      config: { ...initial.config, seats: customSeats },
      seats: initial.seats.map((seat, index) =>
        index
          ? {
              ...seat,
              seat: customSeats[index],
              admitted: false,
              membership: { ...seat.membership, state: 'suspended' },
            }
          : seat,
      ),
    };
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      response(String(url).endsWith('/seats/revise') ? { ...paused.config, revision: 5 } : paused),
    );
    render(<SymposiumDirectorPanel sessionId="session" />);
    await openAdvancedSettings();
    const reviewer = within(screen.getByRole('listitem', { name: 'Reviewer agent' }));
    if (edit === 'model') {
      await userEvent.click(reviewer.getByRole('button', { name: 'Select OpenAI model' }));
      await userEvent.click(reviewer.getByRole('checkbox', { name: /I understand this agent/ }));
      await userEvent.type(
        reviewer.getByLabelText('Cross-account confirmation'),
        'ADD CROSS-ACCOUNT SEAT',
      );
      await userEvent.click(reviewer.getByRole('button', { name: 'Save account and model' }));
    } else {
      await userEvent.click(reviewer.getByRole('button', { name: 'Select saved profile' }));
      await userEvent.click(screen.getByRole('checkbox', { name: /I understand these agents/ }));
      await userEvent.type(
        screen.getByRole('textbox', { name: /To use another account/ }),
        'ADD CROSS-ACCOUNT SEAT',
      );
      await userEvent.click(reviewer.getByRole('button', { name: 'Apply selected profile' }));
    }
    await waitFor(() =>
      expect(
        vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/seats/revise')),
      ).toBe(true),
    );
    const [, init] = vi
      .mocked(apiFetch)
      .mock.calls.find(([url]) => String(url).endsWith('/seats/revise'))!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ seatId: 'reviewer', ...guidance });
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('authorityGrant');
  },
);

it('shows saved setup in order without opening troubleshooting and keeps enabling behind consent', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    response({ ...status(false), config: { ...config, state: 'draft' } }),
  );
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Agents' }));
  const setup = await screen.findByRole('region', { name: 'Finish agent setup' });
  expect(
    within(setup).getByText('Your setup is saved. Agents cannot run until you enable them.'),
  ).toBeTruthy();
  expect(
    within(setup)
      .getAllByRole('heading')
      .map((heading) => heading.textContent),
  ).toEqual([
    'Finish agent setup',
    '1. Prepare the workspace',
    '2. Review access',
    '3. Enable agents',
  ]);
  expect(within(setup).getByRole('button', { name: 'Prepare shared workspace' })).toBeTruthy();
  const enable = within(setup).getByRole('button', { name: 'Enable agents' });
  expect(enable.hasAttribute('disabled')).toBe(true);
  await userEvent.click(within(setup).getByRole('checkbox', { name: /I understand these agents/ }));
  expect(enable.hasAttribute('disabled')).toBe(true);
  await userEvent.type(
    within(setup).getByRole('textbox', { name: /To use another account/ }),
    'ADD CROSS-ACCOUNT SEAT',
  );
  expect(enable.hasAttribute('disabled')).toBe(false);
  expect(
    screen
      .getByRole('button', { name: 'Advanced and troubleshooting' })
      .getAttribute('aria-expanded'),
  ).toBe('false');
});

it('distinguishes saved agents awaiting enablement from their connected provider accounts', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    response({ ...status(false), config: { ...config, state: 'draft' } }),
  );
  render(<SymposiumDirectorPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Agents' }));
  const reviewer = await screen.findByRole('listitem', { name: 'Reviewer agent' });
  expect(within(reviewer).getByText('Not enabled')).toBeTruthy();
  expect(within(reviewer).queryByText('Not connected')).toBeNull();
  expect(within(reviewer).getByText('Account: OpenAI work')).toBeTruthy();
});
