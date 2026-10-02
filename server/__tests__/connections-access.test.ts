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
  gatewayProviderId: null,
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
} satisfies ReturnType<NonNullable<ConnectionsAccessSources['accounts']>>[number] & {
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
    { name: 'managed-jira', type: 'jira' },
    { name: 'other', type: 'custom' },
  ],
  gateway: 'primary',
  workspace: 'default',
});

describe('nonsecret Connections & access inventory', () => {
  it('keeps identity boundaries and does not confuse model discovery with account verification', async () => {
    const result = await readConnectionsAccess(sources(), { now: 1_000, freshnessMs: 500 });
    expect(new Set(result.resources.map((r) => r.id)).size).toBe(result.resources.length);
    const account = result.resources.find((r) => r.kind === 'ai-account')!;
    expect(account.status).toBe('configured');
    expect(account.actions).toEqual([]);
    expect(account.verification.reason).toContain('Credential controls are unavailable');
    expect(account.verification.state).toBe('unverified');
    expect(account.verification.verifiedAt).toBeNull();
    const managed = result.resources.find((r) => r.kind === 'managed-connection')!;
    expect(managed.verification.state).toBe('stale');
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
