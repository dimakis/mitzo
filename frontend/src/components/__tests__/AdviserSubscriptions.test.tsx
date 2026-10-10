// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AdviserSubscriptions } from '../AdviserSubscriptions';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), changed: vi.fn() }));
vi.mock('../../lib/api-fetch', () => ({ apiFetch: (...args: unknown[]) => mocks.fetch(...args) }));
beforeEach(() => {
  mocks.changed.mockReset();
  mocks.fetch.mockReset();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('recovers a pending sign-in after remount, polls its exact receipt and cancels without another start', async () => {
  let pending: { id: string; state: 'pending' } | null = null;
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/start')) pending = { id: 'retained-attempt', state: 'pending' };
    if (url.endsWith('/cancel')) pending = null;
    return new Response(
      JSON.stringify(
        url.endsWith('/start') || url.includes('/attempts/')
          ? (pending ?? { id: 'retained-attempt', state: 'cancelled' })
          : { enabled: true, accounts: [], pendingAttempt: pending },
      ),
    );
  });
  const view = render(<AdviserSubscriptions onAccountsChanged={mocks.changed} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage adviser accounts' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT on your Mac' }));
  await screen.findByRole('button', { name: 'Cancel sign-in' });
  view.unmount();
  render(<AdviserSubscriptions onAccountsChanged={mocks.changed} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage adviser accounts' }));
  const cancel = await screen.findByRole('button', { name: 'Cancel sign-in' });
  expect(
    screen
      .getByRole('button', { name: 'Continue with ChatGPT on your Mac' })
      .hasAttribute('disabled'),
  ).toBe(true);
  await waitFor(
    () =>
      expect(
        mocks.fetch.mock.calls.some(([url]) => url.endsWith('/attempts/retained-attempt')),
      ).toBe(true),
    { timeout: 3000 },
  );
  fireEvent.click(cancel);
  await screen.findByText('Sign-in cancelled.');
  expect(mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/start'))).toHaveLength(1);
  expect(mocks.fetch.mock.calls.find(([url]) => url.endsWith('/cancel'))![0]).toBe(
    '/api/terminals/subscriptions/attempts/retained-attempt/cancel',
  );
});

it('recovers a host attempt after losing the start response through an explicit account refresh', async () => {
  let pending: { id: string; state: 'pending' } | null = null;
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/start')) {
      pending = { id: 'lost-response-attempt', state: 'pending' };
      throw Error('Response lost');
    }
    return new Response(JSON.stringify({ enabled: true, accounts: [], pendingAttempt: pending }));
  });
  render(<AdviserSubscriptions onAccountsChanged={mocks.changed} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage adviser accounts' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT on your Mac' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh adviser accounts' }));
  await screen.findByRole('button', { name: 'Cancel sign-in' });
  expect(mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/start'))).toHaveLength(1);
});

it('does not restore a cancelled attempt from an older account snapshot finishing during polling', async () => {
  vi.useFakeTimers();
  let release!: (response: Response) => void;
  const stale = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/start'))
      return new Response(JSON.stringify({ id: 'attempt', state: 'pending' }));
    if (url.endsWith('/cancel')) return new Response(JSON.stringify({ ok: true }));
    if (url.includes('/attempts/'))
      return new Response(JSON.stringify({ id: 'attempt', state: 'connected' }));
    if (++reads === 2) return stale;
    return new Response(JSON.stringify({ enabled: true, accounts: [], pendingAttempt: null }));
  });
  await act(async () => {
    render(<AdviserSubscriptions onAccountsChanged={mocks.changed} />);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Manage adviser accounts' }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT on your Mac' }));
  });
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(reads).toBe(2);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
  });
  expect(screen.queryByRole('button', { name: 'Cancel sign-in' })).toBeNull();
  await act(async () => {
    release(
      new Response(
        JSON.stringify({
          enabled: true,
          accounts: [],
          pendingAttempt: { id: 'attempt', state: 'pending' },
        }),
      ),
    );
  });
  expect(screen.queryByRole('button', { name: 'Cancel sign-in' })).toBeNull();
  expect(screen.getByText('Sign-in cancelled.')).toBeTruthy();
});
it('keeps account setup collapsed and lets the host browser own subscription sign-in', async () => {
  mocks.fetch.mockImplementation(
    async (url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify(
          url.endsWith('/start')
            ? { id: 'attempt', state: 'pending' }
            : url.includes('/attempts/')
              ? { id: 'attempt', state: 'pending' }
              : { enabled: true, accounts: [] },
        ),
      ),
  );
  render(<AdviserSubscriptions onAccountsChanged={mocks.changed} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage adviser accounts' }));
  expect(screen.getByRole('dialog', { name: 'Adviser accounts' })).toBeTruthy();
  expect(mocks.fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  fireEvent.change(screen.getByLabelText('Account label'), {
    target: { value: 'My personal account' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT on your Mac' }));
  await screen.findByText('Finish sign-in in the browser on your Mac.');
  const mutation = mocks.fetch.mock.calls.find(([url]) => url.endsWith('/start'));
  expect(JSON.parse(mutation![1].body)).toEqual({ label: 'My personal account' });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
  await waitFor(() =>
    expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/cancel'))).toBe(true),
  );
});
it('hides opt-in setup when disabled and requires explicit disconnect when enabled', async () => {
  mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ enabled: false, accounts: [] })));
  const view = render(<AdviserSubscriptions onAccountsChanged={mocks.changed} />);
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
  expect(screen.queryByRole('button', { name: 'Manage adviser accounts' })).toBeNull();
  view.unmount();
  let connected = true;
  mocks.fetch.mockImplementation(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.endsWith('/disconnect')
            ? ((connected = false), { revoked: false })
            : {
                enabled: true,
                accounts: [
                  {
                    id: 'plan',
                    label: 'Personal',
                    email: 'user@example.test',
                    state: connected ? 'connected' : 'disconnected',
                    revocationPending: !connected,
                  },
                ],
              },
        ),
      ),
  );
  render(<AdviserSubscriptions onAccountsChanged={mocks.changed} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage adviser accounts' }));
  expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/disconnect'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect Personal' }));
  await screen.findByText(/Remote sign-out was not confirmed/);
  expect(mocks.changed).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Sign in again to Personal' })).toBeTruthy();
});
it('keeps remote revocation recovery visible after refresh, reopening and remounting', async () => {
  let revocationPending = true;
  mocks.fetch.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          enabled: true,
          accounts: [
            {
              id: 'plan',
              label: 'Personal',
              email: 'user@example.test',
              state: 'disconnected',
              revocationPending,
            },
          ],
        }),
      ),
  );
  const recovery = /Remote sign-out was not confirmed; disconnect Mitzo in ChatGPT Settings/;
  const view = render(<AdviserSubscriptions onAccountsChanged={mocks.changed} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage adviser accounts' }));
  await screen.findByText(recovery);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh adviser accounts' }));
  await waitFor(() => expect(mocks.changed).toHaveBeenCalled());
  expect(screen.getByText(recovery)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByRole('button', { name: 'Manage adviser accounts' }));
  expect(screen.getByText(recovery)).toBeTruthy();
  view.unmount();
  render(<AdviserSubscriptions onAccountsChanged={mocks.changed} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage adviser accounts' }));
  await screen.findByText(recovery);
  revocationPending = false;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh adviser accounts' }));
  await waitFor(() => expect(screen.queryByText(recovery)).toBeNull());
});
