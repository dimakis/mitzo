// @vitest-environment jsdom
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsView } from '../ConnectionsView';
import { apiFetch } from '../../lib/api-fetch';
import * as api from '../../lib/connections-api';
import type { ConnectionsCatalog, ConnectionTemplateCatalog } from '../../types/connections';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../../lib/connections-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/connections-api')>()),
  getConnections: vi.fn(),
  getConnectionTemplates: vi.fn(),
  reauthorize: vi.fn(),
  createConnection: vi.fn(),
  deleteConnection: vi.fn(),
  getConnectionAudit: vi.fn(),
  getConnectionCapabilityGrants: vi.fn(),
  retryConnection: vi.fn(),
  revokeConnection: vi.fn(),
  rotateConnection: vi.fn(),
  setConnectionCapabilityGrant: vi.fn(),
  testConnection: vi.fn(),
  updateAssignments: vi.fn(),
}));
const jira: ConnectionsCatalog['connections'][number] = {
  id: 'jira-1',
  templateId: 'jira-readonly',
  templateVersion: 1,
  label: 'Work Jira',
  status: 'active',
  revision: 1,
  endpoint: 'https://example.atlassian.net',
  publicConfig: { email: 'me@example.com' },
  desiredAccountIds: ['work'],
  identity: 'me@example.com',
  verifiedAt: Date.now(),
  errorCode: null,
};
const catalog: ConnectionsCatalog = {
  connections: [jira, { ...jira, id: 'jira-other', label: 'Other Jira' }],
  eligibleAccounts: ['work', 'personal'],
  eligibleAccountsByTemplate: { 'jira-readonly': ['work'] },
  legacy: [],
  appliesTo: 'new conversations',
};
const templates: ConnectionTemplateCatalog = {
  capabilities: [],
  templates: [
    {
      id: 'jira-readonly',
      version: 1,
      label: 'Jira',
      category: 'data',
      description: 'Read issues and project details.',
      available: true,
      risk: 'read-only',
      capabilityTemplates: [],
      credentialFields: [
        {
          key: 'token',
          label: 'API token',
          description: 'Use a scoped token.',
          style: 'api-token',
          secret: true,
          required: true,
        },
      ],
      connectionFields: [
        {
          key: 'email',
          label: 'Atlassian account email',
          description: 'Use the account that created the token.',
          kind: 'email',
          required: true,
        },
      ],
    },
    {
      id: 'custom-rest-readonly',
      version: 1,
      label: 'Custom REST API',
      category: 'custom-api',
      description: 'Read a custom service.',
      available: false,
      risk: 'operator-defined',
      credentialFields: [],
      connectionFields: [],
      capabilityTemplates: [],
    },
  ],
};
const start = async (props: Parameters<typeof ConnectionsView>[0] = {}) => {
  render(
    <MemoryRouter>
      <ConnectionsView {...props} />
    </MemoryRouter>,
  );
  await act(async () => {});
};
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
};
const fill = (name: string, value: string) =>
  fireEvent.change(screen.getByLabelText(name, { exact: true }), { target: { value } });
