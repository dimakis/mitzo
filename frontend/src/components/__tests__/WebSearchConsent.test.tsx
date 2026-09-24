// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WebSearchConsent } from '../WebSearchConsent';
import { apiFetch } from '../../lib/api-fetch';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const response = (grant: string, revision: number) =>
  ({ ok: true, json: async () => ({ ok: true, grant, revision, updatedAt: null }) }) as Response;

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

  rerender(<WebSearchConsent {...props} running />);
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Deny' }).hasAttribute('disabled')).toBe(true);
  });
});

it('does not show the control for a session without a Codex grant', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ status: 404 } as Response);
  render(
    <WebSearchConsent
      sessionId="other-provider"
      mode="agent"
      connected
      connectionId="owner-1"
      running={false}
    />,
  );
  await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
  expect(screen.queryByText(/Web search permission:/)).toBeNull();
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
