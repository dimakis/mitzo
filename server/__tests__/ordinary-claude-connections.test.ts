import './fixtures/offline-user-home.js';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SessionRegistry, setSkillPolicy } from '@mitzo/harness';
import { createCredentialSdkServer, credentialSdkPermission } from '../credential-sdk-tools.js';
import { agentToolCatalog } from '../agent-tool-catalog.js';
import { assertAgentToolRoute, bindAgentToolSelection } from '../agent-tool-selection.js';
import { CredentialConnections, CredentialConnectionStore } from '../credential-connections.js';
import { setCredentialConnectionsRuntime } from '../credential-connections-runtime.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  setCredentialConnectionsRuntime(null);
  vi.restoreAllMocks();
});

async function fixture(mode: 'ask' | 'agent' | 'auto' = 'agent', selected?: boolean) {
  const store = new CredentialConnectionStore(':memory:');
  cleanups.push(() => store.close());
  const vault = {
    save: vi.fn(async () => ({ service: 'offline-vault', account: 'private-ref' })),
    link: vi.fn(async () => ({ service: 'offline-vault', account: 'private-ref' })),
    read: vi.fn(async () => 'PRIVATE_FIXTURE_TOKEN'),
    remove: vi.fn(async () => {}),
  };
  const send = vi.fn(async () => ({ status: 200, body: 'must not be requested' }));
  const service = new CredentialConnections(store, vault, send);
  const connection = await service.create(
    {
      label: 'Offline service',
      endpoint: 'https://service.example.test',
      auth: { kind: 'bearer' },
      paths: ['/api/'],
      methods: ['GET'],
    },
    { secret: 'PRIVATE_FIXTURE_TOKEN' },
  );
  setCredentialConnectionsRuntime(service);
  const registry = new SessionRegistry();
  cleanups.push(() => registry.dispose());
  registry.register('owner', {
    sessionId: 'original',
    mode,
    abortController: new AbortController(),
  } as never);
  const session = registry.get('owner')!;
  if (selected !== undefined) {
    const profile = {
      tools: selected ? [{ id: 'mitzo:ListConnections', version: 1 }] : [],
    } as never;
    assertAgentToolRoute(profile, 'claude-sdk');
    bindAgentToolSelection(session, profile, 'claude-sdk');
  }
  const authority = { current: true, afterCheck: undefined as (() => void) | undefined };
  const assertCurrent = () => {
    if (!authority.current) throw Error('Original Claude authority revoked');
  };
  const server = createCredentialSdkServer(() => session.sessionId, session, registry, {
    profilesOnly: true,
    connectionBoundary: 'sdk-callback',
    assertCurrentSync: assertCurrent,
    assertCurrent: async () => {
      assertCurrent();
      authority.afterCheck?.();
    },
  });
  const client = new Client({ name: 'offline-claude-discovery', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.instance.close();
  });
  const list = () => client.callTool({ name: 'ListConnections', arguments: {} });
  const names = async () => (await client.listTools()).tools.map((tool) => tool.name);
  const text = (result: Awaited<ReturnType<typeof list>>) => JSON.stringify(result.content);
  return {
    store,
    vault,
    send,
    service,
    connection,
    registry,
    session,
    authority,
    client,
    names,
    list,
    text,
  };
}

it.each(['ask', 'agent', 'auto'] as const)(
  'lists existing metadata in %s without reading credentials or granting access',
  async (mode) => {
    const f = await fixture(mode);
    expect(await f.names()).toContain('ListConnections');
    const result = await f.list();
    expect(result.isError).not.toBe(true);
    expect(f.text(result)).toContain('Offline service');
    expect(f.text(result)).toContain('approval_required');
    expect(f.text(result)).not.toMatch(/PRIVATE_FIXTURE_TOKEN|private-ref|credentialRef/);
    expect(f.store.hasGrant('original', f.service.connection(f.connection.id))).toBe(false);
    expect(f.vault.read).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(
      credentialSdkPermission(
        'mcp__mitzo-connections__ListConnections',
        {},
        'owner',
        f.registry,
        f.session,
      ),
    ).toMatchObject({ behavior: 'allow' });
    for (const name of [
      'RequestConnectionAccess',
      'ConnectionRequest',
      'PrepareConnectionSetup',
      'ConnectionWebSocket',
      'HomeAssistantDashboard',
    ]) {
      expect(await f.names()).not.toContain(name);
      expect(await f.client.callTool({ name, arguments: {} })).toMatchObject({ isError: true });
    }
  },
);