const reviewJira = async () => {
  await start();
  await click('Choose Jira');
  fill('API token', 'one-shot-secret');
  fill('Atlassian account email', 'me@example.com');
  await click('Continue');
  fireEvent.click(screen.getByLabelText('work'));
  await click('Continue');
};
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.mocked(api.getConnections).mockResolvedValue(catalog);
  vi.mocked(api.getConnectionTemplates).mockResolvedValue(templates);
  vi.mocked(api.createConnection).mockResolvedValue(jira);
  vi.mocked(api.reauthorize).mockResolvedValue({
    csrf: 'fresh-csrf',
    expiresAt: Date.now() + 300_000,
  });
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({ connections: [] }),
  } as Response);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('focused connection setup', () => {
  it('offers a new OpenAI API account only when enrollment is enabled', async () => {
    await start();
    expect(screen.queryByRole('link', { name: 'Choose OpenAI API' })).toBeNull();
    cleanup();
    vi.mocked(api.getConnections).mockResolvedValue({ ...catalog, openAIAccountsManaged: true });
    await start();
    expect(screen.getByRole('link', { name: 'Choose OpenAI API' }).getAttribute('href')).toBe(
      '/connections?manage=openai-add',
    );
  });
  it('keeps stale OpenAI enrollment destinations explicitly unavailable', async () => {
    await start({ mode: 'openai-add' });
    expect(screen.getByText('Adding OpenAI API accounts is unavailable.')).toBeTruthy();
    expect(screen.queryByLabelText('API key')).toBeNull();
  });
  it('opens with account and service choices, without unrelated forms or management controls', async () => {
    await start();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Add connection');
    expect(screen.getByRole('button', { name: 'Choose ChatGPT' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose Jira' })).toBeTruthy();
    expect(screen.queryByLabelText('Passphrase')).toBeNull();
    expect(screen.queryByLabelText('Account label')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Connections' }).getAttribute('href')).toBe(
      '/connections-access',
    );
  });
  it('keeps ChatGPT selectable during service outages and scopes its failure to the selected flow', async () => {
    vi.mocked(api.getConnections).mockRejectedValue(new Error('Service unavailable'));
    vi.mocked(api.getConnectionTemplates).mockRejectedValue(new Error('Catalog unavailable'));
    vi.mocked(apiFetch).mockResolvedValue({ ok: false } as Response);
    await start();
    expect(screen.getByRole('button', { name: 'Choose ChatGPT' })).toBeTruthy();
    expect(screen.queryByText(/Could not load personal accounts/)).toBeNull();
    await click('Choose ChatGPT');
    expect(screen.getByText(/Could not load personal accounts/)).toBeTruthy();
    await click('Choose another connection');
    expect(screen.queryByText(/Could not load personal accounts/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Choose ChatGPT' })).toBeTruthy();
  });
  it('combines credentials and account identity, then asks for eligible access before review', async () => {
    await start();
    await click('Choose Jira');
    expect(screen.getByText('Step 1 of 3 · Connect')).toBeTruthy();
    expect(screen.getByLabelText('API token')).toBeTruthy();
    expect(screen.getByLabelText('Atlassian account email')).toBeTruthy();
    fill('API token', 'secret');
    fill('Atlassian account email', 'invalid');
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fill('Atlassian account email', 'me@example.com');
    await click('Continue');
    expect(screen.getByText('Step 2 of 3 · Access')).toBeTruthy();
    expect(screen.getByLabelText('work')).toBeTruthy();
    expect(screen.queryByLabelText('personal')).toBeNull();
    await click('Continue');
    expect(screen.getByText('Step 3 of 3 · Review')).toBeTruthy();
    expect(screen.getByText('No AI accounts selected. You can assign access later.')).toBeTruthy();
    expect(screen.queryByText('Capabilities', { exact: true })).toBeNull();
  });
  it('authorizes at the final action and submits once with the fresh authorization', async () => {
    await reviewJira();
    await click('Verify and connect Jira');
    expect(api.createConnection).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Confirm it’s you' })).toBeTruthy();
    fill('Passphrase', 'local-passphrase');
    await click('Authorize and connect Jira');
    expect(api.reauthorize).toHaveBeenCalledWith('local-passphrase');
    expect(api.createConnection).toHaveBeenCalledTimes(1);
    expect(api.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        csrf: 'fresh-csrf',
        credentials: { token: 'one-shot-secret' },
        fields: { email: 'me@example.com' },
        accountIds: ['work'],
      }),
    );
    expect(screen.getByRole('heading', { name: 'Work Jira connected' })).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Back to Connections' }).getAttribute('href'),
    ).toContain('connected=jira-1');
    expect(screen.queryByRole('button', { name: 'Verify and connect Jira' })).toBeNull();
  });
  it('preserves the draft after failed authorization, and allows a retry without re-entering credentials', async () => {
    vi.mocked(api.reauthorize).mockRejectedValueOnce(new Error('Incorrect passphrase'));
    await reviewJira();
    await click('Verify and connect Jira');
    fill('Passphrase', 'wrong');
    await click('Authorize and connect Jira');
    expect(api.createConnection).not.toHaveBeenCalled();
    expect(screen.getByText('Incorrect passphrase')).toBeTruthy();
    fill('Passphrase', 'correct');
    await click('Authorize and connect Jira');
    expect(api.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { token: 'one-shot-secret' } }),
    );
  });
  it('returns verification failure to Connect, clears submitted secrets, and preserves non-secret choices', async () => {
    vi.mocked(api.createConnection).mockRejectedValue(new Error('Token rejected'));
    await reviewJira();
    await click('Verify and connect Jira');
    fill('Passphrase', 'pass');
    await click('Authorize and connect Jira');
    expect(screen.getByText('Token rejected')).toBeTruthy();
    expect((screen.getByLabelText('API token') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Atlassian account email') as HTMLInputElement).value).toBe(
      'me@example.com',
    );
    fill('API token', 'replacement');
    await click('Continue');
    expect((screen.getByLabelText('work') as HTMLInputElement).checked).toBe(true);
  });
  it('marks unavailable choices without an action that looks usable', async () => {
    await start();
    expect(screen.getByText('Coming soon')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Coming soon' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Choose Custom REST API' })).toBeNull();
  });
  it('opens only the selected service for management and never mounts setup or personal-account forms', async () => {
    await start({ mode: 'manage', connectionId: 'jira-1' });
    expect(screen.getByText('Work Jira')).toBeTruthy();
    expect(screen.queryByText('Other Jira')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Choose Jira' })).toBeNull();
    expect(screen.queryByLabelText('Passphrase')).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
    await click('Test identity');
    expect(api.testConnection).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Passphrase')).toBeTruthy();
  });
});

