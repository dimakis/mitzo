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
import { nativeConnectionToolNames } from '../credential-connection-tools.js';
import { ordinarySdkConnectionHelperTools } from '../ordinary-sdk-helper-registration.js';
import {
  getPendingRequestsBySession,
  resolvePending,
} from '../../packages/harness/src/permissions.js';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from '../async-queue.js';
import {
  createOrdinaryLocalVertexSdkQuery,
  SdkHookLifetime,
} from '../ordinary-local-vertex-sdk-query.js';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: vi.fn(),
  getSessionInfo: vi.fn(async () => ({ sessionId: 'original', cwd: process.cwd() })),
  getSessionMessages: vi.fn(async () => [{ uuid: 'input' }]),
}));

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  setCredentialConnectionsRuntime(null);
  vi.restoreAllMocks();
});

async function fixture(
  mode: 'ask' | 'agent' | 'auto' = 'agent',
  selected?: boolean | string[],
  withTransport = false,
) {
  const store = new CredentialConnectionStore(':memory:');
  cleanups.push(() => store.close());
  const vault = {
    save: vi.fn(async () => ({ service: 'offline-vault', account: 'private-ref' })),
    link: vi.fn(async () => ({ service: 'offline-vault', account: 'private-ref' })),
    read: vi.fn(async () => 'PRIVATE_FIXTURE_TOKEN'),
    remove: vi.fn(async () => {}),
  };
  const send = vi.fn(async () => ({ status: 200, body: 'offline service result' }));
  const frame = async (input: { check(): void; assertRuntimeCurrent?: () => Promise<void> }) => {
    await input.assertRuntimeCurrent?.();
    input.check();
    return '{"ok":true,"config":{},"configHash":"offline"}';
  };
  const dashboard = vi.fn(frame),
    websocket = vi.fn(frame);
  const service = new CredentialConnections(store, vault, send, dashboard, websocket);
  const connection = await service.create(
    {
      label: 'Offline service',
      endpoint: 'https://service.example.test',
      auth: { kind: 'bearer' },
      paths: ['/api/'],
      methods: ['GET', 'POST'],
      serviceTemplate: 'home-assistant',
      homeAssistantDashboards: 'read-write',
      websocket: { path: '/api/websocket', authentication: { kind: 'headers' } },
    },
    { secret: 'PRIVATE_FIXTURE_TOKEN' },
  );
  setCredentialConnectionsRuntime(service);
  const registry = new SessionRegistry();
  cleanups.push(() => registry.dispose());
  registry.register('owner', {
    sessionId: 'original',
    mode,
    sessionAllowList: new Set(),
    abortController: new AbortController(),
    transport: {
      send(event: { type: string; permId: string }) {
        if (!withTransport && event.type === 'permission_request')
          queueMicrotask(() => resolvePending(event.permId, 'deny'));
      },
      isOpen: () => true,
    },
  } as never);
  const session = registry.get('owner')!;
  if (selected !== undefined) {
    const profile = {
      tools: (Array.isArray(selected) ? selected : selected ? ['ListConnections'] : []).map(
        (name) => ({ id: `mitzo:${name}`, version: 1 }),
      ),
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
    dashboard,
    websocket,
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
      expect(await f.names()).toContain(name);
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

it('invokes an explicitly selected operation while excluding other connection helpers', async () => {
  const f = await fixture('agent', ['ConnectionRequest', 'RequestConnectionAccess']);
  f.service.grant('original', f.connection.id, f.connection.revision);
  expect(await f.names()).toContain('ConnectionRequest');
  expect(await f.names()).not.toContain('HomeAssistantDashboard');
  const result = await f.client.callTool({
    name: 'ConnectionRequest',
    arguments: {
      connectionId: f.connection.id,
      method: 'GET',
      path: '/api/states',
    },
  });
  expect(result.isError).toBe(false);
  expect(f.send).toHaveBeenCalledOnce();
  expect(
    (
      await f.client.callTool({
        name: 'HomeAssistantDashboard',
        arguments: {
          connectionId: f.connection.id,
          operation: 'read',
        },
      })
    ).isError,
  ).toBe(true);
  expect(f.dashboard).not.toHaveBeenCalled();
});

it.each([
  ['ConnectionWebSocket', { message: '{}' }],
  ['HomeAssistantDashboard', { operation: 'read' }],
  [
    'HomeAssistantDashboard',
    { operation: 'save', config: '{}', expectedConfigHash: 'a'.repeat(64) },
  ],
] as const)('dispatches %s via its existing private transport', async (name, input) => {
  const f = await fixture();
  f.service.grant('original', f.connection.id, f.connection.revision);
  const result = await f.client.callTool({
    name,
    arguments: { connectionId: f.connection.id, ...input },
  });
  expect(result.isError).toBe(false);
  expect(f.text(result)).toContain('ok');
  expect(name === 'ConnectionWebSocket' ? f.websocket : f.dashboard).toHaveBeenCalledOnce();
  expect(f.text(result)).not.toContain('PRIVATE_FIXTURE_TOKEN');
});

it('uses canonical guidance and secure setup/status without requesting credentials from the model', async () => {
  const f = await fixture();
  const guide = await f.client.callTool({
    name: 'GetConnectionGuide',
    arguments: { topic: 'connect' },
  });
  expect(guide.isError).toBe(false);
  const prepared = await f.client.callTool({
    name: 'PrepareConnectionSetup',
    arguments: {
      profile: 'home-assistant',
      endpoint: 'https://setup.example.test',
      access: 'read',
    },
  });
  expect(prepared.isError).toBe(false);
  const setup = JSON.parse((prepared.content as Array<{ text: string }>)[0].text).setup;
  expect(setup.status).toBe('pending');
  expect(
    (await f.client.callTool({ name: 'GetConnectionSetup', arguments: { setupId: setup.id } }))
      .isError,
  ).toBe(false);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.vault.read).not.toHaveBeenCalled();
});

it.each(['once', 'deny', 'expiry', 'cancel', 'revoke'] as const)(
  'retains the canonical access card and %s outcome through SDK MCP',
  async (outcome) => {
    const f = await fixture('auto', undefined, true);
    const pending = f.client.callTool({
      name: 'RequestConnectionAccess',
      arguments: { connectionId: f.connection.id },
    });
    await vi.waitFor(() => expect(getPendingRequestsBySession('original')).toHaveLength(1));
    const request = getPendingRequestsBySession('original')[0];
    if (outcome === 'cancel') f.session.abortController.abort();
    else if (outcome === 'revoke') f.service.revokeSession('original', f.connection.id);
    else {
      if (outcome === 'expiry') vi.spyOn(Date, 'now').mockReturnValue(request.expiresAt! + 1);
      resolvePending(request.permId, outcome === 'deny' ? 'deny' : 'once');
    }
    const result = await pending;
    expect(result.isError).toBe(outcome !== 'once');
    expect(f.store.hasGrant('original', f.service.connection(f.connection.id))).toBe(
      outcome === 'once',
    );
    expect(f.send).not.toHaveBeenCalled();
    if (outcome === 'once') {
      expect(
        (
          await f.client.callTool({
            name: 'RequestConnectionAccess',
            arguments: { connectionId: f.connection.id },
          })
        ).isError,
      ).toBe(false);
      expect(getPendingRequestsBySession('original')).toHaveLength(0);
    }
  },
);

it('invokes service requests on first query, queued successor and cold continuation using the ordinary query owner', async () => {
  const f = await fixture();
  f.service.grant('original', f.connection.id, f.connection.revision);
  const requests: Options[] = [];
  vi.mocked(query).mockImplementation((request) => {
    requests.push(request.options!);
    return { close: vi.fn(), async *[Symbol.asyncIterator]() {} } as never;
  });
  const start = (resume = false) => {
    const controller = new AbortController();
    cleanups.push(() => controller.abort());
    return createOrdinaryLocalVertexSdkQuery({
      options: resume ? { resume: 'original' } : { sessionId: 'original' },
      input: new AsyncQueue(),
      lifetime: new SdkHookLifetime(),
      sdkSessionId: 'original',
      cwd: process.cwd(),
      controller,
      authorize: async () => {},
      authorizeSync: () => {},
      adapt: (q) => q as never,
      settings: () => ({}),
      inputChanged: () => {},
      onUnsent: vi.fn(),
      mcpServers: (state) => {
        const assert = () => {
          if (state.retired || state.completing) throw Error('Original query retired');
        };
        return {
          'mitzo-connections': createCredentialSdkServer(() => 'original', f.session, f.registry, {
            profilesOnly: true,
            connectionBoundary: 'sdk-callback',
            runCallback: state.runCallback,
            assertCurrent: async () => assert(),
            assertCurrentSync: assert,
          }),
        };
      },
    });
  };
  const connect = async (options: Options) => {
    const server = options.mcpServers!['mitzo-connections'] as ReturnType<
      typeof createCredentialSdkServer
    >;
    const client = new Client({ name: 'offline-lifecycle', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(a);
    await client.connect(b);
    cleanups.push(async () => {
      await client.close();
      await server.instance.close();
    });
    return () =>
      client.callTool({
        name: 'ConnectionRequest',
        arguments: { connectionId: f.connection.id, path: '/api/example', method: 'GET' },
      });
  };
  const owner = start();
  await owner.apply({ model: 'offline-first' } as never);
  const first = await connect(requests[0]);
  expect((await first()).isError).toBe(false);
  await owner.apply({ model: 'offline-successor' } as never);
  const next = await connect(requests[1]);
  expect(requests[1].resume).toBe('original');
  expect((await first()).isError).toBe(true);
  expect((await next()).isError).toBe(false);
  const cold = start(true);
  await cold.apply({ model: 'offline-cold' } as never);
  expect(requests[2].resume).toBe('original');
  expect((await (await connect(requests[2]))()).isError).toBe(false);
  expect(f.send).toHaveBeenCalledTimes(3);
});

it('makes existing native connection operations eligible on the Claude route', () => {
  const connections = agentToolCatalog().filter((entry) => entry.source === 'Connections');
  expect(
    connections.filter((entry) => entry.routes.includes('claude-sdk')).map((entry) => entry.name),
  ).toEqual(expect.arrayContaining([...nativeConnectionToolNames]));
  for (const name of nativeConnectionToolNames)
    expect(ordinarySdkConnectionHelperTools).toContain(`mcp__mitzo-connections__${name}`);
});

it.each(['GET', 'POST'] as const)(
  'invokes an authorized %s through the actual SDK MCP and service owner',
  async (method) => {
    const f = await fixture();
    f.service.grant('original', f.connection.id, f.connection.revision);
    const result = await f.client.callTool({
      name: 'ConnectionRequest',
      arguments: {
        connectionId: f.connection.id,
        method,
        path: '/api/example',
      },
    });
    expect(result.isError).not.toBe(true);
    expect(f.text(result)).toContain('offline service result');
    expect(f.text(result)).not.toContain('PRIVATE_FIXTURE_TOKEN');
    expect(f.send).toHaveBeenCalledOnce();
  },
);

it.each(['ask-write', 'revoked', 'cancelled', 'retired', 'wrong-path'] as const)(
  'blocks service effects for %s at SDK invocation',
  async (failure) => {
    const f = await fixture(failure === 'ask-write' ? 'ask' : 'auto');
    f.service.grant('original', f.connection.id, f.connection.revision);
    if (failure === 'revoked') f.service.revokeSession('original', f.connection.id);
    if (failure === 'cancelled') f.session.abortController.abort();
    if (failure === 'retired') f.authority.current = false;
    const result = await f.client.callTool({
      name: 'ConnectionRequest',
      arguments: {
        connectionId: f.connection.id,
        method: 'POST',
        path: failure === 'wrong-path' ? '/forbidden' : '/api/example',
      },
    });
    expect(result.isError).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
  },
);

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
