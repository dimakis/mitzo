// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WebSearchConsent } from '../WebSearchConsent';
import { apiFetch } from '../../lib/api-fetch';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});

const response = (grant: string, revision: number) =>
  ({
    ok: true,
    json: async () => ({ ok: true, grant, revision, updatedAt: null }),
  }) as Response;

it('shows the explicit provider-hosted choice and updates the revision-bound grant', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(response('unresolved', 0))
    .mockResolvedValueOnce(response('allowed', 1));
  render(
    <WebSearchConsent
      sessionId="session-1"
      mode="agent"
      connected
      connectionId="owner-1"
      running={false}
    />,
  );

  fireEvent.click(await screen.findByRole('button', { name: 'Web search permission: Choose' }));
  expect(screen.getByText(/model-generated searches to the model provider/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Allow for this conversation' }));

  await screen.findByRole('button', { name: 'Web search permission: Allowed' });
  expect(vi.mocked(apiFetch)).toHaveBeenNthCalledWith(
    1,
    '/api/chat/web-search-consent/session-1',
    expect.objectContaining({ headers: { 'X-Connection-ID': 'owner-1' } }),
  );
  expect(vi.mocked(apiFetch)).toHaveBeenNthCalledWith(
    2,
    '/api/chat/web-search-consent',
    expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Connection-ID': 'owner-1' },
      body: JSON.stringify({ sessionId: 'session-1', expectedRevision: 0, grant: 'allowed' }),
    }),
  );
});

it('keeps choices unavailable during a turn and explains Ask mode', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response('allowed', 2));
  const props = {
    sessionId: 'session-1',
    mode: 'ask' as const,
    connected: true,
    connectionId: 'owner-1',
  };
  const { rerender } = render(<WebSearchConsent {...props} running={false} />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Web search permission: Allowed (off in Ask)' }),
  );
  expect(screen.getByText(/stays off in Ask mode/)).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Allow for this conversation' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(screen.getByText(/Deny.*switch to Agent or Auto.*Allow/)).toBeTruthy();

  rerender(<WebSearchConsent {...props} running />);
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Deny' }).hasAttribute('disabled')).toBe(true);
  });
});

it('keeps consent visible for a watcher without taking control', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        grant: 'unresolved',
        revision: 0,
        updatedAt: null,
      }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, grant: 'allowed', revision: 1, updatedAt: 123 }),
    } as Response);
  render(
    <WebSearchConsent
      sessionId="session-1"
      mode="agent"
      connected
      connectionId="watcher"
      running={false}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Web search permission: Choose' }));
  expect(screen.getByText(/applies to the conversation in all tabs/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Allow for this conversation' }));
  await screen.findByRole('button', { name: 'Web search permission: Allowed' });
});

it('refreshes a grant changed in another tab when this window regains focus', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(response('allowed', 4))
    .mockResolvedValueOnce(response('denied', 5));
  render(
    <WebSearchConsent
      sessionId="session-1"
      mode="agent"
      connected
      connectionId="watcher"
      running={false}
    />,
  );
  await screen.findByRole('button', { name: 'Web search permission: Allowed' });

  fireEvent.focus(window);

  await screen.findByRole('button', { name: 'Web search permission: Denied' });
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('refreshes a grant changed in another tab when this page becomes visible', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(response('denied', 5))
    .mockResolvedValueOnce(response('allowed', 6));
  render(
    <WebSearchConsent
      sessionId="session-1"
      mode="agent"
      connected
      connectionId="watcher"
      running={false}
    />,
  );
  await screen.findByRole('button', { name: 'Web search permission: Denied' });

  fireEvent(document, new Event('visibilitychange'));

  await screen.findByRole('button', { name: 'Web search permission: Allowed' });
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('denies access with the current revision', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(response('allowed', 4))
    .mockResolvedValueOnce(response('denied', 5));
  render(
    <WebSearchConsent
      sessionId="session-1"
      mode="agent"
      connected
      connectionId="watcher"
      running={false}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Web search permission: Allowed' }));
  fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
  await screen.findByRole('button', { name: 'Web search permission: Denied' });
  expect(vi.mocked(apiFetch)).toHaveBeenNthCalledWith(
    2,
    '/api/chat/web-search-consent',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ sessionId: 'session-1', expectedRevision: 4, grant: 'denied' }),
    }),
  );
});

