import { describe, it, expect } from 'vitest';
import {
  readConnectionsAccess,
  inventoryIdentity,
  type ConnectionsAccessSources,
} from '../connections-access.js';
import type { Connection } from '../connections-store.js';
import type { PersonalConnection } from '../symposium-personal-connections.js';

const connection = {
  id: 'same',
  ownerId: 'operator',
  label: 'Same label',
  templateId: 'jira-readonly',
  templateVersion: 1,
  publicConfig: {},
  gatewayProviderId: 'provider-same',
  submittedEmail: '',
  errorCode: null,
  createdAt: 0,
  updatedAt: 100,
  gateway: 'primary',
  workspace: 'default',
  gatewayProviderName: 'managed-jira',
  status: 'active',
  revision: 2,
  identity: 'user@example.com',
  verifiedAt: 100,
  desiredAccountIds: ['account'],
  endpoint: 'https://example.com',
  archivedAt: null,
  credentialRef: '/private/secret',
  token: 'SECRET',
} satisfies Connection & { credentialRef: string; token: string };
const account = {
  id: 'same',
  label: 'Same label',
  provider: 'openai',
  billing: 'openai-api',
  models: [{ id: 'luna', label: 'Luna' }],
  modelDiscovery: { updatedAt: 999, stale: false },
  capabilities: { streaming: true, tools: true, images: false },
  credentialRef: '/secret',
} satisfies Awaited<ReturnType<NonNullable<ConnectionsAccessSources['accounts']>>>[number] & {
  credentialRef: string;
};
const sources = () => ({
  accounts: () => [account],
  managed: () => [connection],
  personal: () => [
    {
      id: 'same',
      label: 'Same label',
      revision: 1,
      state: 'connected',
      account: { email: 'personal@example.com', planType: 'plus' },
    } satisfies PersonalConnection,
  ],
  legacy: async () => [
    { name: 'managed-jira', type: 'jira', id: 'provider-same', workspace: 'default' },
    { name: 'other', type: 'custom' },
  ],
  gateway: 'primary',
  workspace: 'default',
});

