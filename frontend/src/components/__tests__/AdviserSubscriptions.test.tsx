// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
afterEach(cleanup);
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