it('shows the current consent during a running turn while keeping edits disabled', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response('denied', 3));
  render(
    <WebSearchConsent
      sessionId="session-1"
      mode="agent"
      connected
      connectionId="watcher"
      running
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Web search permission: Denied' }));
  expect(screen.getByRole('button', { name: 'Deny' }).hasAttribute('disabled')).toBe(true);
});

it('does not show the control for a session without a Codex grant', async () => {
  vi.useFakeTimers();
  vi.mocked(apiFetch)
    .mockResolvedValueOnce({ status: 404 } as Response)
    .mockResolvedValueOnce({ status: 404 } as Response)
    .mockResolvedValueOnce({ status: 404 } as Response)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ accountBinding: { provider: 'anthropic-vertex' } }),
    } as Response);
  try {
    render(
      <WebSearchConsent
        sessionId="other-provider"
        mode="agent"
        connected
        connectionId="owner-1"
        running={false}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(apiFetch).toHaveBeenCalledTimes(4);
    expect(screen.queryByText(/Web search permission:/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh setting' })).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it('offers retry when Codex startup exceeds the attach window', async () => {
  vi.useFakeTimers();
  vi.mocked(apiFetch)
    .mockResolvedValueOnce({ status: 404 } as Response)
    .mockResolvedValueOnce({ status: 404 } as Response)
    .mockResolvedValueOnce({ status: 404 } as Response)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ codexQueue: { connected: false } }),
    } as Response)
    .mockResolvedValueOnce(response('denied', 1));
  try {
    render(
      <WebSearchConsent
        sessionId="slow-codex"
        mode="agent"
        connected
        connectionId="owner-1"
        running={false}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole('button', { name: 'Refresh setting' })).toBeTruthy();
    expect(apiFetch).toHaveBeenNthCalledWith(4, '/api/sessions/slow-codex/meta', {
      signal: expect.any(AbortSignal),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh setting' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('button', { name: 'Web search permission: Denied' })).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledTimes(5);
  } finally {
    vi.useRealTimers();
  }
});