describe('nonsecret Connections & access inventory', () => {
  it('keeps identity boundaries and does not confuse model discovery with account verification', async () => {
    const result = await readConnectionsAccess(sources(), { now: 1_000 });
    expect(new Set(result.resources.map((r) => r.id)).size).toBe(result.resources.length);
    const account = result.resources.find((r) => r.kind === 'ai-account')!;
    expect(account.status).toBe('configured');
    expect(account.actions).toEqual([]);
    expect(account.verification.reason).toContain('Credential controls are unavailable');
    expect(account.verification.state).toBe('unverified');
    expect(account.verification.verifiedAt).toBeNull();
    const managed = result.resources.find((r) => r.kind === 'managed-connection')!;
    expect(managed.verification.state).toBe('verified');
    expect(managed.access.observedAttachments).toBeNull();
    expect(managed.access.desiredAccountIds).toEqual(['account']);
    expect(result.resources.find((r) => r.kind === 'personal-connection')!.verification.state).toBe(
      'unverified',
    );
    expect(
      result.resources.filter((r) => r.kind === 'legacy-provider').map((r) => r.nativeId),
    ).toEqual(['other']);
    expect(
      result.resources.flatMap((r) => r.actions).every((action) => action.href === '/connections'),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|credentialRef|\/private\/secret/);
    expect(
      inventoryIdentity('managed-connection', 'operator', 'other', 'default', 'same'),
    ).not.toBe(managed.id);
    expect(
      inventoryIdentity('managed-connection', 'operator', 'primary', 'other', 'same'),
    ).not.toBe(managed.id);
  });
  it('retains independent sources when adapters fail and never exports raw errors', async () => {
    const result = await readConnectionsAccess({
      ...sources(),
      managed: () => {
        throw new Error('SECRET');
      },
      legacy: async () => {
        throw new Error('SECRET');
      },
    });
    expect(result.resources.some((r) => r.kind === 'ai-account')).toBe(true);
    expect(result.sources.find((s) => s.id === 'managed')!.state).toBe('unavailable');
    expect(result.sources.find((s) => s.id === 'legacy')!.state).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('bounds hung sources and reports disabled services without hiding accounts', async () => {
    const result = await readConnectionsAccess(
      { accounts: sources().accounts, google: () => new Promise(() => {}) },
      { timeoutMs: 10 },
    );
    expect(result.sources.find((s) => s.id === 'google')!.state).toBe('unavailable');
    expect(result.sources.find((s) => s.id === 'managed')!.state).toBe('not-configured');
    expect(result.resources).toHaveLength(1);
  });
  it('does not deduplicate across gateway/workspace or hide Google during an unavailable observation', async () => {
    const result = await readConnectionsAccess({
      ...sources(),
      managed: () => [{ ...connection, gateway: 'other', gatewayProviderName: 'other' }],
      google: async () => ({ health: 'unavailable', expiresAt: null, slidesEditing: false }),
    });
    expect(
      result.resources.some((r) => r.kind === 'legacy-provider' && r.nativeId === 'other'),
    ).toBe(true);
    expect(result.resources.find((r) => r.kind === 'google-workspace')!.verification.state).toBe(
      'unavailable',
    );
    expect(result.sources.find((s) => s.id === 'google')!.state).toBe('unavailable');
  });
});

it('reports the recorded credential check without declaring an enabled connection stale after five minutes', async () => {
  const inventory = await readConnectionsAccess(
    { managed: () => [connection] },
    { now: 86_400_000 },
  );
  expect(inventory.resources[0]).toMatchObject({
    status: 'active',
    verification: { state: 'verified', verifiedAt: 100 },
  });
});

it('reports successful account use as history without turning it into an authentication check', async () => {
  const inventory = await readConnectionsAccess(
    { accounts: () => [{ ...account, lastSuccessfulUse: { model: 'luna', succeededAt: 100 } }] },
    { now: 200 },
  );
  expect(inventory.resources[0].lastSuccessfulUse).toEqual({ model: 'luna', succeededAt: 100 });
  expect(inventory.resources[0].verification.state).toBe('unverified');
  const withoutModel = await readConnectionsAccess(
    { accounts: () => [{ ...account, lastSuccessfulUse: { model: null, succeededAt: 100 } }] },
    { now: 200 },
  );
  expect(withoutModel.resources[0].lastSuccessfulUse).toEqual({ model: null, succeededAt: 100 });
  for (const lastSuccessfulUse of [
    { model: 'other', succeededAt: 100 },
    { model: 'luna', succeededAt: 300 },
  ]) {
    const invalid = await readConnectionsAccess(
      { accounts: () => [{ ...account, lastSuccessfulUse }] },
      { now: 200 },
    );
    expect(invalid.resources[0].lastSuccessfulUse).toBeUndefined();
  }
});

it('exposes service scope and configured identity without presenting the Jira account ID as a name', async () => {
  const inventory = await readConnectionsAccess({
    managed: () => [
      {
        ...connection,
        identity: '712020:opaque-account-id',
        submittedEmail: 'person@example.com',
        publicConfig: { email: 'person@example.com' },
      },
    ],
  });
  expect(inventory.resources[0].details).toMatchObject({
    serviceName: 'Jira',
    configuredIdentity: 'person@example.com',
    scope: { email: 'person@example.com' },
    permissions: ['Jira reads'],
  });
  expect(inventory.resources[0].accountIdentity).toBe('712020:opaque-account-id');
});

it('distinguishes GitHub repository reads from current, enabled publication grants', async () => {
  const github = {
    ...connection,
    templateId: 'github-readonly',
    publicConfig: { allowedRepositories: ['dimakis/mgmt'] },
  };
  const grant = {
    id: 'grant',
    connectionId: connection.id,
    connectionRevision: connection.revision,
    capabilityId: 'github.publish-pr',
    capabilityVersion: 1,
    accountIds: ['account'],
    status: 'active' as const,
    createdAt: 1,
    updatedAt: 1,
  };
  for (const [capabilityGrants, publishingEnabled, permissions] of [
    [[grant], true, ['Repository reads', 'PR publishing after approval']],
    [[{ ...grant, connectionRevision: 1 }], true, ['Repository reads']],
    [[{ ...grant, accountIds: ['unassigned'] }], true, ['Repository reads']],
    [[grant], false, ['Repository reads']],
  ] as const) {
    const inventory = await readConnectionsAccess({
      managed: () => [{ ...github, capabilityGrants: [...capabilityGrants], publishingEnabled }],
    });
    expect(inventory.resources[0].details.permissions).toEqual(permissions);
    expect(inventory.resources[0].details.scope).toEqual({ allowedRepositories: ['dimakis/mgmt'] });
  }
});

it('keeps ambiguous provider records and omits an unused Google management integration', async () => {
  const inventory = await readConnectionsAccess({
    ...sources(),
    managed: () => [connection, { ...connection, id: 'second' }],
    google: async () => ({ health: 'not_configured', expiresAt: null, slidesEditing: false }),
    legacy: async () => [
      { name: 'managed-jira', type: 'jira' },
      { name: 'google-workspace', type: 'mitzo-google-workspace-spike' },
    ],
  });
  expect(inventory.resources.filter((row) => row.kind === 'legacy-provider')).toHaveLength(2);
  expect(inventory.resources.some((row) => row.kind === 'google-workspace')).toBe(false);
  expect(
    inventory.resources.find((row) => row.nativeId === 'google-workspace')?.details.serviceName,
  ).toBe('Google Workspace');
});

it('reconciles provider records only when their current identifiers and workspace agree', async () => {
  for (const [id, workspace, legacyCount] of [
    ['provider-1', 'default', 0],
    ['replacement', 'default', 1],
    ['provider-1', 'other', 1],
    [undefined, undefined, 1],
  ] as const) {
    const inventory = await readConnectionsAccess({
      ...sources(),
      managed: () => [{ ...connection, gatewayProviderId: 'provider-1' }],
      legacy: async () => [{ name: connection.gatewayProviderName, type: 'jira', id, workspace }],
    });
    expect(inventory.resources.filter((row) => row.kind === 'legacy-provider')).toHaveLength(
      legacyCount,
    );
  }
});

it('includes the current Symposium catalog with owner-scoped identity even when native account IDs match', async () => {
  const inventory = await readConnectionsAccess({
    ...sources(),
    symposiumAccounts: () => [
      {
        ...account,
        label: 'Dynamic Symposium',
        models: [{ id: 'dynamic-model', label: 'Dynamic model' }],
      },
    ],
  });
  const accounts = inventory.resources.filter((row) => row.kind === 'ai-account');
  expect(accounts).toHaveLength(2);
  expect(accounts.map((row) => row.owner)).toEqual([
    'account-profiles',
    'symposium-account-profiles',
  ]);
  expect(new Set(accounts.map((row) => row.id)).size).toBe(2);
  expect(accounts[1].nativeId).toBe(accounts[0].nativeId);
  expect(accounts[1].details.models).toEqual([{ id: 'dynamic-model', label: 'Dynamic model' }]);
  expect(inventory.sources.find((source) => source.id === 'symposiumAccounts')!.state).toBe(
    'available',
  );
});
it('reports Symposium catalog failure independently from the available primary catalog', async () => {
  const inventory = await readConnectionsAccess({
    ...sources(),
    symposiumAccounts: () => {
      throw new Error('SECRET');
    },
  });
  expect(inventory.sources.find((source) => source.id === 'symposiumAccounts')!.state).toBe(
    'unavailable',
  );
  expect(inventory.resources.some((row) => row.owner === 'account-profiles')).toBe(true);
  expect(inventory.resources.some((row) => row.owner === 'symposium-account-profiles')).toBe(false);
  expect(JSON.stringify(inventory)).not.toContain('SECRET');
});

it.each([
  ['connected', 1, 'current'],
  ['connected', 2, 'stale'],
  ['disconnected', 1, 'stale'],
] as const)(
  'links catalog provenance only to the current connected personal snapshot (%s, %s)',
  async (state, revision, linkState) => {
    const inventory = await readConnectionsAccess({
      accounts: () => [account],
      symposiumAccounts: () => [
        {
          ...account,
          provider: 'openai-codex' as const,
          personalConnection: { id: 'same', revision: 1 },
        },
      ],
      personal: () => [{ id: 'same', label: 'Changed label', state, revision }],
    });
    expect(inventory.resources).toHaveLength(3);
    expect(
      inventory.resources.find((row) => row.owner === 'symposium-account-profiles'),
    ).toMatchObject({
      personalConnection: {
        resourceId: inventoryIdentity(
          'personal-connection',
          'symposium-personal',
          null,
          null,
          'same',
        ),
        revision: 1,
        state: linkState,
      },
    });
    expect(inventory.resources.find((row) => row.owner === 'account-profiles')).not.toHaveProperty(
      'personalConnection',
    );
  },
);
it('retains the catalog facet and unavailable relationship when personal reads fail', async () => {
  const inventory = await readConnectionsAccess({
    symposiumAccounts: () => [
      {
        ...account,
        provider: 'openai-codex' as const,
        personalConnection: { id: 'same', revision: 1 },
      },
    ],
    personal: () => {
      throw new Error('SECRET');
    },
  });
  expect(inventory.resources).toHaveLength(1);
  expect(inventory.resources[0]).toMatchObject({ personalConnection: { state: 'unavailable' } });
  expect(inventory.sources.find((source) => source.id === 'personal')!.state).toBe('unavailable');
});
