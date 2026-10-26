import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventStore } from '../event-store.js';
const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  send: vi.fn(),
  permissionHandler: vi.fn(),
  conversationOptions: undefined as Record<string, unknown> | undefined,
}));
vi.mock('../codex-conversation-store.js', async (original) => ({
  ...(await original<typeof import('../codex-conversation-store.js')>()),
  CodexConversationStore: class {
    recoverAtStartup() {}
  },
}));
vi.mock('../codex-conversation.js', () => ({
  CodexConversation: class {
    constructor(private options: { onClosed(): void }) {
      mocks.conversationOptions = options;
    }
    recoverSavedQueue = vi.fn();
    initialize = mocks.initialize;
    send = mocks.send;
    getTurnDispatchCount = () => 0;
    getThreadId = () => 'offline-thread';
    getDurableThreadId = () => 'offline-thread';
    close() {
      this.options.onClosed();
    }
  },
}));
vi.mock('../codex-private-path.js', async (original) => ({
  ...(await original<typeof import('../codex-private-path.js')>()),
  codexPrivateDirectory: () => '/tmp',
}));
vi.mock('@mitzo/harness', async (original) => ({
  ...(await original<typeof import('@mitzo/harness')>()),
  buildPermissionHandler: () => mocks.permissionHandler,
}));
import { openCodexChat } from '../codex-chat-session.js';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.conversationOptions = undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw Error('Unexpected network request in offline fixture');
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function selectedCodexToolsFixture() {
  const { SessionRegistry } = await import('@mitzo/harness');
  const { AgentLibraryStore } = await import('../agent-library-store.js');
  const { ConfiguredToolCatalog } = await import('../configured-tool-catalog.js');
  const hookModule = await import('../native-hooks.js');
  const originalHooks = hookModule.createNativeHooks;
  const dispose = vi.fn();
  const hooks = vi.spyOn(hookModule, 'createNativeHooks').mockImplementation((...args) => {
    const runtime = originalHooks(...args);
    return {
      ...runtime,
      dispose: () => {
        dispose();
        runtime.dispose();
      },
    };
  });
  const root = mkdtempSync(join(tmpdir(), 'codex-selected-tools-'));
  const abort = new AbortController();
  const registry = new SessionRegistry();
  const messages: Record<string, unknown>[] = [];
  registry.register('selected-client', {
    sessionId: 'selected-chat',
    cwd: root,
    mode: 'agent',
    abortController: abort,
    sessionAllowList: new Set<string>(),
    transport: {
      send: (message) => {
        messages.push(message);
      },
      isOpen: () => true,
    },
  });
  const session = registry.get('selected-client')!;
  const events = new EventStore(':memory:');
  const library = new AgentLibraryStore(':memory:');
  const catalog = new ConfiguredToolCatalog(':memory:');
  const sources: Record<string, import('../mcp-config.js').McpServerConfig> = {
    selected: { command: 'selected-peer', librarySourceId: '11111111-1111-4111-8111-111111111111' },
    other: { command: 'unselected-peer', librarySourceId: '22222222-2222-4222-8222-222222222222' },
  };
  const call = vi.fn(async () => ({ content: [{ type: 'text', text: 'selected result' }] }));
  const close = vi.fn(async () => {});
  const connect = vi.fn(async (_config: import('../mcp-config.js').McpServerConfig) => ({
    listTools: async () => ({
      tools: ['search', 'unselected'].map((name) => ({ name, inputSchema: { type: 'object' } })),
    }),
    callTool: call,
    close,
  }));
  const sourceOptions = {
    cwd: root,
    env: {},
    signal: abort.signal,
    readSources: () => sources,
    assertRuntimeCurrent: () => {},
    connect,
  };
  mocks.initialize.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue(undefined);
  mocks.permissionHandler.mockImplementation(async (_name, input) => ({
    behavior: 'allow',
    updatedInput: input,
  }));
  const opts = {
    session,
    registry,
    profile: {
      planType: 'pro',
      credentialRef: '/offline/login',
      accountId: 'offline',
      accountLabel: 'Offline',
      email: 'offline@example.test',
      model: 'offline',
    },
    eventStore: events,
    conversationId: 'selected-chat',
    messageId: 'offline-command',
    prompt: 'Offline request',
    reattachOnly: true,
    systemPrompt: '',
    env: {},
    configuredSourceEnv: {},
    mcpServers: sources,
    binding: {
      accountId: 'offline',
      accountLabel: 'Offline',
      provider: 'openai-codex' as const,
      model: 'offline',
      profileRevision: 'fixture',
    },
    configuredTools: { catalog, ...sourceOptions },
  };
  const publish = (tools: import('@mitzo/protocol').AgentToolReference[]) => {
    const draft = library.saveDraft('user', {
      profileId: 'selected',
      expectedVersion: 0,
      expectedRevision: 0,
      idempotencyKey: 'save',
      definition: {
        name: 'Selected',
        role: 'agent',
        instructions: 'Published instructions',
        expectedOutput: 'Evidence',
        acceptanceCriteria: ['Selected effects only'],
        modelPolicyRole: 'agent',
        tools,
      },
    });
    const profile = library.publish('user', {
      profileId: draft.profileId,
      expectedVersion: draft.version,
      idempotencyKey: 'publish',
    });
    events.upsertSession({ sessionId: 'selected-chat', agentProfile: profile });
    return profile;
  };
  const execute = (name: string, input = {}, signal = abort.signal) =>
    (
      mocks.conversationOptions!.executeTool as (
        name: string,
        input: Record<string, unknown>,
        signal: AbortSignal,
        context: { turnId: string; callId: string },
      ) => Promise<{ content: string; isError: boolean }>
    )(name, input, signal, { turnId: 'turn', callId: 'call' });
  return {
    opts,
    publish,
    catalog,
    sourceOptions,
    sources,
    connect,
    close,
    call,
    abort,
    registry,
    messages,
    hooks,
    dispose,
    execute,
    cleanup: () => {
      hooks.mockRestore();
      catalog.close();
      library.close();
      events.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it('applies an explicitly empty published selection at the provider and execution boundaries and disables project hooks', async () => {
  const f = await selectedCodexToolsFixture();
  vi.stubEnv('MITZO_TRUST_PROJECT_HOOKS', '1');
  f.publish([]);
  const query = await openCodexChat(f.opts);
  try {
    expect(mocks.conversationOptions!.tools).toEqual([
      expect.objectContaining({ name: 'AskUserQuestion' }),
    ]);
    expect(mocks.conversationOptions!.runtimeConfig).toBeUndefined();
    expect(mocks.conversationOptions!.disableWebSearch).toBe(true);
    expect(f.connect).not.toHaveBeenCalled();
    await expect(f.execute('Read')).rejects.toThrow(/not selected/);
    expect(f.hooks).toHaveBeenCalledWith(
      expect.any(String),
      'selected-chat',
      {},
      { trustProjectHooks: false },
    );
  } finally {
    query.close();
    f.cleanup();
  }
});

it('preserves the real Ask ceiling and source-scoped Agent approval without expanding the selected surface', async () => {
  const f = await selectedCodexToolsFixture();
  const harness = await vi.importActual<typeof import('@mitzo/harness')>('@mitzo/harness');
  vi.stubEnv('PUSHOVER_API_TOKEN', '');
  vi.stubEnv('PUSHOVER_USER_KEY', '');
  try {
    const entry = (await f.catalog.refresh(f.sourceOptions))[0];
    f.publish([f.catalog.reference(entry)]);
    const query = await openCodexChat(f.opts);
    try {
      mocks.permissionHandler.mockImplementation(
        harness.buildPermissionHandler('selected-client', f.registry),
      );
      const wire = (mocks.conversationOptions!.tools as { name: string }[]).find(
        (tool) => tool.name !== 'AskUserQuestion',
      )!.name;
      f.opts.session.mode = 'ask';
      expect(await f.execute(wire)).toMatchObject({
        isError: true,
        content: expect.stringContaining('Ask mode'),
      });
      expect(f.messages).toHaveLength(0);
      f.opts.session.mode = 'agent';
      const pending = f.execute(wire);
      await vi.waitFor(() =>
        expect(f.messages.some((message) => message.type === 'permission_request')).toBe(true),
      );
      expect(f.call).not.toHaveBeenCalled();
      const request = f.messages.find((message) => message.type === 'permission_request')!;
      expect(request).toMatchObject({ toolName: 'mcp__selected__search' });
      expect(
        harness.resolvePending(request.permId as string, 'always', undefined, 'selected-chat'),
      ).toBe(true);
      expect(await pending).toMatchObject({ isError: false });
      expect(f.opts.session.sessionAllowList).toEqual(
        new Set([
          `configured-mcp:${JSON.stringify([f.sources.selected.librarySourceId, 'search'])}`,
        ]),
      );
      expect(f.call).toHaveBeenCalledOnce();
      f.opts.session.mode = 'ask';
      expect(await f.execute(wire)).toMatchObject({ isError: true });
      expect(f.call).toHaveBeenCalledOnce();
      await expect(f.execute('mcp__selected__unselected')).rejects.toThrow(/not selected/);
    } finally {
      query.close();
    }
  } finally {
    f.cleanup();
  }
});

it('uses selected MCP receipts in the real Codex adapter and rechecks current source configuration after approval', async () => {
  const f = await selectedCodexToolsFixture();
  try {
    const entries = await f.catalog.refresh(f.sourceOptions);
    const entry = entries.find((row) => row.source === 'selected' && row.name === 'search')!;
    f.publish([f.catalog.reference(entry)]);
    f.connect.mockClear();
    f.close.mockClear();
    const query = await openCodexChat(f.opts);
    try {
      expect(f.connect).toHaveBeenCalledTimes(1);
      expect(f.connect.mock.calls[0][0]).toMatchObject({ command: 'selected-peer' });
      const tools = mocks.conversationOptions!.tools as { name: string }[];
      expect(tools).toHaveLength(2);
      const wire = tools.find((tool) => tool.name !== 'AskUserQuestion')!.name;
      expect(await f.execute(wire, { query: 'original' })).toMatchObject({
        content: 'selected result',
        isError: false,
      });
      expect(mocks.permissionHandler).toHaveBeenLastCalledWith(
        'mcp__selected__search',
        { query: 'original' },
        expect.objectContaining({
          sessionGrantKey: expect.stringContaining('11111111-1111-4111-8111-111111111111'),
        }),
      );
      f.call.mockClear();
      mocks.permissionHandler.mockImplementationOnce(async (_name, input) => {
        delete f.sources.selected;
        return { behavior: 'allow', updatedInput: input };
      });
      expect(await f.execute(wire)).toMatchObject({ isError: true });
      expect(f.call).not.toHaveBeenCalled();
      await expect(f.execute('mcp__selected__unselected')).rejects.toThrow(/not selected/);
    } finally {
      query.close();
    }
    expect(f.close).toHaveBeenCalledOnce();
  } finally {
    f.cleanup();
  }
});

it('disposes acquired startup hooks when a selected source lacks its trusted launch environment', async () => {
  const f = await selectedCodexToolsFixture();
  try {
    const entry = (await f.catalog.refresh(f.sourceOptions))[0];
    f.publish([f.catalog.reference(entry)]);
    f.connect.mockClear();
    await expect(openCodexChat({ ...f.opts, configuredSourceEnv: undefined })).rejects.toThrow(
      /launch environment/,
    );
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledOnce();
  } finally {
    f.cleanup();
  }
});

it('refuses explicit selection before legacy OpenShell provisioning even when the account provider is Codex', async () => {
  const f = await selectedCodexToolsFixture();
  vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', 'legacy-fixture');
  try {
    f.publish([]);
    await expect(openCodexChat(f.opts)).rejects.toThrow(/tool selection is not supported/);
    expect(f.connect).not.toHaveBeenCalled();
  } finally {
    f.cleanup();
  }
});

it.each(['instructions', 'tools'] as const)(
  'captures the published profile once and rejects %s drift across MCP initialization',
  async (field) => {
    const f = await selectedCodexToolsFixture();
    try {
      const entry = (await f.catalog.refresh(f.sourceOptions))[0];
      const profile = f.publish([f.catalog.reference(entry)]);
      const connect = f.connect.getMockImplementation()!;
      f.connect.mockClear();
      f.close.mockClear();
      f.connect.mockImplementationOnce(async (config) => {
        if (field === 'instructions')
          profile.definition.instructions = 'Mutable editor replacement';
        else profile.definition.tools!.push({ id: 'mitzo:Write', version: 1 });
        return connect(config);
      });
      await expect(openCodexChat({ ...f.opts, agentProfile: profile })).rejects.toThrow(
        /profile changed/,
      );
      expect(f.connect).toHaveBeenCalledTimes(1);
      expect(f.connect.mock.calls[0][0].command).toBe('selected-peer');
      expect(f.close).toHaveBeenCalledOnce();
      expect(f.dispose).toHaveBeenCalledOnce();
    } finally {
      f.cleanup();
    }
  },
);

it.each(['session', 'cancellation', 'source-authority'] as const)(
  'prevents selected MCP effects after %s changes during approval',
  async (change) => {
    const f = await selectedCodexToolsFixture();
    try {
      const entry = (await f.catalog.refresh(f.sourceOptions))[0];
      f.publish([f.catalog.reference(entry)]);
      f.close.mockClear();
      const query = await openCodexChat(f.opts);
      try {
        const tools = mocks.conversationOptions!.tools as { name: string }[];
        const wire = tools.find((tool) => tool.name !== 'AskUserQuestion')!.name;
        mocks.permissionHandler.mockImplementationOnce(async (_name, input) => {
          if (change === 'session') f.registry.register('selected-client', { ...f.opts.session });
          else if (change === 'cancellation') f.abort.abort();
          else
            f.opts.configuredTools.assertRuntimeCurrent = () => {
              throw Error('Source revoked');
            };
          return { behavior: 'allow', updatedInput: input };
        });
        expect(await f.execute(wire)).toMatchObject({ isError: true });
        expect(f.call).not.toHaveBeenCalled();
      } finally {
        query.close();
      }
      await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
    } finally {
      f.cleanup();
    }
  },
);

it('retains the canonical MCP skill ceiling and approved argument updates', async () => {
  const f = await selectedCodexToolsFixture();
  try {
    const entry = (await f.catalog.refresh(f.sourceOptions))[0];
    f.publish([f.catalog.reference(entry)]);
    const query = await openCodexChat(f.opts);
    try {
      const wire = (mocks.conversationOptions!.tools as { name: string }[]).find(
        (tool) => tool.name !== 'AskUserQuestion',
      )!.name;
      mocks.permissionHandler.mockResolvedValueOnce({
        behavior: 'allow',
        updatedInput: { query: 'approved' },
      });
      expect(await f.execute(wire, { query: 'original' })).toMatchObject({ isError: false });
      expect(f.call).toHaveBeenLastCalledWith(
        { name: 'search', arguments: { query: 'approved' } },
        expect.any(AbortSignal),
      );
      f.call.mockClear();
      const harness = await vi.importActual<typeof import('@mitzo/harness')>('@mitzo/harness');
      harness.setSkillPolicy(f.registry, 'selected-client', ['Read']);
      mocks.permissionHandler.mockImplementation(
        harness.buildPermissionHandler('selected-client', f.registry),
      );
      expect(await f.execute(wire)).toMatchObject({ isError: true });
      expect(f.call).not.toHaveBeenCalled();
    } finally {
      query.close();
    }
  } finally {
    f.cleanup();
  }
});

it('composes published API tools through the current connection and canonical approval owners', async () => {
  const f = await selectedCodexToolsFixture();
  const { ApiToolCatalog } = await import('../api-tool-catalog.js');
  const { CredentialConnections, CredentialConnectionStore } =
    await import('../credential-connections.js');
  const { setCredentialConnectionsRuntime } = await import('../credential-connections-runtime.js');
  const { setSkillPolicy, clearSkillPolicy } = await import('@mitzo/harness');
  const store = new CredentialConnectionStore(':memory:');
  const catalog = new ApiToolCatalog(':memory:');
  const send = vi.fn(async () => ({
    status: 200,
    body: '{"entity_id":"sensor.office","state":"21","last_changed":"2026-10-17T00:00:00Z","attributes":{"private":"omit"}}',
  }));
  const vault = {
    save: vi.fn(async () => ({ service: 'fixture', account: 'fixture' })),
    link: vi.fn(),
    read: vi.fn(async () => 'offline-secret'),
    remove: vi.fn(),
  };
  const service = new CredentialConnections(store, vault, send);
  setCredentialConnectionsRuntime(service);
  try {
    const connection = await service.create(
      {
        label: 'Fixture',
        serviceTemplate: 'home-assistant',
        endpoint: 'https://ha.example.com',
        auth: { kind: 'bearer' },
        methods: ['GET'],
        paths: ['/api/'],
      },
      { secret: 'offline-secret' },
    );
    const draft = catalog.save(
      {
        id: '33333333-3333-4333-8333-333333333333',
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
    await catalog.verify(draft.id, draft.version, {
      service,
      signal: f.abort.signal,
      assertCurrent: () => {},
    });
    const entry = catalog.publish(draft.id, draft.version, service);
    f.publish([catalog.reference(entry), { id: 'mitzo:RequestConnectionAccess', version: 1 }]);
    send.mockClear();
    vault.read.mockClear();
    const query = await openCodexChat({ ...f.opts, apiTools: { catalog } });
    try {
      const tools = mocks.conversationOptions!.tools as { name: string }[];
      const wire = tools.find(
        (tool) => tool.name !== 'AskUserQuestion' && tool.name !== 'RequestConnectionAccess',
      )!.name;
      expect(tools).toHaveLength(3);
      expect(await f.execute(wire)).toEqual({
        content: '{"entity_id":"sensor.office","state":"21","last_changed":"2026-10-17T00:00:00Z"}',
        isError: false,
      });
      expect(mocks.permissionHandler).toHaveBeenCalledWith(
        'RequestConnectionAccess',
        expect.objectContaining({ connectionId: connection.id }),
        expect.objectContaining({ forcePrompt: true, rememberSessionGrant: false }),
      );
      expect(send).toHaveBeenCalledOnce();
      await expect(f.execute('ConnectionRequest')).rejects.toThrow(/not selected/);
      send.mockClear();
      vault.read.mockClear();
      setSkillPolicy(f.registry, 'selected-client', ['Read']);
      expect(await f.execute(wire)).toMatchObject({ isError: true });
      expect(send).not.toHaveBeenCalled();
      expect(vault.read).not.toHaveBeenCalled();
      clearSkillPolicy(f.registry, 'selected-client');
      service.revokeSession('selected-chat', connection.id);
      mocks.permissionHandler.mockImplementationOnce(async (_name, input) => {
        service.revokeSession('selected-chat', connection.id);
        return { behavior: 'allow', updatedInput: input };
      });
      expect(await f.execute(wire)).toMatchObject({ isError: true });
      expect(send).not.toHaveBeenCalled();
      expect(vault.read).not.toHaveBeenCalled();
    } finally {
      query.close();
    }
  } finally {
    setCredentialConnectionsRuntime(null);
    catalog.close();
    store.close();
    f.cleanup();
  }
});

it('closes both raw MCP peers when the shared Codex adapter loses its registered session', async () => {
  const f = await selectedCodexToolsFixture();
  const mcp = await import('../codex-mcp-tools.js');
  const actual = mcp.connectCodexMcpTools;
  let entered = 0;
  let enterBoth!: () => void;
  let release!: () => void;
  const bothEntered = new Promise<void>((resolve) => {
    enterBoth = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const peers = [0, 1].map(() => ({
    listTools: vi.fn(async () => {
      if (++entered === 2) enterBoth();
      await gate;
      return { tools: [] };
    }),
    callTool: vi.fn(),
    close: vi.fn(async () => {}),
  }));
  let nextPeer = 0;
  const connect = vi.fn(async () => peers[nextPeer++]);
  const connector = vi
    .spyOn(mcp, 'connectCodexMcpTools')
    .mockImplementation((configs, options) => actual(configs, { ...options, connect }));
  const published = vi.fn();
  // No published profile: exercise raw parallel MCP startup, rather than the
  // separate configured-reference admission path.
  const opening = openCodexChat({
    ...f.opts,
    mcpServers: {
      first: { command: 'offline-first', args: [] },
      second: { command: 'offline-second', args: [] },
    },
  }).then((query) => {
    published(query);
    return query;
  });
  try {
    await Promise.race([
      bothEntered,
      opening.then(() => {
        throw Error('Native startup published before held MCP discovery completed');
      }),
    ]);
    expect(connect).toHaveBeenCalledTimes(2);
    for (const peer of peers) expect(peer.listTools).toHaveBeenCalledOnce();
    // Exercise the shared adapter's real registered-session identity fence.
    // This fixture has no ownedLocal admission or account/operator authority.
    f.registry.register('selected-client', { ...f.opts.session });
    release();
    await expect(opening).rejects.toThrow('MCP initialization failed');
    expect(connect).toHaveBeenCalledTimes(2);
    for (const peer of peers) {
      expect(peer.close).toHaveBeenCalledOnce();
      expect(peer.callTool).not.toHaveBeenCalled();
    }
    expect(published).not.toHaveBeenCalled();
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledOnce();
  } finally {
    release();
    const query = await opening.catch(() => undefined);
    query?.close();
    connector.mockRestore();
    f.registry.dispose();
    f.cleanup();
  }
});

it('closes admitted MCP resources when later API admission fails', async () => {
  const f = await selectedCodexToolsFixture();
  const { setCredentialConnectionsRuntime } = await import('../credential-connections-runtime.js');
  setCredentialConnectionsRuntime({ catalog: () => [{ status: 'active' }] } as never);
  try {
    const entry = (await f.catalog.refresh(f.sourceOptions))[0];
    f.publish([
      f.catalog.reference(entry),
      {
        id: 'api:33333333-3333-4333-8333-333333333333',
        version: 1,
        revision: '44444444-4444-4444-8444-444444444444',
      },
      { id: 'mitzo:RequestConnectionAccess', version: 1 },
    ]);
    f.close.mockClear();
    await expect(
      openCodexChat({
        ...f.opts,
        apiTools: {
          catalog: {
            resolve: () => {
              throw Error('Receipt revoked');
            },
          } as never,
        },
      }),
    ).rejects.toThrow(/Receipt revoked/);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.call).not.toHaveBeenCalled();
  } finally {
    setCredentialConnectionsRuntime(null);
    f.cleanup();
  }
});

it.each(['hash', 'retained-selection'] as const)(
  'rejects a changed published %s before source acquisition',
  async (change) => {
    const f = await selectedCodexToolsFixture();
    try {
      const selected = structuredClone(f.publish([]));
      if (change === 'hash') selected.contentHash = 'f'.repeat(64);
      else selected.revision += 1;
      await expect(openCodexChat({ ...f.opts, agentProfile: selected })).rejects.toThrow(
        /hash mismatch|retained published profile/,
      );
      expect(f.connect).not.toHaveBeenCalled();
      expect(f.hooks).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  },
);