it.each([true, false])('respects explicit profile discovery selection=%s', async (selected) => {
  const f = await fixture('agent', selected);
  if (selected) {
    expect(await f.names()).toContain('ListConnections');
    expect((await f.list()).isError).not.toBe(true);
  } else {
    // The SDK omits tools/list and tools/call entirely for an empty server.
    await expect(f.names()).rejects.toThrow(/Method not found/);
    await expect(f.list()).rejects.toThrow(/Method not found/);
  }
  expect(
    credentialSdkPermission(
      'mcp__mitzo-connections__ListConnections',
      {},
      'owner',
      f.registry,
      f.session,
    ),
  ).toMatchObject({ behavior: selected ? 'allow' : 'deny' });
});

it('makes only read-only connection discovery eligible on the Claude route', () => {
  const connections = agentToolCatalog().filter((entry) => entry.source === 'Connections');
  expect(
    connections.filter((entry) => entry.routes.includes('claude-sdk')).map((entry) => entry.name),
  ).toEqual(['ListConnections']);
});

it('retains per-session access states without borrowing another chat grant', async () => {
  const f = await fixture();
  f.service.grant('another-chat', f.connection.id, f.connection.revision);
  expect(f.text(await f.list())).toContain('approval_required');
  f.service.grant('original', f.connection.id, f.connection.revision);
  expect(f.text(await f.list())).toContain('approved');
  f.service.revokeSession('original', f.connection.id);
  expect(f.text(await f.list())).toContain('approval_required');
});

it.each(['cancel', 'skill', 'owner', 'authority', 'await-cancel', 'await-revoke', 'after-read'])(
  'refuses stale discovery after %s changes',
  async (change) => {
    const f = await fixture();
    const catalog = vi.spyOn(f.service, 'catalog');
    if (change === 'cancel') f.session.abortController.abort();
    if (change === 'skill') setSkillPolicy(f.registry, 'owner', []);
    if (change === 'owner')
      f.registry.register('owner', {
        sessionId: 'replacement',
        abortController: new AbortController(),
      } as never);
    if (change === 'authority') f.authority.current = false;
    if (change === 'await-cancel') f.authority.afterCheck = () => f.session.abortController.abort();
    if (change === 'await-revoke')
      f.authority.afterCheck = () => {
        f.authority.current = false;
      };
    if (change === 'after-read')
      catalog.mockImplementationOnce(() => {
        f.authority.current = false;
        return [{ label: 'WITHHELD_METADATA' }] as never;
      });
    const result = await f.list();
    expect(result.isError).toBe(true);
    expect(f.text(result)).not.toContain('WITHHELD_METADATA');
    if (change !== 'after-read') expect(catalog).not.toHaveBeenCalled();
  },
);

it('reports catalog failure safely and permits the next read', async () => {
  const f = await fixture();
  vi.spyOn(f.service, 'catalog').mockImplementationOnce(() => {
    throw Error('PRIVATE_FIXTURE_TOKEN');
  });
  const failed = await f.list();
  expect(failed.isError).toBe(true);
  expect(f.text(failed)).toContain('diagnosticId');
  expect(f.text(failed)).not.toContain('PRIVATE_FIXTURE_TOKEN');
  expect(f.text(await f.list())).toContain('Offline service');
});

it('reports an unconfigured catalog without inventing verified service access', async () => {
  const f = await fixture();
  setCredentialConnectionsRuntime(null);
  const result = await f.list();
  expect(result.isError).not.toBe(true);
  expect(f.text(result)).toContain('keychainConfigured');
  expect(f.text(result)).toContain('false');
  expect(f.text(result)).not.toContain('Offline service');
});
