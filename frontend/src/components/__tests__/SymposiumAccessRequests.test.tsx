// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '../../lib/api-fetch';
import { SymposiumAccessRequests } from '../SymposiumAccessRequests';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../SymposiumReviewPanel', () => ({ SymposiumReviewPanel: () => <p>Artifact review</p> }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('shows the complete origin and addresses and sends only the immutable approval hash after a user click', async () => {
  const row = {
    id: 'request',
    hash: 'a'.repeat(64),
    kind: 'url',
    status: 'pending',
    seatName: 'Builder',
    accountId: 'vertex',
    model: 'test',
    input: {
      url: 'http://localhost:8123/page',
      origin: 'http://localhost:8123',
      reason: 'Read HA',
      resolvedAddresses: ['::1', '127.0.0.1'],
      access: 'Credential-free reads for 15 minutes',
    },
  };
  vi.mocked(apiFetch).mockImplementation(
    async (_path, init) =>
      ({ ok: true, json: async () => (init?.method ? { ok: true } : [row]) }) as Response,
  );
  render(<SymposiumAccessRequests sessionId="session" />);
  expect(await screen.findByText('http://localhost:8123/page')).toBeTruthy();
  expect(screen.getByText('::1, 127.0.0.1')).toBeTruthy();
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Allow website reads' }));
  await waitFor(() =>
    expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true),
  );
  const call = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(JSON.parse(call[1]!.body as string)).toEqual({ hash: row.hash, approved: true });
});
it('hands the suggestion to artifact review and clears its pending card without publishing', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => [
      {
        id: 'request',
        hash: 'a'.repeat(64),
        kind: 'publication',
        status: 'review_requested',
        seatName: 'Builder',
        accountId: 'api',
        model: 'test',
        input: {
          title: 'Publish fix',
          baseBranch: 'main',
          repositoryPath: '/sandbox/workspaces/mgmt',
          body: 'Change',
          draft: true,
        },
      },
    ],
  } as Response);
  render(<SymposiumAccessRequests sessionId="session" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open artifact review' }));
  await screen.findByText('Artifact review');
  const posts = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0][0]).toBe('/api/sessions/session/symposium/access-requests/request/handoff');
  expect(JSON.parse(posts[0][1]!.body as string)).toEqual({ hash: 'a'.repeat(64) });
  expect(screen.queryByText('Publish fix')).toBeNull();
});
