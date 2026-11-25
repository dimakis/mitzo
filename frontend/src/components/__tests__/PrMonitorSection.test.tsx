// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PrMonitorSection } from '../PrMonitorSection';
import { monitorAuthorityFixture, monitorFixture } from '../../test-utils/pr-monitor-fixture';
import type { PrMonitorInventory } from '@mitzo/protocol';
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../../lib/api-fetch', () => ({
  apiFetch,
  AUTH_LOST_EVENT: 'mitzo:auth-lost',
  AUTH_RESTORED_EVENT: 'mitzo:auth-restored',
}));
vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: { onConnectionChange: () => () => {} },
}));
let data: PrMonitorInventory;
beforeEach(() => {
  data = {
    executionAvailable: true,
    executionDigest: 'd'.repeat(64),
    subscriptions: [monitorFixture()],
  };
  apiFetch.mockImplementation(async () => new Response(JSON.stringify(data)));
});
afterEach(() => {
  cleanup();
  window.dispatchEvent(new Event('mitzo:auth-lost'));
  vi.resetAllMocks();
  vi.useRealTimers();
});

it('shows exact evidence and separate unsupported controls, then reviews bounded Watch without autoactivation', async () => {
  render(<PrMonitorSection sessionId="chat" />);
  await screen.findByRole('link', { name: 'owner/repo #7' });
  expect(screen.getByText('a'.repeat(40), { selector: '.pr-monitor-facts code' })).toBeTruthy();
  expect(screen.getByText('CI: failed')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Auto-fix' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(
    (screen.getByRole('button', { name: 'Merge when ready' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(apiFetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Review Watch' }));
  fireEvent.change(screen.getByLabelText('Watch duration'), { target: { value: '30' } });
  fireEvent.change(screen.getByLabelText('App passphrase'), { target: { value: 'offline' } });
  apiFetch.mockImplementation(async (path, init) => {
    if (path.endsWith('/reauthorize'))
      return new Response(JSON.stringify({ csrf: 'proof', expiresAt: Date.now() + 60000 }));
    if (init?.method === 'POST') {
      data.subscriptions[0].subscription.watch = {
        id: crypto.randomUUID(),
        revision: 1,
        expiresAt: Date.now() + 1800000,
      };
      return new Response(JSON.stringify(monitorAuthorityFixture(data.subscriptions[0])));
    }
    return new Response(JSON.stringify(data));
  });
  fireEvent.click(screen.getByRole('button', { name: 'Allow read-only Watch' }));
  await waitFor(() =>
    expect(
      apiFetch.mock.calls.some(([path]) =>
        path.endsWith('/pr-watch/' + data.subscriptions[0].subscription.id),
      ),
    ).toBe(true),
  );
  const call = apiFetch.mock.calls.find(([path]) => path.includes('/pr-watch/'))!;
  expect(JSON.parse(call[1].body)).toMatchObject({
    expectedRevision: 1,
    expectedAuthorityRevision: 0,
    durationMinutes: 30,
    csrf: 'proof',
    reviewedScope: { githubPrincipalId: '42', connectionRevision: '1', prNodeId: 'pr-node' },
  });
  expect(apiFetch.mock.calls.some(([path]) => /auto-fix|merge/.test(path))).toBe(false);
});

it('keeps retained evidence visible on read failure and refreshes on reconnect without any mutation', async () => {
  render(<PrMonitorSection sessionId="chat" />);
  await screen.findByText('CI: failed');
  apiFetch.mockRejectedValue(Error('network'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh PR status' }));
  await screen.findByRole('alert');
  expect(screen.getByText('CI: failed')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Review Watch' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  data.subscriptions[0].refreshState = 'blocked';
  data.subscriptions[0].diagnostic = {
    code: 'connection_unavailable',
    stage: 'read',
    nextRefreshAt: null,
  };
  data.executionAvailable = false;
  apiFetch.mockResolvedValue(new Response(JSON.stringify(data)));
  fireEvent(window, new Event('online'));
  await screen.findByText(/Connection access is unavailable/);
  expect(screen.getByText(/Execution is unavailable/)).toBeTruthy();
  expect(apiFetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it('retries the exact durable revocation checkpoint after account loss and never reports a failed revoke as success', async () => {
  const p = data.subscriptions[0];
  p.subscription.watch = { id: crypto.randomUUID(), revision: 3, expiresAt: Date.now() + 60000 };
  p.revocationPending = {
    requestId: 'original-revoke',
    expectedRevision: 4,
    expectedAuthorityRevision: 3,
  };
  data.executionAvailable = false;
  apiFetch.mockImplementation(async (_path, init) =>
    init?.method === 'POST'
      ? new Response('{}', { status: 409 })
      : new Response(JSON.stringify(data)),
  );
  render(<PrMonitorSection sessionId="chat" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry stop Watch' }));
  await screen.findByText(/Stop Watch was not confirmed/);
  const posts = () => apiFetch.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(JSON.parse(posts()[0][1].body)).toEqual(p.revocationPending);
  fireEvent.click(screen.getByRole('button', { name: 'Retry stop Watch' }));
  await waitFor(() => expect(posts()).toHaveLength(2));
  expect(posts()[1][1].body).toEqual(posts()[0][1].body);
});

it('fences late responses across authentication loss and conversation changes', async () => {
  let resolve!: (response: Response) => void;
  apiFetch.mockImplementation(
    () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  const view = render(<PrMonitorSection sessionId="chat" />);
  fireEvent(window, new Event('mitzo:auth-lost'));
  resolve(new Response(JSON.stringify(data)));
  await screen.findByText(/Sign in and refresh PR status/);
  expect(screen.queryByRole('link', { name: 'owner/repo #7' })).toBeNull();
  apiFetch.mockResolvedValue(new Response(JSON.stringify({ ...data, subscriptions: [] })));
  view.rerender(<PrMonitorSection sessionId="second" />);
  await screen.findByText('No PRs are registered for this conversation.');
  expect(screen.queryByText('CI: failed')).toBeNull();
});

it('registers a PR paused and preserves the original request after an uncertain registration', async () => {
  data.subscriptions = [];
  apiFetch.mockImplementation(async (path, init) => {
    if (path === '/api/connections')
      return new Response(
        JSON.stringify({
          connections: [
            {
              id: '9c6bb0d4-081f-4f55-86f8-60c703452053',
              templateId: 'github-readonly',
              label: 'GitHub read-only',
              status: 'active',
              revision: 1,
            },
          ],
        }),
      );
    if (path.endsWith('/reauthorize'))
      return new Response(JSON.stringify({ csrf: 'proof', expiresAt: Date.now() + 60000 }));
    if (init?.method === 'POST') return new Response('{}', { status: 409 });
    return new Response(JSON.stringify(data));
  });
  const view = render(<PrMonitorSection sessionId="chat" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add PR' }));
  await screen.findByRole('option', { name: 'GitHub read-only' });
  fireEvent.change(screen.getByLabelText('GitHub connection'), {
    target: { value: '9c6bb0d4-081f-4f55-86f8-60c703452053' },
  });
  fireEvent.change(screen.getByLabelText('Pull request URL'), {
    target: { value: 'https://github.com/owner/repo/pull/7' },
  });
  fireEvent.change(screen.getByLabelText('App passphrase'), { target: { value: 'offline' } });
  fireEvent.click(screen.getByRole('button', { name: 'Register paused PR' }));
  await screen.findByText(/Registration was not confirmed/);
  const registrations = () =>
    apiFetch.mock.calls.filter(
      ([path, init]) => path.endsWith('/pr-monitor') && init?.method === 'POST',
    );
  expect(JSON.parse(registrations()[0][1].body)).toMatchObject({
    owner: 'owner',
    name: 'repo',
    pr: 7,
    expectedExecutionDigest: 'd'.repeat(64),
  });
  expect((screen.getByLabelText('Pull request URL') as HTMLInputElement).disabled).toBe(true);
  view.unmount();
  render(<PrMonitorSection sessionId="chat" />);
  await screen.findByRole('button', { name: 'Retry same registration' });
  fireEvent.change(screen.getByLabelText('App passphrase'), { target: { value: 'offline' } });
  fireEvent.click(screen.getByRole('button', { name: 'Retry same registration' }));
  await waitFor(() => expect(registrations()).toHaveLength(2));
  expect(registrations()[0][1].body).toEqual(registrations()[1][1].body);
  expect(apiFetch.mock.calls.some(([path]) => path.includes('/pr-watch/'))).toBe(false);
});

it('retains an uncertain Watch request through closing details and retries only that exact scope', async () => {
  const view = render(<PrMonitorSection sessionId="chat" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Review Watch' }));
  apiFetch.mockImplementation(async (path, init) => {
    if (path.endsWith('/reauthorize'))
      return new Response(JSON.stringify({ csrf: 'proof', expiresAt: Date.now() + 60000 }));
    if (init?.method === 'POST') return new Response('{}', { status: 409 });
    return new Response(JSON.stringify(data));
  });
  fireEvent.change(screen.getByLabelText('App passphrase'), { target: { value: 'offline' } });
  fireEvent.click(screen.getByRole('button', { name: 'Allow read-only Watch' }));
  await screen.findByText(/Watch change was not confirmed/);
  const posts = () => apiFetch.mock.calls.filter(([path]) => path.includes('/pr-watch/'));
  view.unmount();
  render(<PrMonitorSection sessionId="chat" />);
  await screen.findByRole('button', { name: 'Retry same Watch request' });
  fireEvent.change(screen.getByLabelText('App passphrase'), { target: { value: 'offline' } });
  fireEvent.click(screen.getByRole('button', { name: 'Retry same Watch request' }));
  await waitFor(() => expect(posts()).toHaveLength(2));
  expect(posts()[1][1].body).toEqual(posts()[0][1].body);
});

it('requires a new review after the authority scope changes while the review is open', async () => {
  render(<PrMonitorSection sessionId="chat" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Review Watch' }));
  fireEvent.change(screen.getByLabelText('App passphrase'), { target: { value: 'offline' } });
  data.subscriptions[0].subscription.github.identityRevision = '2';
  fireEvent.click(screen.getByRole('button', { name: 'Refresh PR status' }));
  await screen.findByText(/Access changed since this review/);
  expect(
    (screen.getByRole('button', { name: 'Allow read-only Watch' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(apiFetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it('does not issue Watch from reauthorization that completes after logout', async () => {
  render(<PrMonitorSection sessionId="chat" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Review Watch' }));
  fireEvent.change(screen.getByLabelText('App passphrase'), { target: { value: 'offline' } });
  let complete!: (r: Response) => void;
  apiFetch.mockImplementation(
    () =>
      new Promise<Response>((r) => {
        complete = r;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Allow read-only Watch' }));
  fireEvent(window, new Event('mitzo:auth-lost'));
  await act(async () =>
    complete(new Response(JSON.stringify({ csrf: 'late', expiresAt: Date.now() + 60000 }))),
  );
  expect(apiFetch.mock.calls.some(([path]) => path.includes('/pr-watch/'))).toBe(false);
  expect(screen.queryByLabelText('App passphrase')).toBeNull();
});

it('bounds a read that ignores cancellation and rejects its late successful response', async () => {
  vi.useFakeTimers();
  let complete!: (r: Response) => void;
  apiFetch.mockImplementation(
    () =>
      new Promise<Response>((r) => {
        complete = r;
      }),
  );
  render(<PrMonitorSection sessionId="chat" />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15001);
  });
  expect(screen.getByRole('alert').textContent).toContain('timed out');
  await act(async () => complete(new Response(JSON.stringify(data))));
  expect(screen.queryByText('CI: failed')).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('timed out');
});

it('shows expired authority and never offers renewed Watch on a merged PR', async () => {
  const p = data.subscriptions[0];
  p.subscription.watch = { id: p.subscription.id, revision: 2, expiresAt: Date.now() - 1 };
  p.subscription.lifecycle = 'merged';
  p.snapshot!.state = 'merged';
  render(<PrMonitorSection sessionId="chat" />);
  await screen.findByText('Expired');
  expect(
    (screen.getByRole('button', { name: 'Review Watch renewal' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(apiFetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it('distinguishes a persisted revocation from a paused or expired Watch', async () => {
  const p = data.subscriptions[0];
  p.subscription.watch = { id: p.subscription.id, revision: 3, expiresAt: Date.now() + 60000 };
  p.watchRevokedAt = Date.now() - 1000;
  render(<PrMonitorSection sessionId="chat" />);
  await screen.findByText(/^Revoked/);
  expect(screen.queryByRole('button', { name: 'Stop Watch' })).toBeNull();
  expect(
    (screen.getByRole('button', { name: 'Review Watch renewal' }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

it('allows another explicit authorization attempt when reauthorization failed before any Watch request', async () => {
  render(<PrMonitorSection sessionId="chat" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Review Watch' }));
  fireEvent.change(screen.getByLabelText('App passphrase'), { target: { value: 'wrong' } });
  apiFetch.mockImplementation(async (path) =>
    path.endsWith('/reauthorize')
      ? new Response('{}', { status: 403 })
      : new Response(JSON.stringify(data)),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Allow read-only Watch' }));
  await screen.findByText(/Watch was not changed/);
  fireEvent.change(screen.getByLabelText('App passphrase'), { target: { value: 'correct' } });
  expect(
    (screen.getByRole('button', { name: 'Allow read-only Watch' }) as HTMLButtonElement).disabled,
  ).toBe(false);
  expect(apiFetch.mock.calls.some(([path]) => path.includes('/pr-watch/'))).toBe(false);
});
