import './fixtures/offline-user-home.js';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SessionRegistry } from '@mitzo/harness';
import { ConfiguredToolCatalog } from '../configured-tool-catalog.js';
import { ApiToolCatalog } from '../api-tool-catalog.js';
import { CredentialConnections, CredentialConnectionStore } from '../credential-connections.js';
import { setCredentialConnectionsRuntime } from '../credential-connections-runtime.js';
import { assertAgentToolRoute, bindAgentToolSelection } from '../agent-tool-selection.js';
import { createSdkToolLibrary } from '../tool-library-sdk.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  setCredentialConnectionsRuntime(null);
});
async function fixture(kind: 'mcp' | 'api') {
  const registry = new SessionRegistry();
  const configured = new ConfiguredToolCatalog(':memory:');
  const api = new ApiToolCatalog(':memory:');
  const store = new CredentialConnectionStore(':memory:');
  cleanups.push(
    () => registry.dispose(),
    () => configured.close(),
    () => api.close(),
    () => store.close(),
  );
  const send = vi.fn(async () => ({
    status: 200,
    body: '{"entity_id":"sensor.office","state":"21","last_changed":"2026-11-14T00:00:00Z"}',
  }));
  const service = new CredentialConnections(
    store,
    {
      save: async () => ({ service: 'fixture', account: 'fixture' }),
      read: async () => 'PRIVATE_TOKEN',
      link: vi.fn(),
      remove: vi.fn(),
    },
    send,
  );
  const connection = await service.create(
    {
      label: 'Offline',
      endpoint: 'https://service.example.test',
      serviceTemplate: 'home-assistant',
      auth: { kind: 'bearer' },
      methods: ['GET'],
      paths: ['/api/'],
    },
    { secret: 'PRIVATE_TOKEN' },
  );
  setCredentialConnectionsRuntime(service);
  registry.register('owner', {
    sessionId: 'library-chat',
    cwd: process.cwd(),
    mode: 'auto',
    abortController: new AbortController(),
    sessionAllowList: new Set(),
  } as never);
  const session = registry.get('owner')!;
  service.grant(session.sessionId!, connection.id, connection.revision);
  const configs = {
    synthetic: {
      command: 'offline-provider',
      librarySourceId: '11111111-1111-4111-8111-111111111111',
    },
  };
  const callTool = vi.fn(async () => ({
    content: [{ type: 'text', text: 'published MCP result' }],
  }));
  const connect = vi.fn(async () => ({
    listTools: async () => ({
      tools: [
        {
          name: 'read',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        { name: 'unselected', inputSchema: { type: 'object' } },
      ],
    }),
    callTool,
    close: vi.fn(async () => {}),
  }));
  const source = {
    cwd: process.cwd(),
    env: {},
    signal: session.abortController.signal,
    readSources: () => configs,
    connect,
    assertRuntimeCurrent: () => {},
  };
  const rows = await configured.refresh(source);
  const row = rows.find((r) => r.name === 'read')!;
  const draft = api.save(
    {
      id: randomUUID(),
      expectedVersion: 0,
      configuration: {
        template: 'home-assistant.state@1',
        label: 'Office',
        connectionId: connection.id,
        entityId: 'sensor.office',
      },
    },
    service,
  );
  await api.verify(draft.id, draft.version, {
    service,
    signal: session.abortController.signal,
    assertCurrent: () => {},
  });
  const entry = api.publish(draft.id, draft.version, service);
  const refs =
    kind === 'mcp'
      ? [configured.reference(row)]
      : [api.reference(entry), { id: 'mitzo:RequestConnectionAccess', version: 1 }];
  const profile = { tools: refs } as never;
  assertAgentToolRoute(profile, 'claude-sdk');
  bindAgentToolSelection(session, profile, 'claude-sdk');
  session.sessionAllowList.add(
    `configured-mcp:${JSON.stringify([configs.synthetic.librarySourceId, 'read'])}`,
  );
  connect.mockClear();
  callTool.mockClear();
  send.mockClear();
  let current = true;
  const assertCurrentSync = () => {
    if (!current) throw Error('original authority revoked');
  };
  const library = await createSdkToolLibrary({
    sessionId: 'library-chat',
    session,
    registry,
    refs,
    cwd: process.cwd(),
    env: {},
    configured: { catalog: configured, ...source },
    apiCatalog: api,
    assertCurrent: async () => assertCurrentSync(),
    assertCurrentSync,
  });
  const open = async () => {
    let retired = false;
    const server = library!.createServer({
      assertCurrent: async () => {
        assertCurrentSync();
        if (retired) throw Error('query retired');
      },
      assertCurrentSync: () => {
        assertCurrentSync();
        if (retired) throw Error('query retired');
      },
    });
    const client = new Client({ name: 'offline-library', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(a);
    await client.connect(b);
    cleanups.push(async () => {
      await client.close();
      await server.instance.close();
    });
    const tools = (await client.listTools()).tools;
    const invoke = () => client.callTool({ name: tools[0].name, arguments: {} });
    return {
      client,
      tools,
      invoke,
      retire: () => {
        retired = true;
      },
    };
  };
  return {
    open,
    library,
    callTool,
    send,
    connect,
    service,
    connection,
    revoke: () => {
      current = false;
    },
  };
}
it.each(['mcp', 'api'] as const)(
  'invokes selected published %s tools across first, successor and cold adapters',
  async (kind) => {
    const f = await fixture(kind);
    expect(f.connect).not.toHaveBeenCalled();
    for (let turn = 0; turn < 3; turn++) {
      const q = await f.open();
      expect(q.tools).toHaveLength(1);
      expect((await q.invoke()).isError).not.toBe(true);
      q.retire();
      expect((await q.invoke()).isError).toBe(true);
    }
    expect(kind === 'mcp' ? f.callTool : f.send).toHaveBeenCalledTimes(3);
  },
);
it.each(['mcp', 'api'] as const)(
  'refuses selected %s tools after authority revocation',
  async (kind) => {
    const f = await fixture(kind);
    const q = await f.open();
    f.revoke();
    expect((await q.invoke()).isError).toBe(true);
    expect(f.callTool).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  },
);
