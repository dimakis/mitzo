// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConnectionsAccessView } from '../ConnectionsAccessView';
import { getConnectionsAccess } from '../../lib/connections-access-api';

vi.mock('../../lib/connections-access-api', () => ({ getConnectionsAccess: vi.fn() }));
afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());

it('keeps configured assignments separate from verification and observed conversation access', async () => {
  vi.mocked(getConnectionsAccess).mockResolvedValue({
    generatedAt: 1_700_000_000_000,
    sources: [{ id: 'managed', state: 'available', reason: null }],
    resources: [
      {
        id: 'managed-jira',
        kind: 'managed-connection',
        section: 'services',
        provider: 'jira',
        revision: null,
        label: 'Jira',
        owner: 'managed-connections',
        gateway: 'primary',
        workspace: null,
        nativeId: 'jira-1',
        status: 'configured',
        accountIdentity: 'person@example.com',
        verification: {
          state: 'unverified',
          verifiedAt: null,
          reason: 'Identity has not been verified.',
        },
        access: {
          summary: 'Read Jira metadata',
          desiredAccountIds: ['work'],
          observedAttachments: null,
          appliesTo: 'New conversations only',
        },
        actions: [{ id: 'manage', label: 'Manage Jira', href: '/connections' }],
        details: {},
      },
    ],
  });
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  const card = await screen.findByRole('article', { name: 'Jira' });
  expect(within(card).getByText('Configured')).toBeTruthy();
  expect(within(card).getByText('Not verified')).toBeTruthy();
  expect(within(card).getByText('work')).toBeTruthy();
  expect(within(card).getByText(/Conversation attachments have not been observed/)).toBeTruthy();
  expect(within(card).getByRole('link', { name: 'Manage Jira' }).getAttribute('href')).toBe(
    '/connections',
  );
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByText('Healthy')).toBeNull();
});

it('retains working resource groups when a source is unavailable and explains web access boundaries', async () => {
  vi.mocked(getConnectionsAccess).mockResolvedValue({
    generatedAt: 1_700_000_000_000,
    resources: [],
    sources: [{ id: 'google', state: 'unavailable', reason: 'Management service unavailable.' }],
  });
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  expect(await screen.findByText('Management service unavailable.')).toBeTruthy();
  for (const name of ['AI accounts', 'Services', 'Web access'])
    expect(screen.getByRole('heading', { name })).toBeTruthy();
  expect(screen.getByText(/One approved website read/)).toBeTruthy();
  expect(screen.getByText(/Persistent sandbox website access/)).toBeTruthy();
  expect(screen.queryByText(/Web access enabled/)).toBeNull();
});

it('offers retry after a failed inventory read, without losing management navigation', async () => {
  vi.mocked(getConnectionsAccess)
    .mockRejectedValueOnce(new Error('Unavailable'))
    .mockResolvedValueOnce({
      generatedAt: 1_700_000_000_000,
      resources: [],
      sources: [],
    });
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Manage connections' }).getAttribute('href')).toBe(
    '/connections',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(
    await screen.findByText('No AI accounts were reported by available sources.'),
  ).toBeTruthy();
  expect(getConnectionsAccess).toHaveBeenCalledTimes(2);
});