it('finds a Codex grant when ownership attaches after a session switch', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce({ status: 404 } as Response)
    .mockResolvedValueOnce(response('denied', 1));
  render(
    <WebSearchConsent
      sessionId="session-1"
      mode="agent"
      connected
      connectionId="owner-1"
      running={false}
    />,
  );
  await screen.findByRole('button', { name: 'Web search permission: Denied' });
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('reloads the grant after a revision conflict', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(response('unresolved', 0))
    .mockResolvedValueOnce({ ok: false, status: 409 } as Response)
    .mockResolvedValueOnce(response('denied', 1));
  render(
    <WebSearchConsent
      sessionId="session-1"
      mode="agent"
      connected
      connectionId="owner-1"
      running={false}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Web search permission: Choose' }));
  fireEvent.click(screen.getByRole('button', { name: 'Allow for this conversation' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Refresh setting' }));
  await screen.findByRole('button', { name: 'Web search permission: Denied' });
  expect(apiFetch).toHaveBeenCalledTimes(3);
});

it.each([
  ['a failed network request', () => Promise.reject(new TypeError('Load failed'))],
  ['a temporary server failure', () => Promise.resolve({ ok: false, status: 503 } as Response)],
])('recovers from %s during attachment', async (_name, failure) => {
  vi.useFakeTimers();
  vi.mocked(apiFetch).mockImplementationOnce(failure).mockResolvedValue(response('unresolved', 0));
  render(
    <WebSearchConsent
      sessionId="session-1"
      mode="agent"
      connected
      connectionId="owner-1"
      running={false}
    />,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getByRole('button', { name: 'Web search permission: Choose' })).toBeTruthy();
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('identifies rejected requests without displaying opaque server data', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: false, status: 403 } as Response);
  render(
    <WebSearchConsent
      sessionId="session-1"
      mode="agent"
      connected
      connectionId="owner-1"
      running={false}
    />,
  );
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Web access setting request was rejected (HTTP 403).',
  );
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

it('retries a failed load after the active turn finishes', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce({ ok: false, status: 403 } as Response)
    .mockResolvedValue(response('unresolved', 0));
  const props = {
    sessionId: 'session-1',
    mode: 'agent' as const,
    connected: true,
    connectionId: 'owner-1',
  };
  const { rerender } = render(<WebSearchConsent {...props} running />);
  await screen.findByRole('alert');
  rerender(<WebSearchConsent {...props} running={false} />);
  await screen.findByRole('button', { name: 'Web search permission: Choose' });
  expect(screen.queryByRole('alert')).toBeNull();
});

it('recovers when the pending load fails just after the active turn finishes', async () => {
  let complete: (value: Response) => void = () => {};
  vi.mocked(apiFetch)
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValue(response('unresolved', 0));
  const props = {
    sessionId: 'session-1',
    mode: 'agent' as const,
    connected: true,
    connectionId: 'owner-1',
  };
  const { rerender } = render(<WebSearchConsent {...props} running />);
  rerender(<WebSearchConsent {...props} running={false} />);
  await act(async () => {
    complete({ ok: false, status: 403 } as Response);
  });
  await screen.findByRole('button', { name: 'Web search permission: Choose' });
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('recovers when a refresh of an existing grant fails after turn completion', async () => {
  let complete: (value: Response) => void = () => {};
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(response('denied', 5))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValue(response('allowed', 6));
  const props = {
    sessionId: 'session-1',
    mode: 'agent' as const,
    connected: true,
    connectionId: 'owner-1',
  };
  const { rerender } = render(<WebSearchConsent {...props} running />);
  await screen.findByRole('button', { name: 'Web search permission: Denied' });
  fireEvent.focus(window);
  expect(apiFetch).toHaveBeenCalledTimes(2);
  rerender(<WebSearchConsent {...props} running={false} />);
  await act(async () => {
    complete({ ok: false, status: 403 } as Response);
  });
  await screen.findByRole('button', { name: 'Web search permission: Allowed' });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(apiFetch).toHaveBeenCalledTimes(3);
});

it('distinguishes an invalid response from a connection failure', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
  render(
    <WebSearchConsent
      sessionId="session-1"
      mode="agent"
      connected
      connectionId="owner-1"
      running={false}
    />,
  );
  expect((await screen.findByRole('alert')).textContent).toContain(
    'The server returned an invalid web access setting.',
  );
});

it('bounds retries when the server cannot be reached', async () => {
  vi.useFakeTimers();
  vi.mocked(apiFetch).mockRejectedValue(new TypeError('Load failed'));
  render(
    <WebSearchConsent
      sessionId="session-1"
      mode="agent"
      connected
      connectionId="owner-1"
      running={false}
    />,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(apiFetch).toHaveBeenCalledTimes(3);
  expect(screen.getByRole('alert').textContent).toContain('Cannot reach the server');
});

it('does not display raw metadata parse errors', async () => {
  vi.useFakeTimers();
  vi.mocked(apiFetch)
    .mockResolvedValueOnce({ status: 404 } as Response)
    .mockResolvedValueOnce({ status: 404 } as Response)
    .mockResolvedValueOnce({ status: 404 } as Response)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new SyntaxError('private response content');
      },
    } as unknown as Response);
  render(
    <WebSearchConsent
      sessionId="session-1"
      mode="agent"
      connected
      connectionId="owner-1"
      running={false}
    />,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getByRole('alert').textContent).not.toContain('private response content');
});
