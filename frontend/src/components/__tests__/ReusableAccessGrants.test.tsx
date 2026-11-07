// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReusableAccessGrants } from '../ReusableAccessGrants';
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../../lib/api-fetch', () => ({
  apiFetch,
  AUTH_LOST_EVENT: 'mitzo:auth-lost',
  AUTH_RESTORED_EVENT: 'mitzo:auth-restored',
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const inventory = () => ({
  sessionId: 'one',
  observedAt: Date.now(),
  grants: [],
  sessions: [
    {
      sessionId: 'one',
      title: 'This task',
      cwd: '/task/one',
      account: 'account',
      mode: 'agent',
      revision: '1'.repeat(64),
      development: true,
    },
    {
      sessionId: 'two',
      title: 'Another task',
      cwd: '/task/two',
      account: 'account',
      mode: 'agent',
      revision: '2'.repeat(64),
      development: true,
    },
  ],
  automaticReview: {
    state: 'unavailable',
    reason: 'No qualified reviewer/account route. Human review handles remaining requests.',
  },
});
it('creates explicit expiring access for selected sessions and revokes the returned grant', async () => {
  const state = inventory();
  let grants: unknown[] = [];
  apiFetch.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (init?.method === 'POST')
      grants = [
        {
          id: 'grant',
          capability: { kind: 'public-web' },
          sessionIds: ['one', 'two'],
          expiresAt: Date.now() + 60 * 60000,
        },
      ];
    if (init?.method === 'DELETE') grants = [];
    return { ok: true, json: async () => ({ ...state, observedAt: Date.now(), grants }) };
  });
  render(<ReusableAccessGrants sessionId="one" connected />);
  expect(apiFetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Manage reusable access' }));
  await screen.findByText(/No qualified reviewer/);
  fireEvent.change(screen.getByLabelText('Access type'), { target: { value: 'public-web' } });
  fireEvent.click(screen.getByLabelText('Another task'));
  fireEvent.click(screen.getByRole('button', { name: 'Grant access' }));
  await screen.findByRole('button', { name: /Revoke Public websites/ });
  const post = apiFetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(JSON.parse(post[1].body)).toEqual({
    sessionIds: ['one', 'two'],
    capability: { kind: 'public-web' },
    durationMinutes: 60,
    expectedContexts: { one: '1'.repeat(64), two: '2'.repeat(64) },
  });
  expect(post[1].headers).toMatchObject({ 'X-Mitzo-Access-Intent': 'manage-grants' });
  expect(screen.getByText(/^Expires \d/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Revoke Public websites/ }));
  await waitFor(() =>
    expect(apiFetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true),
  );
});
it('invalidates pending observations on authentication changes without sending a grant', async () => {
  let release!: (value: unknown) => void;
  apiFetch.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  render(<ReusableAccessGrants sessionId="one" connected />);
  fireEvent.click(screen.getByRole('button', { name: 'Manage reusable access' }));
  window.dispatchEvent(new Event('mitzo:auth-lost'));
  release({ ok: true, json: async () => inventory() });
  await screen.findByText(/Authentication changed/);
  expect(screen.queryByRole('button', { name: 'Grant access' })).toBeNull();
  expect(apiFetch).toHaveBeenCalledTimes(1);
});
it('preserves an uncertain grant request until explicit refresh instead of repeating it', async () => {
  apiFetch.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (init?.method === 'POST') throw Error('response lost');
    return { ok: true, json: async () => inventory() };
  });
  render(<ReusableAccessGrants sessionId="one" connected />);
  fireEvent.click(screen.getByRole('button', { name: 'Manage reusable access' }));
  await screen.findByRole('button', { name: 'Grant access' });
  fireEvent.click(screen.getByRole('button', { name: 'Grant access' }));
  await screen.findByText(/Refresh grants to check whether/);
  expect((screen.getByRole('button', { name: 'Grant access' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});
