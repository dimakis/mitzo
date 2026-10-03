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
  const row = await screen.findByRole('article', { name: 'Jira' });
  expect(within(row).queryByText('Configured assignments')).toBeNull();
  expect(within(row).queryByText('Management owner')).toBeNull();
  fireEvent.click(within(row).getByRole('button', { name: 'Manage Jira' }));
  const card = screen.getByRole('dialog', { name: 'Jira' });
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
  for (const name of ['AI accounts', 'Services', 'Website access'])
    expect(screen.getByRole('heading', { name })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'View Public page reads' }));
  expect(screen.getByText(/One approved website read/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
  fireEvent.click(screen.getByRole('button', { name: 'View Sandbox network policies' }));
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
  expect(screen.getByRole('link', { name: 'Add connection' }).getAttribute('href')).toBe(
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

it('distinguishes ordinary and Symposium accounts with the same native profile ID', async () => {
  const profile = {
    kind: 'ai-account' as const,
    section: 'accounts' as const,
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
      summary: 'Configured models',
      desiredAccountIds: [],
      observedAttachments: null,
      appliesTo: 'New conversations',
    },
    actions: [],
    details: {},
  };
  vi.mocked(getConnectionsAccess).mockResolvedValue({
    generatedAt: 1,
    sources: [],
    resources: [
      { ...profile, id: 'primary/work', owner: 'account-profiles' },
      { ...profile, id: 'symposium/work', owner: 'symposium-account-profiles' },
    ],
  });
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  const accounts = await screen.findAllByRole('article', { name: 'Work account' });
  expect(accounts).toHaveLength(2);
  expect(within(accounts[0]).getByText('Ordinary chats')).toBeTruthy();
  expect(within(accounts[1]).getByText('Symposium')).toBeTruthy();
  expect(within(accounts[0]).queryByText('account-profiles')).toBeNull();
  fireEvent.click(within(accounts[0]).getByRole('button', { name: 'Manage Work account' }));
  expect(within(screen.getByRole('dialog')).getByText('account-profiles')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
  fireEvent.click(within(accounts[1]).getByRole('button', { name: 'Manage Work account' }));
  expect(within(screen.getByRole('dialog')).getByText('symposium-account-profiles')).toBeTruthy();
});

it('names an unavailable Symposium catalog separately from ordinary AI accounts', async () => {
  vi.mocked(getConnectionsAccess).mockResolvedValue({
    generatedAt: 1,
    resources: [],
    sources: [
      {
        id: 'symposiumAccounts',
        state: 'unavailable',
        reason: 'This source could not be checked. Retry later.',
      },
    ],
  });
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  expect(await screen.findByText('Symposium AI accounts: Source unavailable')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Refresh access' })).toBeTruthy();
});

function linkedFacets(
  linkState: 'current' | 'stale' | 'unavailable' = 'current',
): ConnectionsAccessInventory {
  const common = {
    section: 'accounts' as const,
    nativeId: 'same',
    label: 'Personal account',
    provider: 'openai-codex',
    gateway: null,
    workspace: null,
    accountIdentity: null,
    verification: {
      state: 'unverified' as const,
      verifiedAt: null,
      reason: 'Current effective access has not been checked.',
    },
    access: {
      summary: 'Personal ChatGPT connection',
      desiredAccountIds: [],
      observedAttachments: null,
      appliesTo: 'Not checked for existing conversations',
    },
    actions: [],
    details: {},
  };
  return {
    generatedAt: 1,
    sources: [
      { id: 'personal', state: 'available', reason: null },
      { id: 'symposiumAccounts', state: 'available', reason: null },
    ],
    resources: [
      {
        ...common,
        id: 'catalog',
        kind: 'ai-account',
        owner: 'symposium-account-profiles',
        status: 'configured',
        revision: null,
        personalConnection: { resourceId: 'personal', revision: 3, state: linkState },
        details: {
          billing: 'chatgpt-subscription',
          models: [{ id: 'luna', label: 'Configured Luna' }],
        },
      },
      {
        ...common,
        id: 'personal',
        kind: 'personal-connection',
        owner: 'symposium-personal',
        status: 'connected',
        revision: 3,
        accountIdentity: 'signed-in@example.test',
        details: { billing: 'ChatGPT pro' },
        actions: [
          {
            id: 'personal-controls',
            label: 'Open personal account controls',
            href: '/connections',
          },
        ],
      },
    ],
  };
}
it('presents proven lifecycle and catalog facets once without losing their identities or verification boundaries', async () => {
  vi.mocked(getConnectionsAccess).mockResolvedValue(linkedFacets());
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  const cards = await screen.findAllByRole('article', { name: 'Personal account' });
  expect(cards).toHaveLength(1);
  fireEvent.click(within(cards[0]).getByRole('button', { name: 'Manage Personal account' }));
  const card = within(screen.getByRole('dialog'));
  expect(card.getByText('Connected')).toBeTruthy();
  expect(card.getByText('signed-in@example.test')).toBeTruthy();
  expect(card.getByText('ChatGPT pro')).toBeTruthy();
  expect(card.getByText('Configured Luna')).toBeTruthy();
  expect(card.getByText('Not verified')).toBeTruthy();
  expect(card.getByText('catalog')).toBeTruthy();
  expect(card.getByRole('link', { name: 'Open personal account controls' })).toBeTruthy();
});
it.each(['stale', 'unavailable'] as const)('does not collapse %s linkage', async (state) => {
  vi.mocked(getConnectionsAccess).mockResolvedValue(linkedFacets(state));
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  expect(await screen.findAllByRole('article', { name: 'Personal account' })).toHaveLength(2);
});
it('never groups matching IDs or labels without explicit authoritative provenance', async () => {
  const inventory = linkedFacets();
  delete inventory.resources[0].personalConnection;
  vi.mocked(getConnectionsAccess).mockResolvedValue(inventory);
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  expect(await screen.findAllByRole('article', { name: 'Personal account' })).toHaveLength(2);
});

it('keeps an ordinary account with matching native ID separate from the linked personal facets', async () => {
  const inventory = linkedFacets();
  inventory.resources.push({
    ...inventory.resources[0],
    id: 'ordinary',
    owner: 'account-profiles',
  });
  vi.mocked(getConnectionsAccess).mockResolvedValue(inventory);
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  expect(await screen.findAllByRole('article', { name: 'Personal account' })).toHaveLength(2);
});
it('does not hide ambiguous catalog facets linked to the same lifecycle resource', async () => {
  const inventory = linkedFacets();
  inventory.resources.push({ ...inventory.resources[0], id: 'another-catalog' });
  vi.mocked(getConnectionsAccess).mockResolvedValue(inventory);
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  expect(await screen.findAllByRole('article', { name: 'Personal account' })).toHaveLength(3);
});
it('rejects mismatched revisions even if a presentation link claims it is current', async () => {
  const inventory = linkedFacets();
  inventory.resources[1].revision = 4;
  vi.mocked(getConnectionsAccess).mockResolvedValue(inventory);
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  expect(await screen.findAllByRole('article', { name: 'Personal account' })).toHaveLength(2);
});

it.each(['account-profiles', 'symposium-account-profiles'] as const)(
  'labels standalone %s model lists as configured with unverified support',
  async (owner) => {
    const inventory = linkedFacets();
    const standalone = { ...inventory.resources[0], owner };
    delete standalone.personalConnection;
    inventory.resources = [standalone];
    vi.mocked(getConnectionsAccess).mockResolvedValue(inventory);
    render(
      <MemoryRouter>
        <ConnectionsAccessView />
      </MemoryRouter>,
    );
    const row = await screen.findByRole('article', { name: 'Personal account' });
    fireEvent.click(within(row).getByRole('button', { name: 'Manage Personal account' }));
    const card = within(screen.getByRole('dialog'));
    expect(card.getAllByText('Configured models')).toHaveLength(1);
    expect(card.getAllByText('Configured Luna')).toHaveLength(1);
    expect(
      card.getAllByText(
        'Configured catalog; model support and effective access have not been checked.',
      ),
    ).toHaveLength(1);
    expect(card.queryByText('Available models')).toBeNull();
  },
);
it('keeps the grouped configured catalog and support disclaimer without duplicate model lists', async () => {
  const inventory = linkedFacets();
  inventory.resources[1].details.models = inventory.resources[0].details.models;
  vi.mocked(getConnectionsAccess).mockResolvedValue(inventory);
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  const row = await screen.findByRole('article', { name: 'Personal account' });
  fireEvent.click(within(row).getByRole('button', { name: 'Manage Personal account' }));
  const card = within(screen.getByRole('dialog'));
  expect(card.getAllByText('Configured models')).toHaveLength(1);
  expect(card.getAllByText('Configured Luna')).toHaveLength(1);
  expect(
    card.getAllByText(
      'Configured catalog; model support and effective access have not been checked.',
    ),
  ).toHaveLength(1);
  expect(card.queryByText('Available models')).toBeNull();
});

it('traps keyboard focus, dismisses with Escape and restores the row trigger', async () => {
  vi.mocked(getConnectionsAccess).mockResolvedValue(linkedFacets());
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  const trigger = within(
    await screen.findByRole('article', { name: 'Personal account' }),
  ).getByRole('button', { name: 'Manage Personal account' });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Personal account' });
  const close = within(dialog).getByRole('button', { name: 'Close details' });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(
    within(dialog).getByRole('link', { name: 'Open personal account controls' }),
  );
  fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
