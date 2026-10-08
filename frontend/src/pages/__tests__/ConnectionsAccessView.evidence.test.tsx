// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionsAccessView } from '../ConnectionsAccessView';
import { getConnectionsAccess } from '../../lib/connections-access-api';
import type { AccessResource } from '../../types/connections-access';
vi.mock('../../lib/connections-access-api', () => ({ getConnectionsAccess: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const account: AccessResource = {
  id: 'work',
  kind: 'ai-account',
  section: 'accounts',
  owner: 'account-profiles',
  nativeId: 'work',
  gateway: null,
  workspace: null,
  label: 'Work Vertex',
  provider: 'anthropic-vertex',
  status: 'configured',
  revision: null,
  accountIdentity: null,
  verification: { state: 'unverified', verifiedAt: null, reason: null },
  access: {
    summary: 'Configured models',
    desiredAccountIds: [],
    observedAttachments: null,
    appliesTo: 'New conversations',
  },
  actions: [],
  details: {},
  lastSuccessfulUse: { model: 'luna', succeededAt: 100 },
};
it('shows working-account evidence without unused integration banners or a blanket unverified warning', async () => {
  vi.mocked(getConnectionsAccess).mockResolvedValue({
    generatedAt: Date.now(),
    resources: [account],
    sources: [
      { id: 'accounts', state: 'available', reason: null },
      {
        id: 'symposiumAccounts',
        state: 'not-configured',
        reason: 'This source is not configured.',
      },
      { id: 'personal', state: 'not-configured', reason: 'This source is not configured.' },
      { id: 'google', state: 'not-configured', reason: 'This source is not configured.' },
    ],
  });
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  const row = await screen.findByRole('article', { name: 'Work Vertex' });
  expect(within(row).getByText('Set up')).toBeTruthy();
  expect(within(row).getByText(/Last used successfully/)).toBeTruthy();
  expect(
    screen.queryByText(/Not verified|Not configured|This source is not configured/),
  ).toBeNull();
  expect(screen.getByText('How web access works')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Website access' })).toBeNull();
  fireEvent.click(within(row).getByRole('button', { name: 'Manage Work Vertex' }));
  expect(within(screen.getByRole('dialog')).getByText('luna')).toBeTruthy();
});
it('shows service identity, repository scope and distinct additional GitHub access', async () => {
  const github: AccessResource = {
    ...account,
    id: 'github-managed',
    kind: 'managed-connection',
    section: 'services',
    label: 'GitHub · dimakis/mgmt',
    provider: 'github-readonly',
    status: 'active',
    accountIdentity: 'dimakis',
    lastSuccessfulUse: undefined,
    verification: { state: 'stale', verifiedAt: 100, reason: null },
    details: {
      serviceName: 'GitHub',
      scope: { allowedRepositories: ['dimakis/mgmt'] },
      permissions: ['Repository reads'],
    },
  };
  vi.mocked(getConnectionsAccess).mockResolvedValue({
    generatedAt: Date.now(),
    sources: [],
    resources: [
      github,
      {
        ...github,
        id: 'legacy',
        nativeId: 'github',
        kind: 'legacy-provider',
        label: 'github',
        status: 'operator-managed',
        accountIdentity: null,
        details: { serviceName: 'GitHub' },
      },
    ],
  });
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  const row = await screen.findByRole('article', { name: 'GitHub · dimakis/mgmt' });
  expect(within(row).getByText('Connection enabled')).toBeTruthy();
  expect(within(row).getByText('PR repositories: dimakis/mgmt')).toBeTruthy();
  expect(within(row).getByText('Repository reads')).toBeTruthy();
  expect(screen.getByRole('article', { name: 'GitHub · additional connection' })).toBeTruthy();
  expect(screen.queryByText('Verification is stale')).toBeNull();
});

it('shows completed account use without inventing a model when the provider does not report it', async () => {
  vi.mocked(getConnectionsAccess).mockResolvedValue({
    generatedAt: Date.now(),
    sources: [],
    resources: [{ ...account, lastSuccessfulUse: { model: null, succeededAt: 100 } }],
  });
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  const row = await screen.findByRole('article', { name: 'Work Vertex' });
  expect(within(row).getByText(/Last used successfully/)).toBeTruthy();
  fireEvent.click(within(row).getByRole('button', { name: 'Manage Work Vertex' }));
  expect(within(screen.getByRole('dialog')).getByText('Model not recorded')).toBeTruthy();
});

it('labels a retained provider-grant check as connection evidence in the list and details', async () => {
  vi.mocked(getConnectionsAccess).mockResolvedValue({
    generatedAt: Date.now(),
    sources: [],
    resources: [
      {
        ...account,
        lastSuccessfulUse: undefined,
        signIn: {
          status: 'verified',
          source: 'openshell-provider-grant',
          checkedAt: Date.now() - 6 * 60_000,
          configuredIdentity: { email: '', planType: '' },
          observedIdentity: null,
          profileRevision: 'route',
          explanation: 'Provider grant is valid.',
        },
      },
    ],
  });
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  const row = await screen.findByRole('article', { name: 'Work Vertex' });
  expect(within(row).getByText('Connection check: Last connection check passed')).toBeTruthy();
  fireEvent.click(within(row).getByRole('button', { name: 'Manage Work Vertex' }));
  const dialog = within(screen.getByRole('dialog'));
  expect(dialog.getByRole('region', { name: 'Connection check details' })).toBeTruthy();
  expect(dialog.getByText('Last connection check')).toBeTruthy();
  expect(dialog.getByText(/The last connection check passed/)).toBeTruthy();
  expect(dialog.queryByText(/sign-in/i)).toBeNull();
});

it('shows Jira configured email while keeping an arbitrary provider ID only in technical details', async () => {
  vi.mocked(getConnectionsAccess).mockResolvedValue({
    generatedAt: Date.now(),
    sources: [],
    resources: [
      {
        ...account,
        id: 'jira',
        kind: 'managed-connection',
        section: 'services',
        label: 'Jira',
        provider: 'jira',
        lastSuccessfulUse: undefined,
        accountIdentity: '712020:opaque-account-id',
        details: { serviceName: 'Jira', configuredIdentity: 'person@example.test' },
      },
    ],
  });
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  const row = await screen.findByRole('article', { name: 'Jira' });
  expect(within(row).getByText('Configured account: person@example.test')).toBeTruthy();
  expect(within(row).queryByText('712020:opaque-account-id')).toBeNull();
  fireEvent.click(within(row).getByRole('button', { name: 'Manage Jira' }));
  const dialog = within(screen.getByRole('dialog'));
  const accountDetails = within(dialog.getByRole('region', { name: 'Account details' }));
  expect(accountDetails.getByText('Configured account: person@example.test')).toBeTruthy();
  expect(accountDetails.queryByText('712020:opaque-account-id')).toBeNull();
  expect(dialog.getByText('Provider account ID')).toBeTruthy();
  expect(dialog.getByText('712020:opaque-account-id')).toBeTruthy();
});