it('explains and confirms revocation separately from removing a saved connection', async () => {
  await start({ mode: 'manage', connectionId: 'jira-1' });
  await click('Authorize changes');
  fill('Passphrase', 'pass');
  await click('Reauthorize');
  fireEvent.click(screen.getByText('Disconnect or remove'));
  await click('Revoke');
  expect(api.revokeConnection).not.toHaveBeenCalled();
  expect(screen.getByText(/Stops managed access immediately/)).toBeTruthy();
  await click('Confirm revocation');
  expect(api.revokeConnection).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'jira-1', revision: 1 }),
  );
});

it('does not start a connection request after leaving during authorization', async () => {
  let finish!: (value: { csrf: string; expiresAt: number }) => void;
  vi.mocked(api.reauthorize).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await reviewJira();
  await click('Verify and connect Jira');
  fill('Passphrase', 'pass');
  await click('Authorize and connect Jira');
  cleanup();
  await act(async () => finish({ csrf: 'late-proof', expiresAt: Date.now() + 300_000 }));
  expect(api.createConnection).not.toHaveBeenCalled();
});

it.each(['saved-1', null])(
  'keeps failed or uncertain creation in recovery instead of repeating setup: %s',
  async (id) => {
    vi.mocked(api.createConnection).mockRejectedValue(
      new api.ConnectionCreationFailure('Verification could not be confirmed', id, false),
    );
    await reviewJira();
    await click('Verify and connect Jira');
    fill('Passphrase', 'pass');
    await click('Authorize and connect Jira');
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.queryByLabelText('API token')).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to Connections' })).toBeTruthy();
    if (id)
      expect(
        screen.getByRole('link', { name: 'Review saved connection' }).getAttribute('href'),
      ).toContain('connection=saved-1');
    else
      expect(screen.getByText(/Check Connections before adding this service again/)).toBeTruthy();
    expect(api.createConnection).toHaveBeenCalledTimes(1);
  },
);

it('disables cached management mutations until a failed refresh is recovered', async () => {
  await start({ mode: 'manage', connectionId: 'jira-1' });
  vi.mocked(api.getConnections).mockRejectedValue(new Error('Access unavailable'));
  await click('Refresh connection');
  expect(
    (screen.getByRole('button', { name: 'Test identity' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole('button', { name: 'Rotate credentials' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  vi.mocked(api.getConnections).mockResolvedValue(catalog);
  await click('Refresh connection');
  expect(
    (screen.getByRole('button', { name: 'Test identity' }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

it('requests fresh authorization after the server rejects a previously valid proof', async () => {
  vi.mocked(api.createConnection).mockRejectedValueOnce(
    new api.ConnectionCreationFailure('Reauthorization required', null, true, true),
  );
  await reviewJira();
  await click('Verify and connect Jira');
  fill('Passphrase', 'pass');
  await click('Authorize and connect Jira');
  fill('API token', 'replacement');
  await click('Continue');
  await click('Continue');
  await click('Verify and connect Jira');
  expect(screen.getByLabelText('Passphrase')).toBeTruthy();
  expect(api.createConnection).toHaveBeenCalledTimes(1);
});

it('removes no-longer-eligible accounts from a recovered setup draft', async () => {
  let changed = false;
  vi.mocked(api.getConnections).mockImplementation(async () =>
    changed ? { ...catalog, eligibleAccountsByTemplate: { 'jira-readonly': ['other'] } } : catalog,
  );
  vi.mocked(api.createConnection).mockImplementationOnce(async () => {
    changed = true;
    throw new api.ConnectionCreationFailure('Account is no longer eligible', null, true);
  });
  await reviewJira();
  await click('Verify and connect Jira');
  fill('Passphrase', 'pass');
  await click('Authorize and connect Jira');
  fill('API token', 'replacement');
  await click('Continue');
  expect(screen.queryByLabelText('work')).toBeNull();
  await click('Continue');
  expect(screen.getByText('No AI accounts selected. You can assign access later.')).toBeTruthy();
});

it('retains uncertain ChatGPT creation across chooser navigation until Connections is reviewed', async () => {
  vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') throw new Error('Response lost');
    return { ok: true, json: async () => ({ connections: [] }) } as Response;
  });
  await start();
  await click('Choose ChatGPT');
  fill('Account label', 'Research');
  await click('Save and continue');
  expect(screen.getByText(/Account setup could not be confirmed/)).toBeTruthy();
  await click('Choose another connection');
  await click('Choose ChatGPT');
  expect(screen.queryByRole('button', { name: 'Save and continue' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Back to Connections' })).toBeTruthy();
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
    1,
  );
});

it('holds cached mutations through a pending retry after a failed refresh', async () => {
  await start({ mode: 'manage', connectionId: 'jira-1' });
  vi.mocked(api.getConnections).mockRejectedValue(new Error('Access unavailable'));
  await click('Refresh connection');
  let finish!: (value: ConnectionsCatalog) => void;
  vi.mocked(api.getConnections).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await click('Refresh connection');
  expect(
    (screen.getByRole('button', { name: 'Test identity' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await act(async () => finish(catalog));
  expect(
    (screen.getByRole('button', { name: 'Test identity' }) as HTMLButtonElement).disabled,
  ).toBe(false);
});
