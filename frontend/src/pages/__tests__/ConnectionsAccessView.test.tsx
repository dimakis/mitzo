// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConnectionsAccessView } from '../ConnectionsAccessView';
import { getConnectionsAccess } from '../../lib/connections-access-api';
import { retainUnavailableAccounts } from '../../lib/connections-access-presentation';
import type { ConnectionsAccessInventory } from '../../types/connections-access';
import { act } from 'react';

vi.mock('../../lib/connections-access-api', () => ({ getConnectionsAccess: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
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
  expect(document.activeElement).toBe(within(dialog).getByText('Technical details'));
  fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it.each(['Manage Personal account', 'View Public page reads'])(
  'returns focus to %s after pointer opening without moving focus to the trigger',
  async (name) => {
    vi.mocked(getConnectionsAccess).mockResolvedValue(linkedFacets());
    render(
      <MemoryRouter>
        <ConnectionsAccessView />
      </MemoryRouter>,
    );
    await screen.findByRole('article', { name: 'Personal account' });
    const trigger = screen.getByRole('button', { name });
    // Pointer activation need not focus a button before its click handler runs.
    screen.getByRole('button', { name: 'Refresh access' }).focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close details' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  },
);

it('returns focus to an attached page control when refresh removes the drawer opener', async () => {
  let recover!: (value: ConnectionsAccessInventory) => void;
  vi.mocked(getConnectionsAccess)
    .mockResolvedValueOnce(linkedFacets())
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
  const trigger = await screen.findByRole('button', { name: 'Manage Personal account' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh access' }));
  trigger.focus();
  fireEvent.click(trigger);
  await act(async () => recover({ generatedAt: 2, sources: [], resources: [] }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(trigger.isConnected).toBe(false);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Refresh access' }));
});

it('keeps technical identifiers collapsed until details are requested', async () => {
  vi.mocked(getConnectionsAccess).mockResolvedValue(linkedFacets());
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  const row = await screen.findByRole('article', { name: 'Personal account' });
  fireEvent.click(within(row).getByRole('button', { name: 'Manage Personal account' }));
  const dialog = screen.getByRole('dialog');
  const summary = within(dialog).getByText('Technical details');
  const details = summary.closest('details');
  expect(details).not.toBeNull();
  expect(details?.open).toBe(false);
  fireEvent.click(summary);
  expect(details?.open).toBe(true);
  expect(within(dialog).getByText('symposium-personal')).toBeTruthy();
});

it('keeps mode inspection inside the drawer and returns focus before dismissing', async () => {
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
  fireEvent.click(screen.getByRole('button', { name: 'Inspect Ask mode' }));
  const back = screen.getByRole('button', { name: 'Back to modes' });
  expect(document.activeElement).toBe(back);
  fireEvent.keyDown(back, { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Inspect Ask mode' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('updates an open drawer from refreshed canonical resources and closes a removed account', async () => {
  const inventory = linkedFacets();
  let recover!: (value: ConnectionsAccessInventory) => void;
  vi.mocked(getConnectionsAccess)
    .mockResolvedValueOnce(inventory)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          recover = resolve;
        }),
    )
    .mockResolvedValueOnce({ generatedAt: 3, sources: [], resources: [] });
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  const row = await screen.findByRole('article', { name: 'Personal account' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh access' }));
  fireEvent.click(within(row).getByRole('button', { name: 'Manage Personal account' }));
  expect(within(screen.getByRole('dialog')).getByRole('status').textContent).toContain(
    'Refreshing access',
  );
  const updated = structuredClone(inventory);
  updated.generatedAt = 2;
  updated.resources[1].status = 'revoked';
  updated.resources[1].accountIdentity = 'updated@example.test';
  updated.resources[1].revision = 4;
  updated.resources[0].details.models = [{ id: 'new-model', label: 'Updated model' }];
  await act(async () => recover(updated));
  expect(within(screen.getByRole('dialog')).getByText('Revoked')).toBeTruthy();
  expect(within(screen.getByRole('dialog')).getByText('updated@example.test')).toBeTruthy();
  expect(within(screen.getByRole('dialog')).queryByText('Configured Luna')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh access' }));
  fireEvent.click(
    within(screen.getAllByRole('article', { name: 'Personal account' })[1]).getByRole('button', {
      name: 'Manage Personal account',
    }),
  );
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
it('exposes retained stale results inside a drawer after a failed refresh', async () => {
  let fail!: (error: Error) => void;
  vi.mocked(getConnectionsAccess)
    .mockResolvedValueOnce(linkedFacets())
    .mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  const row = await screen.findByRole('article', { name: 'Personal account' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh access' }));
  fireEvent.click(within(row).getByRole('button', { name: 'Manage Personal account' }));
  await act(async () => fail(new Error('Unavailable')));
  expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toContain(
    'Showing older results',
  );
});

it('replaces the linked model catalog during refresh and clears stale mode inspection', async () => {
  const inventory = linkedFacets();
  let recover!: (value: ConnectionsAccessInventory) => void;
  vi.mocked(getConnectionsAccess)
    .mockResolvedValueOnce(inventory)
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
  const row = await screen.findByRole('article', { name: 'Personal account' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh access' }));
  fireEvent.click(within(row).getByRole('button', { name: 'Manage Personal account' }));
  fireEvent.click(screen.getByRole('button', { name: 'Inspect Agent mode' }));
  const updated = structuredClone(inventory);
  updated.generatedAt = 2;
  updated.resources[0].details.models = [{ id: 'updated', label: 'Updated configured model' }];
  updated.resources[1].revision = 4;
  updated.resources[0].personalConnection!.revision = 4;
  await act(async () => recover(updated));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('Updated configured model')).toBeTruthy();
  expect(within(dialog).queryByText('Configured Luna')).toBeNull();
  expect(within(dialog).queryByRole('heading', { name: 'Agent mode' })).toBeNull();
  expect(document.activeElement).toBe(
    within(dialog).getByRole('button', { name: 'Close details' }),
  );
});

function signInInventory(signIn?: ConnectionsAccessInventory['resources'][number]['signIn']) {
  const inventory = linkedFacets();
  const resource = inventory.resources[0];
  delete resource.personalConnection;
  inventory.resources = [
    {
      ...resource,
      label: 'Host account',
      owner: 'account-profiles',
      accountIdentity: 'configured@example.test',
      verification: { state: 'verified', verifiedAt: 1, reason: null },
      signIn,
    },
  ];
  return inventory;
}
const checkedSignIn = {
  status: 'verified' as const,
  source: 'host-account-read' as const,
  checkedAt: Date.now(),
  configuredIdentity: { email: 'configured@example.test', planType: 'pro' },
  observedIdentity: { email: 'observed@example.test', planType: 'team' },
  profileRevision: 'revision-1',
  explanation: 'Host account identity was read without making a model call.',
};
async function renderSignIn(signIn?: ConnectionsAccessInventory['resources'][number]['signIn']) {
  vi.mocked(getConnectionsAccess).mockResolvedValue(signInInventory(signIn));
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  return screen.findByRole('article', { name: 'Host account' });
}
it('shows observed host sign-in separately from configured identity and access verification', async () => {
  const row = await renderSignIn(checkedSignIn);
  expect(within(row).getByText('Sign-in: Signed in')).toBeTruthy();
  expect(within(row).getByText('observed@example.test')).toBeTruthy();
  expect(within(row).getByText('Configured: configured@example.test')).toBeTruthy();
  fireEvent.click(within(row).getByRole('button', { name: 'Manage Host account' }));
  const dialog = within(screen.getByRole('dialog'));
  expect(dialog.getByText('Sign-in')).toBeTruthy();
  expect(dialog.getByText('Signed in')).toBeTruthy();
  expect(dialog.getByText('Configured account')).toBeTruthy();
  expect(dialog.getByText('configured@example.test')).toBeTruthy();
  expect(dialog.getByText('Account plan')).toBeTruthy();
  expect(dialog.getByText('team')).toBeTruthy();
  expect(dialog.getByText('Last sign-in check')).toBeTruthy();
  expect(dialog.getByText(new Date(checkedSignIn.checkedAt).toLocaleString())).toBeTruthy();
  expect(dialog.getByText('Access verification')).toBeTruthy();
});
it('labels a live provider grant Connected without treating its configured email as observed', async () => {
  const row = await renderSignIn({
    ...checkedSignIn,
    source: 'openshell-provider-grant',
    observedIdentity: null,
  });
  expect(within(row).getByText('Sign-in: Connected')).toBeTruthy();
  expect(within(row).getByText('Configured: configured@example.test')).toBeTruthy();
  expect(within(row).queryByText('Signed in')).toBeNull();
  fireEvent.click(within(row).getByRole('button', { name: 'Manage Host account' }));
  const dialog = within(screen.getByRole('dialog'));
  expect(dialog.getByText('Configured account')).toBeTruthy();
  expect(dialog.queryByText('Account')).toBeNull();
});
it.each([
  ['stale', 'Check is stale'],
  ['failed', 'Check failed'],
  ['not-checked', 'Not checked'],
  ['unsupported', 'Unsupported'],
] as const)('keeps %s sign-in independent of access verification', async (status, label) => {
  const row = await renderSignIn({ ...checkedSignIn, status, observedIdentity: null });
  expect(within(row).getByText(`Sign-in: ${label}`)).toBeTruthy();
  expect(within(row).queryByText('Sign-in: Signed in')).toBeNull();
  expect(within(row).queryByText('Signed out')).toBeNull();
  fireEvent.click(within(row).getByRole('button', { name: 'Manage Host account' }));
  const dialog = within(screen.getByRole('dialog'));
  expect(dialog.getByText(label)).toBeTruthy();
  expect(dialog.getByText(checkedSignIn.explanation)).toBeTruthy();
  expect(dialog.getByText('Access verification')).toBeTruthy();
});
it('treats absent sign-in evidence as Not checked even if generic access was verified', async () => {
  const row = await renderSignIn();
  expect(within(row).getByText('Sign-in: Not checked')).toBeTruthy();
  expect(within(row).getByText('Configured: configured@example.test')).toBeTruthy();
  fireEvent.click(within(row).getByRole('button', { name: 'Manage Host account' }));
  expect(within(screen.getByRole('dialog')).getByText('Not checked')).toBeTruthy();
  expect(within(screen.getByRole('dialog')).queryByText('Signed out')).toBeNull();
});

it.each(['non-Codex API', 'personal identity'] as const)(
  'preserves %s display when sign-in evidence is absent',
  async (scenario) => {
    const inventory = signInInventory();
    inventory.resources[0].provider = scenario === 'non-Codex API' ? 'vertex' : 'openai-codex';
    inventory.resources[0].kind =
      scenario === 'personal identity' ? 'personal-connection' : 'ai-account';
    vi.mocked(getConnectionsAccess).mockResolvedValue(inventory);
    render(
      <MemoryRouter>
        <ConnectionsAccessView />
      </MemoryRouter>,
    );
    const row = await screen.findByRole('article', { name: 'Host account' });
    expect(within(row).getByText('configured@example.test')).toBeTruthy();
    expect(within(row).queryByText('Configured: configured@example.test')).toBeNull();
    expect(within(row).queryByText('Sign-in: Not checked')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Manage Host account' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('Account')).toBeTruthy();
    expect(dialog.queryByText('Sign-in')).toBeNull();
  },
);

it('marks previously verified sign-in stale when inventory refresh fails and recovers after a successful check', async () => {
  const inventory = signInInventory({
    ...checkedSignIn,
    source: 'openshell-provider-grant',
    observedIdentity: null,
  });
  vi.mocked(getConnectionsAccess)
    .mockResolvedValueOnce(inventory)
    .mockRejectedValueOnce(new Error('Unavailable'))
    .mockResolvedValueOnce(inventory);
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  const row = await screen.findByRole('article', { name: 'Host account' });
  expect(within(row).getByText('Sign-in: Connected')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh access' }));
  await within(row).findByText('Sign-in: Check is stale');
  expect(within(row).queryByText('Sign-in: Connected')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await within(row).findByText('Sign-in: Connected');
});

it('expires displayed sign-in evidence after five minutes without making a new request', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  const row = await renderSignIn({ ...checkedSignIn, checkedAt: Date.now() });
  expect(within(row).getByText('Sign-in: Signed in')).toBeTruthy();
  await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000 + 1000));
  expect(within(row).getByText('Sign-in: Check is stale')).toBeTruthy();
  expect(within(row).queryByText('Sign-in: Signed in')).toBeNull();
  expect(getConnectionsAccess).toHaveBeenCalledTimes(1);
});

it('expires provider sign-in at its grant deadline while preserving the configured catalog', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  const row = await renderSignIn({
    ...checkedSignIn,
    checkedAt: Date.now(),
    source: 'openshell-provider-grant',
    observedIdentity: null,
    expiresAt: Date.now() + 60_000,
  });
  expect(within(row).getByText('Sign-in: Connected')).toBeTruthy();
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(within(row).getByText('Sign-in: Check is stale')).toBeTruthy();
  expect(within(row).getByText('Configured: configured@example.test')).toBeTruthy();
  fireEvent.click(within(row).getByRole('button', { name: 'Manage Host account' }));
  expect(within(screen.getByRole('dialog')).getByText('Configured Luna')).toBeTruthy();
  expect(getConnectionsAccess).toHaveBeenCalledTimes(1);
});

it.each([
  ['account-profiles', 'accounts', 'AI accounts'],
  ['symposium-account-profiles', 'symposiumAccounts', 'Symposium AI accounts'],
] as const)(
  'retains unavailable %s rows and an open drawer while replacing fresh service rows',
  async (owner, sourceId, sourceLabel) => {
    const current = signInInventory({
      ...checkedSignIn,
      checkedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    current.resources[0].owner = owner;
    current.resources[0].personalConnection = {
      resourceId: 'personal',
      revision: 3,
      state: 'current',
    };
    current.sources = [{ id: sourceId, state: 'available', reason: null }];
    const latestService = {
      ...current.resources[0],
      id: 'service',
      label: 'Latest Jira',
      kind: 'managed-connection' as const,
      section: 'services' as const,
      owner: 'managed-connections',
      provider: 'jira',
      signIn: undefined,
      personalConnection: undefined,
    };
    const partial = {
      generatedAt: 2,
      sources: [
        { id: sourceId, state: 'unavailable', reason: 'Account source could not be read.' },
        { id: 'managed', state: 'available', reason: null },
      ],
      resources: [latestService],
    } satisfies ConnectionsAccessInventory;
    vi.mocked(getConnectionsAccess)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(partial)
      .mockResolvedValueOnce({ ...current, generatedAt: 3 });
    render(
      <MemoryRouter>
        <ConnectionsAccessView />
      </MemoryRouter>,
    );
    const row = await screen.findByRole('article', { name: 'Host account' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh access' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Manage Host account' }));
    await screen.findByText(`${sourceLabel}: Source unavailable`);
    const dialog = within(screen.getByRole('dialog', { name: 'Host account' }));
    expect(dialog.getByText('Check is stale')).toBeTruthy();
    expect(dialog.getByText(/Showing an older account/)).toBeTruthy();
    expect(
      dialog.getByText(new Date(current.resources[0].signIn!.checkedAt!).toLocaleString()),
    ).toBeTruthy();
    expect(dialog.getByText('Configured Luna')).toBeTruthy();
    expect(dialog.getByText(/Personal account details could not be checked/)).toBeTruthy();
    expect(screen.getByRole('article', { name: 'Latest Jira', hidden: true })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh access' }));
    await within(row).findByText('Sign-in: Signed in');
  },
);
it.each(['available', 'not-configured'] as const)(
  'removes prior account rows when its source is authoritatively %s',
  async (state) => {
    vi.mocked(getConnectionsAccess)
      .mockResolvedValueOnce(signInInventory({ ...checkedSignIn, checkedAt: Date.now() }))
      .mockResolvedValueOnce({
        generatedAt: 2,
        resources: [],
        sources: [{ id: 'accounts', state, reason: null }],
      });
    render(
      <MemoryRouter>
        <ConnectionsAccessView />
      </MemoryRouter>,
    );
    const row = await screen.findByRole('article', { name: 'Host account' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh access' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Manage Host account' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('article', { name: 'Host account' })).toBeNull();
  },
);

it('retains only exact account owners without duplicating an ID already in the newer response', () => {
  const previous = signInInventory({ ...checkedSignIn, checkedAt: Date.now() });
  previous.resources.push(
    { ...previous.resources[0], id: 'unrelated', owner: 'another-account-service' },
    {
      ...previous.resources[0],
      id: 'personal',
      kind: 'personal-connection',
      owner: 'account-profiles',
    },
  );
  const newer = { ...previous.resources[0], label: 'Newer account' };
  const next: ConnectionsAccessInventory = {
    generatedAt: 2,
    sources: [{ id: 'accounts', state: 'unavailable', reason: null }],
    resources: [newer],
  };
  expect(retainUnavailableAccounts(previous, next)).toBe(next);
  expect(next.resources).toEqual([newer]);
});

it.each(['failed', 'not-checked', 'unsupported'] as const)(
  'preserves %s sign-in when retaining older configuration from an unavailable source',
  (status) => {
    const previous = signInInventory({
      ...checkedSignIn,
      status,
      checkedAt: null,
      observedIdentity: null,
    });
    const next: ConnectionsAccessInventory = {
      generatedAt: 2,
      resources: [],
      sources: [{ id: 'accounts', state: 'unavailable', reason: null }],
    };
    const retained = retainUnavailableAccounts(previous, next).resources[0];
    expect(retained.signIn).toEqual(previous.resources[0].signIn);
  },
);

it.each(['available', 'not-configured'] as const)(
  'removes cached Symposium catalogs when their source becomes %s',
  async (state) => {
    const current = signInInventory({ ...checkedSignIn, checkedAt: Date.now() });
    current.resources[0].owner = 'symposium-account-profiles';
    vi.mocked(getConnectionsAccess)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce({
        generatedAt: 2,
        resources: [],
        sources: [{ id: 'symposiumAccounts', state: 'unavailable', reason: null }],
      })
      .mockResolvedValueOnce({
        generatedAt: 3,
        resources: [],
        sources: [{ id: 'symposiumAccounts', state, reason: null }],
      });
    render(
      <MemoryRouter>
        <ConnectionsAccessView />
      </MemoryRouter>,
    );
    const row = await screen.findByRole('article', { name: 'Host account' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh access' }));
    await within(row).findByText('Sign-in: Check is stale');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh access' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Manage Host account' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('article', { name: 'Host account' })).toBeNull();
  },
);

it('describes a verified managed-service credential check without claiming effective access', async () => {
  const inventory = signInInventory();
  inventory.resources = [
    {
      ...inventory.resources[0],
      id: 'managed-jira',
      label: 'Jira credentials',
      kind: 'managed-connection',
      section: 'services',
      owner: 'managed-connections',
      provider: 'jira',
      verification: { state: 'verified', verifiedAt: Date.now(), reason: null },
      access: {
        summary: 'Configured Jira read access',
        desiredAccountIds: ['work'],
        observedAttachments: null,
        appliesTo: 'New conversations',
      },
    },
  ];
  vi.mocked(getConnectionsAccess).mockResolvedValue(inventory);
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  const row = await screen.findByRole('article', { name: 'Jira credentials' });
  expect(within(row).getByText('Credentials verified')).toBeTruthy();
  expect(within(row).queryByText('Access verified')).toBeNull();
  fireEvent.click(within(row).getByRole('button', { name: 'Manage Jira credentials' }));
  const dialog = within(screen.getByRole('dialog'));
  expect(dialog.getByText('Credential verification')).toBeTruthy();
  expect(dialog.queryByText('Access verified')).toBeNull();
  expect(dialog.queryByText('Access verification')).toBeNull();
  expect(dialog.getByText(/Conversation attachments have not been observed/)).toBeTruthy();
});

it('groups account identity, sign-in evidence and access scope in separate named regions', async () => {
  const row = await renderSignIn({ ...checkedSignIn, checkedAt: Date.now() });
  fireEvent.click(within(row).getByRole('button', { name: 'Manage Host account' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Host account' }));
  const account = within(dialog.getByRole('region', { name: 'Account details' }));
  const signIn = within(dialog.getByRole('region', { name: 'Sign-in details' }));
  const access = within(dialog.getByRole('region', { name: 'Access and scope' }));
  expect(account.getByText('configured@example.test')).toBeTruthy();
  expect(account.getByText('observed@example.test')).toBeTruthy();
  expect(account.getByText('Ordinary chats')).toBeTruthy();
  expect(signIn.getByText('Signed in')).toBeTruthy();
  expect(signIn.getByText('Last sign-in check')).toBeTruthy();
  expect(signIn.getByText(checkedSignIn.explanation)).toBeTruthy();
  expect(access.getByText('Access verification')).toBeTruthy();
  expect(access.getByText(/Conversation attachments have not been observed/)).toBeTruthy();
  expect(account.queryByText('Signed in')).toBeNull();
  expect(access.queryByText('Signed in')).toBeNull();
});
it('keeps service identity and credential checks accessible without an invented sign-in region', async () => {
  const inventory = signInInventory();
  inventory.resources[0].kind = 'managed-connection';
  inventory.resources[0].section = 'services';
  inventory.resources[0].provider = 'jira';
  vi.mocked(getConnectionsAccess).mockResolvedValue(inventory);
  render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
  const row = await screen.findByRole('article', { name: 'Host account' });
  fireEvent.click(within(row).getByRole('button', { name: 'Manage Host account' }));
  const dialog = within(screen.getByRole('dialog'));
  expect(
    within(dialog.getByRole('region', { name: 'Account details' })).getByText(
      'configured@example.test',
    ),
  ).toBeTruthy();
  expect(
    within(dialog.getByRole('region', { name: 'Access and scope' })).getByText(
      'Credential verification',
    ),
  ).toBeTruthy();
  expect(dialog.queryByRole('region', { name: 'Sign-in details' })).toBeNull();
});
