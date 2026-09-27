// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { apiFetch } from '../../lib/api-fetch';
import { SymposiumPersonalConnections } from '../SymposiumPersonalConnections';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
const rows = [
  {
    id: 'personal-a',
    label: 'Personal',
    revision: 2,
    state: 'connected',
    account: { email: 'one@example.test', planType: 'plus' },
  },
  {
    id: 'personal-b',
    label: 'Second account',
    revision: 3,
    state: 'reauth_required',
    account: { email: 'two@example.test', planType: 'pro' },
  },
];
it('lists each saved identity and starts only the selected slot with its revision', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url, init) =>
    response(
      url.endsWith('/connections')
        ? { connections: rows }
        : init?.method === 'POST'
          ? {
              state: 'pending',
              attemptId: 'attempt-b',
              connectionId: 'personal-b',
              method: 'device-code',
            }
          : { state: 'idle' },
    ),
  );
  render(<SymposiumPersonalConnections />);
  await screen.findByText('one@example.test');
  expect(screen.getByText('two@example.test')).toBeTruthy();
  const second = within(screen.getByRole('region', { name: 'Second account' }));
  fireEvent.click(second.getByRole('button', { name: 'Connect' }));
  fireEvent.click(await second.findByRole('button', { name: 'Get sign-in code' }));
  await second.findByRole('button', { name: 'Cancel sign-in' });
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/symposium/personal/login',
    expect.objectContaining({
      body: JSON.stringify({
        method: 'device-code',
        connectionId: 'personal-b',
        expectedRevision: 3,
      }),
    }),
  );
});
it('creates a labeled slot without starting authentication', async () => {
  vi.mocked(apiFetch).mockImplementation(async (_url, init) =>
    response(
      init?.method === 'POST'
        ? { id: 'new', label: 'Travel', revision: 1, state: 'disconnected' }
        : { connections: rows },
    ),
  );
  render(<SymposiumPersonalConnections />);
  await screen.findByText('one@example.test');
  fireEvent.change(screen.getByLabelText('Account label'), { target: { value: 'Travel' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add personal account' }));
  await screen.findByText(/Saved account added/);
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/symposium/personal/connections',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ label: 'Travel' }) }),
  );
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => url.endsWith('/login'))).toBe(false);
});
it('disconnects only the chosen revision and refreshes saved statuses', async () => {
  vi.mocked(apiFetch).mockImplementation(async (_url, init) =>
    response(
      init?.method === 'POST' ? { ...rows[0], state: 'disconnected' } : { connections: rows },
    ),
  );
  render(<SymposiumPersonalConnections />);
  await screen.findByText('one@example.test');
  fireEvent.click(
    within(screen.getByRole('region', { name: 'Personal' })).getByRole('button', {
      name: 'Disconnect',
    }),
  );
  await screen.findByText(/Disconnected Personal/);
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/symposium/personal/connections/personal-a/disconnect',
    expect.objectContaining({ body: JSON.stringify({ expectedRevision: 2 }) }),
  );
});
it('does not offer a new login when host recovery is required and exposes retry for list failure', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(response({}, false))
    .mockResolvedValue(response({ connections: [{ ...rows[0], state: 'recovery_required' }] }));
  render(<SymposiumPersonalConnections />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry personal accounts' }));
  await screen.findByText('Host recovery required');
  expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
});

