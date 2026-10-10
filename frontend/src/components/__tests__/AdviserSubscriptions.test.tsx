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
it('recovers a host-owned pending sign-in on remount and allows cancellation without starting another attempt', async () => {
  let pending = true;
  mocks.fetch.mockImplementation(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.endsWith('/cancel')
            ? ((pending = false), { ok: true })
            : {
                enabled: true,
                accounts: [],
                pendingAttempt: pending ? { id: 'owned-attempt', state: 'pending' } : null,
              },
        ),
      ),
  );
  const first = render(<AdviserSubscriptions onAccountsChanged={mocks.changed} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage adviser accounts' }));
  expect(
    (await screen.findByRole('button', { name: 'Cancel sign-in' })).hasAttribute('disabled'),
  ).toBe(false);
  expect(
    screen
      .getByRole('button', { name: 'Continue with ChatGPT on your Mac' })
      .hasAttribute('disabled'),
  ).toBe(true);
  first.unmount();
  render(<AdviserSubscriptions onAccountsChanged={mocks.changed} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage adviser accounts' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel sign-in' }));
  await screen.findByText('Sign-in cancelled.');
  expect(
    screen
      .getByRole('button', { name: 'Continue with ChatGPT on your Mac' })
      .hasAttribute('disabled'),
  ).toBe(false);
  expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/start'))).toBe(false);
  expect(mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/cancel'))).toHaveLength(1);
});
it('recovers a pending attempt on refresh after the sign-in response is lost', async () => {
  let pending = false;
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/start')) {
      pending = true;
      throw Error('Lost response');
    }
    return new Response(
      JSON.stringify({
        enabled: true,
        accounts: [],
        pendingAttempt: pending ? { id: 'accepted-attempt', state: 'pending' } : null,
      }),
    );
  });
  render(<AdviserSubscriptions onAccountsChanged={mocks.changed} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage adviser accounts' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT on your Mac' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh adviser accounts' }));
  await screen.findByRole('button', { name: 'Cancel sign-in' });
  expect(
    screen
      .getByRole('button', { name: 'Continue with ChatGPT on your Mac' })
      .hasAttribute('disabled'),
  ).toBe(true);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/start'))).toHaveLength(1);
});
it('does not discard a known pending attempt when an older snapshot omits recovery metadata', async () => {
  mocks.fetch.mockImplementation(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.endsWith('/start')
            ? { id: 'known-attempt', state: 'pending' }
            : { enabled: true, accounts: [] },
        ),
      ),
  );
  render(<AdviserSubscriptions onAccountsChanged={mocks.changed} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage adviser accounts' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT on your Mac' }));
  await screen.findByRole('button', { name: 'Cancel sign-in' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh adviser accounts' }));
  await waitFor(() => expect(mocks.changed).toHaveBeenCalled());
  expect(screen.getByRole('button', { name: 'Cancel sign-in' })).toBeTruthy();
  expect(
    screen
      .getByRole('button', { name: 'Continue with ChatGPT on your Mac' })
      .hasAttribute('disabled'),
  ).toBe(true);
});
it('continues polling a recovered host-owned attempt until it completes', async () => {
  vi.useFakeTimers();
  let completed = false;
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/attempts/recovered-attempt')) {
      completed = true;
      return new Response(JSON.stringify({ id: 'recovered-attempt', state: 'connected' }));
    }
    return new Response(
      JSON.stringify({
        enabled: true,
        accounts: [],
        pendingAttempt: completed ? null : { id: 'recovered-attempt', state: 'pending' },
      }),
    );
  });
  await act(async () => {
    render(<AdviserSubscriptions onAccountsChanged={mocks.changed} />);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Manage adviser accounts' }));
  expect(screen.getByRole('button', { name: 'Cancel sign-in' })).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getByRole('status').textContent).toContain('ChatGPT adviser connected');
  expect(screen.queryByRole('button', { name: 'Cancel sign-in' })).toBeNull();
  expect(mocks.changed).toHaveBeenCalledTimes(1);
  expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/start'))).toBe(false);
});
it('keeps a newer host-owned pending attempt when an older completed poll refreshes accounts', async () => {
  vi.useFakeTimers();
  let current = 'attempt-a';
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/attempts/attempt-a')) {
      current = 'attempt-b';
      return new Response(JSON.stringify({ id: 'attempt-a', state: 'connected' }));
    }
    if (url.endsWith('/attempts/attempt-b'))
      return new Response(JSON.stringify({ id: 'attempt-b', state: 'pending' }));
    if (url.endsWith('/cancel')) return new Response(JSON.stringify({ ok: true }));
    return new Response(
      JSON.stringify({
        enabled: true,
        accounts: [],
        pendingAttempt: { id: current, state: 'pending' },
      }),
    );
  });
  await act(async () => {
    render(<AdviserSubscriptions onAccountsChanged={mocks.changed} />);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Manage adviser accounts' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getByRole('status').textContent).toBe('Finish sign-in in the browser on your Mac.');
  expect(
    screen
      .getByRole('button', { name: 'Continue with ChatGPT on your Mac' })
      .hasAttribute('disabled'),
  ).toBe(true);
  expect(screen.getByRole('button', { name: 'Cancel sign-in' }).hasAttribute('disabled')).toBe(
    false,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/attempts/attempt-b'))).toBe(true);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
  });
  expect(
    mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/cancel')).map(([url]) => url),
  ).toEqual(['/api/terminals/subscriptions/attempts/attempt-b/cancel']);
  expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/start'))).toBe(false);
});
it('ignores an older completion refresh after cancellation and a newer local sign-in', async () => {
  vi.useFakeTimers();
  let reads = 0;
  let current: string | null = 'attempt-a';
  let finishRefresh!: (response: Response) => void;
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/attempts/attempt-a'))
      return new Response(JSON.stringify({ id: 'attempt-a', state: 'connected' }));
    if (url.endsWith('/start')) {
      current = 'attempt-b';
      return new Response(JSON.stringify({ id: 'attempt-b', state: 'pending' }));
    }
    if (url.endsWith('/cancel')) {
      current = null;
      return new Response(JSON.stringify({ ok: true }));
    }
    if (url.endsWith('/attempts/attempt-b'))
      return new Response(JSON.stringify({ id: 'attempt-b', state: 'pending' }));
    if (++reads === 2)
      return new Promise<Response>((resolve) => {
        finishRefresh = resolve;
      });
    return new Response(
      JSON.stringify({
        enabled: true,
        accounts: [],
        pendingAttempt: current ? { id: current, state: 'pending' } : null,
      }),
    );
  });
  await act(async () => {
    render(<AdviserSubscriptions onAccountsChanged={mocks.changed} />);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Manage adviser accounts' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT on your Mac' }));
  });
  await act(async () => {
    finishRefresh(
      new Response(JSON.stringify({ enabled: true, accounts: [], pendingAttempt: null })),
    );
  });
  expect(screen.getByRole('status').textContent).toBe('Finish sign-in in the browser on your Mac.');
  expect(
    screen
      .getByRole('button', { name: 'Continue with ChatGPT on your Mac' })
      .hasAttribute('disabled'),
  ).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/attempts/attempt-b'))).toBe(true);
  expect(mocks.changed).not.toHaveBeenCalled();
});
it('preserves a newer host attempt when Cancel of the previous attempt completes late', async () => {
  vi.useFakeTimers();
  let current = 'attempt-a';
  let finishPoll!: (response: Response) => void;
  let finishCancel!: (response: Response) => void;
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/attempts/attempt-a'))
      return new Promise<Response>((resolve) => {
        finishPoll = resolve;
      });
    if (url.endsWith('/attempts/attempt-a/cancel'))
      return new Promise<Response>((resolve) => {
        finishCancel = resolve;
      });
    if (url.endsWith('/attempts/attempt-b'))
      return new Response(JSON.stringify({ id: 'attempt-b', state: 'pending' }));
    if (url.endsWith('/attempts/attempt-b/cancel'))
      return new Response(JSON.stringify({ ok: true }));
    return new Response(
      JSON.stringify({
        enabled: true,
        accounts: [],
        pendingAttempt: { id: current, state: 'pending' },
      }),
    );
  });
  await act(async () => {
    render(<AdviserSubscriptions onAccountsChanged={mocks.changed} />);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Manage adviser accounts' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
  });
  current = 'attempt-b';
  await act(async () => {
    finishPoll(new Response(JSON.stringify({ id: 'attempt-a', state: 'connected' })));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(
    mocks.fetch.mock.calls.filter(([url]) => url === '/api/terminals/subscriptions'),
  ).toHaveLength(1);
  expect(
    mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/attempts/attempt-a')),
  ).toHaveLength(1);
  await act(async () => {
    finishCancel(new Response(JSON.stringify({ ok: true })));
  });
  expect(screen.getByRole('status').textContent).toBe('Finish sign-in in the browser on your Mac.');
  expect(screen.getByRole('button', { name: 'Cancel sign-in' }).hasAttribute('disabled')).toBe(
    false,
  );
  expect(
    screen
      .getByRole('button', { name: 'Continue with ChatGPT on your Mac' })
      .hasAttribute('disabled'),
  ).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/attempts/attempt-b'))).toBe(true);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
  });
  expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/attempts/attempt-b/cancel'))).toBe(
    true,
  );
  expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/start'))).toBe(false);
});
it('continues polling the original attempt after failed Cancel invalidates its completion refresh', async () => {
  vi.useFakeTimers();
  let reads = 0;
  let finishRefresh!: (response: Response) => void;
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/cancel')) return new Response('{}', { status: 500 });
    if (url.endsWith('/attempts/attempt-a'))
      return new Response(JSON.stringify({ id: 'attempt-a', state: 'connected' }));
    if (++reads === 2)
      return new Promise<Response>((resolve) => {
        finishRefresh = resolve;
      });
    return new Response(
      JSON.stringify({
        enabled: true,
        accounts: [],
        pendingAttempt: { id: 'attempt-a', state: 'pending' },
      }),
    );
  });
  await act(async () => {
    render(<AdviserSubscriptions onAccountsChanged={mocks.changed} />);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Manage adviser accounts' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
  });
  expect(screen.getByRole('alert').textContent).toContain('Account change could not be confirmed');
  await act(async () => {
    finishRefresh(
      new Response(JSON.stringify({ enabled: true, accounts: [], pendingAttempt: null })),
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(
    mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/attempts/attempt-a')),
  ).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Cancel sign-in' })).toBeTruthy();
});
it('keeps pending sign-in status when a disconnect refresh recovers an external attempt', async () => {
  let disconnected = false;
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/disconnect')) {
      disconnected = true;
      return new Response(JSON.stringify({ revoked: true }));
    }
    return new Response(
      JSON.stringify({
        enabled: true,
        accounts: [
          {
            id: 'plan',
            label: 'Personal',
            email: 'user@example.test',
            state: disconnected ? 'disconnected' : 'connected',
          },
        ],
        pendingAttempt: disconnected ? { id: 'external-attempt', state: 'pending' } : null,
      }),
    );
  });
  render(<AdviserSubscriptions onAccountsChanged={mocks.changed} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage adviser accounts' }));
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect Personal' }));
  await screen.findByRole('button', { name: 'Cancel sign-in' });
  expect(screen.getByRole('status').textContent).toBe('Finish sign-in in the browser on your Mac.');
  expect(
    screen
      .getByRole('button', { name: 'Continue with ChatGPT on your Mac' })
      .hasAttribute('disabled'),
  ).toBe(true);
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
