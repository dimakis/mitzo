// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConnectionsAccessView } from '../ConnectionsAccessView';
import { getConnectionsAccess } from '../../lib/connections-access-api';
import type { ConnectionsAccessInventory } from '../../types/connections-access';
import { act } from 'react';

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

it('refreshes unavailable sources while retaining loaded rows and replaces recovered source state', async () => {
  const current: ConnectionsAccessInventory = {
    generatedAt: 1,
    sources: [
      {
        id: 'google' as const,
        state: 'unavailable' as const,
        reason: 'Google source is unavailable.',
      },
    ],
    resources: [
      {
        id: 'account',
        kind: 'ai-account' as const,
        section: 'accounts' as const,
        owner: 'accounts',
        nativeId: 'work',
        gateway: null,
        workspace: null,
        label: 'Work account',
        provider: 'OpenAI',
        status: 'configured',
        revision: null,
        accountIdentity: null,
        verification: { state: 'unverified' as const, verifiedAt: null, reason: null },
        access: {
          summary: 'Configured model access',
          desiredAccountIds: [],
          observedAttachments: null,
          appliesTo: 'New conversations',
        },
        actions: [],
        details: {},
      },
    ],
  };
  let recover!: (value: ConnectionsAccessInventory) => void;
  vi.mocked(getConnectionsAccess)
    .mockResolvedValueOnce(current)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          recover = resolve;
        }),
    );
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  await screen.findByRole('article', { name: 'Work account' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh access' }));
  expect(screen.getByText('Refreshing access…')).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: 'Refresh access' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.getByRole('article', { name: 'Work account' })).toBeTruthy();
  await act(async () =>
    recover({
      ...current,
      generatedAt: 2,
      sources: [{ id: 'google', state: 'available', reason: null }],
    }),
  );
  await screen.findByText('No services were reported by available sources.');
  await vi.waitFor(() => expect(screen.queryByText('Google source is unavailable.')).toBeNull());
  expect(screen.getByRole('article', { name: 'Work account' })).toBeTruthy();
});

it('marks retained inventory as older when a refresh fails and allows recovery', async () => {
  vi.mocked(getConnectionsAccess)
    .mockResolvedValueOnce({ generatedAt: 1, sources: [], resources: [] })
    .mockRejectedValueOnce(new Error('Unavailable'))
    .mockResolvedValueOnce({ generatedAt: 2, sources: [], resources: [] });
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  await screen.findByText('No AI accounts were reported by available sources.');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh access' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Showing older results. Current access could not be refreshed.',
  );
  expect(screen.getByRole('heading', { name: 'AI accounts' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(getConnectionsAccess).toHaveBeenCalledTimes(3);
});