it('refreshes recovered connecting state after cancellation so another slot can connect', async () => {
  let cancelled = false;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (url.endsWith('/connections'))
      return response({
        connections: [{ ...rows[0], state: cancelled ? 'connected' : 'connecting' }, rows[1]],
      });
    if (url.endsWith('/cancel')) {
      cancelled = true;
      return response({ state: 'cancelled', attemptId: 'a', connectionId: 'personal-a' });
    }
    return response({
      state: 'pending',
      attemptId: 'a',
      connectionId: 'personal-a',
      method: 'device-code',
    });
  });
  render(<SymposiumPersonalConnections />);
  fireEvent.click(await screen.findByRole('button', { name: 'Continue sign-in' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel sign-in' }));
  await screen.findByText('Connected');
  expect(
    (
      within(screen.getByRole('region', { name: 'Second account' })).getByRole('button', {
        name: 'Connect',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

it('disables all manager mutations when its parent becomes disabled after opening', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ connections: rows }));
  const { rerender } = render(<SymposiumPersonalConnections />);
  await screen.findByText('one@example.test');
  fireEvent.change(screen.getByLabelText('Account label'), { target: { value: 'Extra' } });
  rerender(<SymposiumPersonalConnections disabled />);
  expect(
    (screen.getByRole('button', { name: 'Add personal account' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect((screen.getByRole('button', { name: 'Disconnect' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect((screen.getByLabelText('Account label') as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
it('clears a closed pending dialog lock after a refreshed terminal slot state', async () => {
  let finished = false;
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    response(
      url.endsWith('/connections')
        ? { connections: [{ ...rows[0], state: finished ? 'connected' : 'connecting' }, rows[1]] }
        : { state: 'pending', attemptId: 'a', connectionId: 'personal-a', method: 'device-code' },
    ),
  );
  render(<SymposiumPersonalConnections />);
  fireEvent.click(await screen.findByRole('button', { name: 'Continue sign-in' }));
  await screen.findByRole('button', { name: 'Cancel sign-in' });
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  finished = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh personal accounts' }));
  await screen.findByText('Connected');
  expect(
    (
      within(screen.getByRole('region', { name: 'Second account' })).getByRole('button', {
        name: 'Connect',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

it('places browser callback login inside the selected saved account with its reviewed revision', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url, init) =>
    response(
      url.endsWith('/connections')
        ? { connections: rows }
        : init?.method === 'POST'
          ? {
              attemptId: 'callback',
              authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=fake',
            }
          : { state: 'idle' },
    ),
  );
  render(<SymposiumPersonalConnections />);
  await screen.findByText('two@example.test');
  const second = within(screen.getByRole('region', { name: 'Second account' }));
  fireEvent.click(second.getByText('Browser callback alternative for Second account'));
  fireEvent.click(second.getByRole('button', { name: 'Connect personal subscription' }));
  await second.findByText('Where will you open the login browser?');
  fireEvent.click(second.getByLabelText('Browser on the Mitzo server'));
  fireEvent.click(second.getByLabelText('The callback setup is ready on the browser computer'));
  fireEvent.click(second.getByRole('button', { name: 'Start personal login' }));
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/symposium/personal/login',
      expect.objectContaining({
        body: JSON.stringify({
          callbackTransport: 'host-local',
          connectionId: 'personal-b',
          expectedRevision: 3,
        }),
      }),
    ),
  );
});

it.each([1, 11])(
  'explicitly refreshes %i supported models without choosing a model',
  async (count) => {
    let finish!: (value: Response) => void;
    const changed = vi.fn();
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (url.endsWith('/models/refresh'))
        return new Promise((resolve) => {
          finish = resolve;
        });
      return response({ connections: rows });
    });
    render(<SymposiumPersonalConnections onAccountsChanged={changed} />);
    const button = await screen.findByRole('button', { name: 'Refresh supported models' });
    expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    fireEvent.click(button);
    await screen.findByText(/Checking supported models for Personal/);
    expect((screen.getByRole('button', { name: 'Disconnect' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/symposium/personal/connections/personal-a/models/refresh',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ expectedRevision: 2 }) }),
    );
    finish(response({ status: 'complete', inference: false, modelCount: count }));
    await screen.findByText(
      new RegExp(`${count} supported ${count === 1 ? 'model is' : 'models are'} ready`),
    );
    expect(changed).toHaveBeenCalledOnce();
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(1);
  },
);
it.each(['pending', 'reconciliation_required'])(
  'recovers persisted discovery %s without enabling conflicting account actions',
  async (modelDiscovery) => {
    vi.mocked(apiFetch).mockResolvedValue(
      response({
        connections: [
          {
            ...rows[0],
            modelDiscovery,
            state: modelDiscovery === 'pending' ? 'connected' : 'recovery_required',
          },
          rows[1],
        ],
      }),
    );
    render(<SymposiumPersonalConnections />);
    await screen.findByText('one@example.test');
    expect((screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: 'Refresh supported models' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  },
);
it('does not report success on failed or unconfirmed model discovery', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    response(
      url.endsWith('/models/refresh')
        ? { status: 'reconciliation_required', inference: false }
        : { connections: rows },
    ),
  );
  render(<SymposiumPersonalConnections />);
  fireEvent.click(await screen.findByRole('button', { name: 'Refresh supported models' }));
  await screen.findByText(/cleanup could not be confirmed/);
  expect(screen.queryByText(/supported models are ready/)).toBeNull();
});

it('notifies an open picker when callback recovery reports a completed login', async () => {
  const changed = vi.fn();
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    response(
      url.endsWith('/connections')
        ? { connections: rows }
        : { state: 'completed', attemptId: 'previous', connectionId: 'personal-a' },
    ),
  );
  render(<SymposiumPersonalConnections onAccountsChanged={changed} />);
  await screen.findByText('one@example.test');
  const personal = within(screen.getByRole('region', { name: 'Personal' }));
  fireEvent.click(personal.getByText('Browser callback alternative for Personal'));
  fireEvent.click(personal.getByRole('button', { name: 'Connect personal subscription' }));
  await personal.findByText(/Previous login completed/);
  expect(changed).toHaveBeenCalledOnce();
});

it('releases callback lock when refresh unmounts a disconnecting callback control', async () => {
  let state = rows[1].state;
  let started = false;
  vi.mocked(apiFetch).mockImplementation(async (url, init) =>
    response(
      url.endsWith('/connections')
        ? { connections: [rows[0], { ...rows[1], state }] }
        : init?.method === 'POST'
          ? {
              attemptId: 'callback',
              authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=fake',
            }
          : started
            ? { state: 'pending', attemptId: 'callback', connectionId: 'personal-b' }
            : { state: 'idle' },
    ),
  );
  render(<SymposiumPersonalConnections />);
  await screen.findByText('two@example.test');
  const second = within(screen.getByRole('region', { name: 'Second account' }));
  fireEvent.click(second.getByText('Browser callback alternative for Second account'));
  fireEvent.click(second.getByRole('button', { name: 'Connect personal subscription' }));
  await second.findByText('Where will you open the login browser?');
  fireEvent.click(second.getByLabelText('Browser on the Mitzo server'));
  fireEvent.click(second.getByLabelText('The callback setup is ready on the browser computer'));
  fireEvent.click(second.getByRole('button', { name: 'Start personal login' }));
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/symposium/personal/login',
      expect.objectContaining({
        body: JSON.stringify({
          callbackTransport: 'host-local',
          connectionId: 'personal-b',
          expectedRevision: 3,
        }),
      }),
    ),
  );
  started = true;
  await waitFor(() =>
    expect((second.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(
      true,
    ),
  );
  state = 'disconnecting';
  fireEvent.click(screen.getByRole('button', { name: 'Refresh personal accounts' }));
  await second.findByText('Wait for disconnect to finish, then refresh.');
  state = 'disconnected';
  fireEvent.click(screen.getByRole('button', { name: 'Refresh personal accounts' }));
  await waitFor(() =>
    expect((second.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
});

it('blocks the callback alternative while the same slot has a pending device sign-in', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    response(
      url.endsWith('/connections')
        ? { connections: [{ ...rows[0], state: 'connecting' }, rows[1]] }
        : {
            state: 'pending',
            attemptId: 'device',
            connectionId: rows[0].id,
            method: 'device-code',
          },
    ),
  );
  render(<SymposiumPersonalConnections />);
  fireEvent.click(await screen.findByRole('button', { name: 'Continue sign-in' }));
  await screen.findByRole('button', { name: 'Cancel sign-in' });
  const first = within(screen.getByRole('region', { name: rows[0].label }));
  fireEvent.click(first.getByRole('button', { name: 'Recover callback sign-in' }));
  await first.findByText(/Continue or cancel it in device sign-in/);
  expect(
    (
      first.getByRole('group', {
        name: 'Where will you open the login browser?',
      }) as HTMLFieldSetElement
    ).disabled,
  ).toBe(true);
  expect(apiFetch).not.toHaveBeenCalledWith(
    '/api/symposium/personal/login',
    expect.objectContaining({ method: 'POST' }),
  );
});

it('releases callback status-error lock when refresh proves the slot connected', async () => {
  let connected = false;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (url.endsWith('/connections'))
      return response({
        connections: [rows[0], { ...rows[1], state: connected ? 'connected' : 'reauth_required' }],
      });
    if (url.includes('attemptId=')) return response({}, false);
    return response({ state: 'pending', attemptId: 'callback', connectionId: 'personal-b' });
  });
  render(<SymposiumPersonalConnections />);
  await screen.findByText('two@example.test');
  const second = within(screen.getByRole('region', { name: 'Second account' }));
  fireEvent.click(second.getByRole('button', { name: 'Connect personal subscription' }));
  await second.findByRole('button', { name: 'Retry status' });
  connected = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh personal accounts' }));
  await waitFor(() =>
    expect((second.getByRole('button', { name: 'Reconnect' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
});

it('allows receipt recovery after remount during a callback login without starting another flow', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    response(
      url.endsWith('/connections')
        ? { connections: [{ ...rows[1], state: 'connecting' }] }
        : { state: 'pending', attemptId: 'callback', connectionId: 'personal-b' },
    ),
  );
  render(<SymposiumPersonalConnections />);
  fireEvent.click(await screen.findByRole('button', { name: 'Recover callback sign-in' }));
  await screen.findByText(/Continue in the already-open login browser/);
  expect(apiFetch).not.toHaveBeenCalledWith(
    '/api/symposium/personal/login',
    expect.objectContaining({ method: 'POST' }),
  );
});

it('can request a second device code after cancellation with callback recovery open', async () => {
  let state = 'idle';
  let starts = 0;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (url.endsWith('/connections'))
      return response({
        connections: [{ ...rows[1], state: state === 'pending' ? 'connecting' : 'disconnected' }],
      });
    if (url.endsWith('/login') && init?.method === 'POST') {
      state = 'pending';
      starts++;
    }
    if (url.endsWith('/cancel')) state = 'cancelled';
    return response({
      state,
      ...(state === 'idle'
        ? {}
        : { attemptId: `device-${starts}`, connectionId: rows[1].id, method: 'device-code' }),
    });
  });
  render(<SymposiumPersonalConnections />);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Get sign-in code' }));
  await screen.findByRole('button', { name: 'Cancel sign-in' });
  fireEvent.click(screen.getByRole('button', { name: 'Recover callback sign-in' }));
  await screen.findByText(/Continue or cancel it in device sign-in/);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Get sign-in code' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Get sign-in code' }));
  await screen.findByRole('button', { name: 'Cancel sign-in' });
  expect(starts).toBe(2);
});
