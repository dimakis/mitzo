import { expect, it, vi } from 'vitest';
import { createCredentialSdkServer, credentialSdkPermission } from '../credential-sdk-tools.js';
import * as credentialRuntime from '../credential-connections-runtime.js';
import * as credentialTools from '../session-credential-tools.js';
import * as launchTools from '../session-launch-tools.js';
import { SessionRegistry, ToolGuardTimeoutError, type ToolGuardPolicy } from '@mitzo/harness';
import { TurnCallbacks, assertTurnCallbackEffects } from '../turn-callbacks.js';
import { AgentCommunicationError } from '../agent-message-runtime.js';
const mocked = vi.hoisted(() => ({
  tools: [] as Array<{
    name: string;
    handler: (input: Record<string, unknown>, extra?: unknown) => Promise<unknown>;
  }>,
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (
    name: string,
    _description: string,
    _schema: unknown,
    handler: (input: Record<string, unknown>, extra?: unknown) => Promise<unknown>,
  ) => ({ name, handler }),
  createSdkMcpServer: ({ tools }: { tools: typeof mocked.tools }) => {
    mocked.tools = tools;
    return { type: 'sdk', name: 'mitzo-connections' };
  },
}));
it('routes Telos proposals through the owned callback and refuses retired query execution', async () => {
  const registry = new SessionRegistry();
  registry.register('owned', {
    sessionId: 'sdk-owned',
    mode: 'agent',
    abortController: new AbortController(),
  } as never);
  let retired = false;
  let insideCallback = false;
  const execute = vi.fn(async () => {
    expect(insideCallback).toBe(true);
    return { state: 'pending', childSessionId: null };
  });
  const adapter = vi.spyOn(launchTools, 'sessionLaunchTools').mockReturnValue({ execute } as never);
  const assertCurrent = () => {
    if (retired) throw Error('query retired');
  };
  try {
    createCredentialSdkServer(() => 'sdk-owned', registry.get('owned')!, registry, {
      profilesOnly: true,
      assertCurrent: async () => assertCurrent(),
      assertCurrentSync: assertCurrent,
      runCallback: async (work) => {
        insideCallback = true;
        try {
          return await work();
        } finally {
          insideCallback = false;
        }
      },
    });
    const tool = mocked.tools.find((item) => item.name === 'TelosCreateSession')!;
    expect(tool).toBeDefined();
    const input = {
      requestId: '54adcba3-65b2-4e60-98bc-226117e90fc2',
      itemId: 'slice',
      expectedRevision: 'a'.repeat(64),
      title: 'Slice',
      prompt: 'Do the selected work',
    };
    expect(await tool.handler(input, { requestId: 'sdk-call' })).toMatchObject({ isError: false });
    expect(execute).toHaveBeenCalledWith(
      input,
      expect.any(AbortSignal),
      { turnId: expect.any(String), callId: 'sdk-call' },
      'TelosCreateSession',
    );
    expect(adapter).toHaveBeenCalledWith(
      expect.objectContaining({ permissionPrefix: 'mcp__mitzo-connections__' }),
    );
    retired = true;
    await expect(tool.handler(input)).rejects.toThrow('query retired');
    expect(execute).toHaveBeenCalledOnce();
  } finally {
    adapter.mockRestore();
    registry.dispose();
  }
});

it('exposes peer messaging only through an explicitly installed owned SDK callback and retains capability diagnostics', async () => {
  const registry = new SessionRegistry();
  registry.register('owned', {
    sessionId: 'sdk-owned',
    mode: 'agent',
    transport: { send() {}, isOpen: () => true },
    abortController: new AbortController(),
  } as never);
  let current = true;
  const execute = vi.fn(async () => {
    throw new AgentCommunicationError(
      'runtime_unsupported',
      'capability',
      'The target has no verified peer adapter.',
    );
  });
  const assert = () => {
    if (!current) throw Error('revoked');
  };
  try {
    createCredentialSdkServer(() => 'sdk-owned', registry.get('owned')!, registry, {
      profilesOnly: true,
      assertCurrent: async () => assert(),
      assertCurrentSync: assert,
      agentCommunication: () => ({ execute }),
    });
    const tool = mocked.tools.find((item) => item.name === 'AgentCommunication');
    expect(tool).toBeDefined();
    const result = await tool!.handler({ operation: 'list' });
    expect(JSON.stringify(result)).toContain('runtime_unsupported');
    expect(execute).toHaveBeenCalledOnce();
    current = false;
    await expect(tool!.handler({ operation: 'list' })).rejects.toThrow('revoked');
    expect(execute).toHaveBeenCalledOnce();
  } finally {
    registry.dispose();
  }
});
it('propagates SDK peer authority revocation after execution instead of reporting a recoverable tool result', async () => {
  const registry = new SessionRegistry();
  registry.register('owned', {
    sessionId: 'sdk-owned',
    mode: 'agent',
    transport: { send() {}, isOpen: () => true },
    abortController: new AbortController(),
  } as never);
  let current = true;
  const execute = vi.fn(async () => {
    current = false;
    return { chats: [], nextOffset: null };
  });
  const assert = () => {
    if (!current) throw Error('revoked after execution');
  };
  try {
    createCredentialSdkServer(() => 'sdk-owned', registry.get('owned')!, registry, {
      profilesOnly: true,
      assertCurrent: async () => assert(),
      assertCurrentSync: assert,
      agentCommunication: () => ({ execute }),
    });
    const tool = mocked.tools.find((item) => item.name === 'AgentCommunication');
    await expect(tool!.handler({ operation: 'list' })).rejects.toThrow('revoked after execution');
    expect(execute).toHaveBeenCalledOnce();
  } finally {
    registry.dispose();
  }
});
it('exposes the same discovery, session approval and request tools to SDK sessions', async () => {
  const session = { abortController: new AbortController() };
  const registry = new SessionRegistry();
  registry.register('client', { ...session, sessionId: 'a', mode: 'agent' } as never);
  createCredentialSdkServer(() => 'a', registry.get('client')!, registry);
  expect(mocked.tools.map((t) => t.name)).toEqual([
    'ListConnections',
    'RequestConnectionAccess',
    'ConnectionRequest',
    'ConnectionWebSocket',
    'HomeAssistantDashboard',
    'GetConnectionGuide',
    'PrepareConnectionSetup',
    'GetConnectionSetup',
    'PrepareSecretRelay',
    'GetSecretRelay',
    'ApplySecretRelay',
    'ListRepositories',
    'PrepareRepositoryChat',
    'GetRepositoryChatPreparation',
    'SymposiumProposeProfile',
    'SymposiumReadProfiles',
    'ReadKnowledge',
    'SaveKnowledgeDraft',
    'CaptureMemoryCandidate',
    'TaskExecution',
    'SchedulePrompt',
    'SessionTimers',
    'SendSessionMessage',
  ]);
  const result = await mocked.tools[0].handler({});
  expect(JSON.stringify(result)).toContain('connections');
});

it('delivers SDK callback failures as actionable tool results and permits the next call', async () => {
  const registry = new SessionRegistry();
  registry.register('client', {
    sessionId: 'chat',
    mode: 'agent',
    abortController: new AbortController(),
  } as never);
  const tools = vi.spyOn(credentialTools, 'sessionCredentialTools').mockReturnValue({
    definitions: [],
    execute: vi
      .fn()
      .mockRejectedValueOnce(Object.assign(Error('private payload'), { code: 'ENOMEM' }))
      .mockResolvedValue({ content: 'next observation', isError: false }),
  });
  createCredentialSdkServer(() => 'chat', registry.get('client')!, registry, {
    assertCurrent: async () => {},
    assertCurrentSync: () => {},
  });
  try {
    const handler = mocked.tools.find((tool) => tool.name === 'ListConnections')!.handler;
    const failed = await handler({});
    expect(failed).toMatchObject({ isError: true });
    expect(JSON.stringify(failed)).toContain('memory_exhausted');
    expect(JSON.stringify(failed)).not.toContain('private payload');
    expect(await handler({})).toMatchObject({ isError: false });
  } finally {
    tools.mockRestore();
    registry.dispose();
  }
});

function callbackSdkFixture(toolGuardPolicy?: Readonly<ToolGuardPolicy>) {
  const effect = vi.fn(async () => '{"ok":true}');
  const send = async (...args: unknown[]) => {
    await (args[5] as () => Promise<void>)();
    return effect();
  };
  const service = {
    catalog: () => [{ id: 'ha', access: 'approved' }],
    connection: () => ({
      id: 'ha',
      revision: 1,
      endpoint: 'https://ha.example.com',
      paths: ['/api/'],
      methods: ['GET', 'POST'],
      auth: { kind: 'bearer' },
      serviceTemplate: 'home-assistant',
      homeAssistantDashboards: 'read-write',
      websocket: { path: '/api/websocket', authentication: { kind: 'headers' } },
    }),
    websocketRequest: vi.fn(send),
    dashboardRequest: vi.fn(send),
    setups: { prepare: vi.fn(() => ({ id: 'setup', status: 'pending' })) },
    relay: { prepare: vi.fn(() => ({ id: 'relay', status: 'pending' })) },
  };
  const runtime = vi
    .spyOn(credentialRuntime, 'getCredentialConnectionsRuntime')
    .mockReturnValue(service as never);
  const registry = new SessionRegistry();
  registry.register('client', {
    sessionId: 'chat',
    mode: 'agent',
    abortController: new AbortController(),
  } as never);
  const session = registry.get('client')!;
  const callbacks = new TurnCallbacks();
  const assert = (signal: AbortSignal) => {
    signal.throwIfAborted();
    assertTurnCallbackEffects();
  };
  createCredentialSdkServer(() => 'chat', session, registry, {
    toolGuardPolicy,
    connectionBoundary: 'sdk-callback',
    runCallback: (work) => callbacks.track(work),
    assertCurrent: async (signal) => {
      assert(signal);
    },
    assertCurrentSync: assert,
  });
  return {
    service,
    effect,
    callbacks,
    session,
    call: (name: string, input: Record<string, unknown>) =>
      mocked.tools
        .find((tool) => tool.name === name)!
        .handler(input, { signal: session.abortController.signal }),
    close: () => {
      runtime.mockRestore();
      registry.dispose();
    },
  };
}

const callbackConnectionCases = [
  { name: 'ConnectionWebSocket', input: { connectionId: 'ha', message: '{}' } },
  { name: 'HomeAssistantDashboard', input: { connectionId: 'ha', operation: 'read' } },
  {
    name: 'PrepareConnectionSetup',
    input: { profile: 'home-assistant', endpoint: 'https://ha.example.com' },
  },
  {
    name: 'PrepareSecretRelay',
    input: {
      label: 'Private setup',
      targets: [
        {
          connectionId: 'ha',
          revision: 1,
          path: '/api/notify',
          method: 'POST',
          encoding: 'json',
          body: '{}',
          fields: ['token'],
        },
      ],
    },
  },
] satisfies Array<{ name: string; input: Record<string, unknown> }>;

it('bounds a stuck SDK tool and prevents its late effect after the deadline', async () => {
  const f = callbackSdkFixture({ executionMs: 20, approvalMs: 100, cleanupMs: 20 });
  let release!: () => void;
  f.service.websocketRequest.mockImplementationOnce(async (...args: unknown[]) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await (args[5] as () => Promise<void>)();
    return f.effect();
  });
  try {
    await expect(
      f.call('ConnectionWebSocket', { connectionId: 'ha', message: '{}' }),
    ).rejects.toBeInstanceOf(ToolGuardTimeoutError);
    expect(
      await f.call('ConnectionWebSocket', { connectionId: 'ha', message: '{}' }),
    ).toMatchObject({ isError: true });
    expect(f.service.websocketRequest).toHaveBeenCalledOnce();
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.effect).not.toHaveBeenCalled();
    await expect(f.callbacks.settle(new AbortController().signal)).rejects.toMatchObject({
      code: 'callbacks_failed',
    });
  } finally {
    release?.();
    f.close();
  }
});

it.each(callbackConnectionCases)(
  'retains legacy $name through the registered callback-fenced SDK handler',
  async ({ name, input }) => {
    const f = callbackSdkFixture();
    try {
      expect(f.session.ordinaryRuntimeOwner).toBeUndefined();
      expect(await f.call(name, input)).toMatchObject({ isError: false });
      const invoked =
        name === 'ConnectionWebSocket'
          ? f.service.websocketRequest
          : name === 'HomeAssistantDashboard'
            ? f.service.dashboardRequest
            : name === 'PrepareConnectionSetup'
              ? f.service.setups.prepare
              : f.service.relay.prepare;
      expect(invoked).toHaveBeenCalledOnce();
    } finally {
      f.close();
    }
  },
);

it('still fences a pending SDK frame when its original callback turn completes', async () => {
  const f = callbackSdkFixture();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.service.websocketRequest.mockImplementationOnce(async (...args: unknown[]) => {
    await barrier;
    await (args[5] as () => Promise<void>)();
    return f.effect();
  });
  try {
    const pending = f
      .call('ConnectionWebSocket', { connectionId: 'ha', message: '{}' })
      .catch((error) => error);
    await vi.waitFor(() => expect(f.service.websocketRequest).toHaveBeenCalledOnce());
    f.callbacks.seal();
    release();
    expect(await pending).toMatchObject({ code: 'turn_completed' });
    expect(f.effect).not.toHaveBeenCalled();
  } finally {
    release();
    f.close();
  }
});
it('enforces Ask mode and schema validation before the SDK dispatches requests', () => {
  const registry = new SessionRegistry();
  const session = {
    mode: 'ask',
    abortController: new AbortController(),
  } as import('@mitzo/harness').ManagedSession;
  registry.register('client', session as never);
  const currentSession = registry.get('client')!;
  expect(
    credentialSdkPermission(
      'mcp__mitzo-connections__ConnectionRequest',
      { connectionId: 'ha', path: '/api/', method: 'POST' },
      'client',
      registry,
      currentSession,
    )?.behavior,
  ).toBe('deny');
  expect(
    credentialSdkPermission(
      'mcp__mitzo-connections__ConnectionRequest',
      { connectionId: 'ha', path: '/api/', method: 'GET' },
      'client',
      registry,
      currentSession,
    )?.behavior,
  ).toBe('allow');
  expect(
    credentialSdkPermission(
      'mcp__mitzo-connections__ListConnections',
      { secret: 'bad' },
      'client',
      registry,
      currentSession,
    )?.behavior,
  ).toBe('deny');
  expect(credentialSdkPermission('Bash', {}, 'client', registry, session)).toBeUndefined();
});

it('enforces ownership, cancellation, skill ceilings and pending Ask transitions in SDK permission checks', () => {
  for (const change of ['owner', 'cancel', 'skill', 'pending']) {
    const registry = new SessionRegistry();
    registry.register('client', {
      sessionId: 'a',
      mode: 'agent',
      abortController: new AbortController(),
    } as never);
    const session = registry.get('client')!;
    if (change === 'owner')
      registry.register('client', {
        sessionId: 'a',
        abortController: new AbortController(),
      } as never);
    if (change === 'cancel') session.abortController.abort();
    if (change === 'skill') session.activeSkillPolicy = new Set(['Bash']);
    if (change === 'pending') session.pendingPermissionModes = new Map([[Symbol(), 'ask']]);
    expect(
      credentialSdkPermission(
        'mcp__mitzo-connections__ConnectionRequest',
        {
          connectionId: 'ha',
          path: '/api/',
          method: 'POST',
        },
        'client',
        registry,
        session,
      )?.behavior,
    ).toBe('deny');
    if (change !== 'pending')
      expect(
        credentialSdkPermission(
          'mcp__mitzo-connections__ListConnections',
          {},
          'client',
          registry,
          session,
        )?.behavior,
      ).toBe('deny');
  }
});
it('SDK discovery fails closed after the original session loses ownership', async () => {
  const registry = new SessionRegistry();
  registry.register('client', {
    sessionId: 'a',
    mode: 'agent',
    abortController: new AbortController(),
  } as never);
  const session = registry.get('client')!;
  createCredentialSdkServer(() => 'a', session, registry);
  registry.register('client', {
    sessionId: 'a',
    mode: 'agent',
    abortController: new AbortController(),
  } as never);
  const result = await mocked.tools[0].handler({});
  expect(result).toMatchObject({ isError: true });
});

it('does not dispatch SDK discovery or access requests when the per-call signal is aborted', async () => {
  const catalog = vi.fn(() => []);
  const connection = vi.fn();
  const runtime = vi
    .spyOn(credentialRuntime, 'getCredentialConnectionsRuntime')
    .mockReturnValue({ catalog, connection } as never);
  try {
    const registry = new SessionRegistry();
    registry.register('client', {
      sessionId: 'a',
      mode: 'agent',
      abortController: new AbortController(),
    } as never);
    const session = registry.get('client')!;
    createCredentialSdkServer(() => 'a', session, registry);
    const call = new AbortController();
    call.abort();
    expect(await mocked.tools[0].handler({}, { signal: call.signal })).toMatchObject({
      isError: true,
    });
    expect(
      await mocked.tools[1].handler({ connectionId: 'ha' }, { signal: call.signal }),
    ).toMatchObject({ isError: true });
    expect(session.abortController.signal.aborted).toBe(false);
    expect(catalog).not.toHaveBeenCalled();
    expect(connection).not.toHaveBeenCalled();
  } finally {
    runtime.mockRestore();
  }
});

it('blocks dashboard saves in Ask mode while allowing dashboard reads', () => {
  const registry = new SessionRegistry();
  registry.register('client', { mode: 'ask', abortController: new AbortController() } as never);
  const session = registry.get('client')!;
  for (const operation of ['list', 'read', 'save']) {
    const result = credentialSdkPermission(
      'mcp__mitzo-connections__HomeAssistantDashboard',
      {
        connectionId: 'ha',
        operation,
        ...(operation === 'save' ? { config: '{}', expectedConfigHash: 'a'.repeat(64) } : {}),
      },
      'client',
      registry,
      session,
    );
    expect(result?.behavior).toBe(operation === 'save' ? 'deny' : 'allow');
  }
});

it('treats generic WebSocket messages as writes even when the agent labels their contents as reads', () => {
  const registry = new SessionRegistry();
  registry.register('client', { mode: 'ask', abortController: new AbortController() } as never);
  const session = registry.get('client')!;
  const input = { connectionId: 'service', message: '{"operation":"read"}' };
  expect(
    credentialSdkPermission(
      'mcp__mitzo-connections__ConnectionWebSocket',
      input,
      'client',
      registry,
      session,
    )?.behavior,
  ).toBe('deny');
  session.mode = 'agent';
  expect(
    credentialSdkPermission(
      'mcp__mitzo-connections__ConnectionWebSocket',
      input,
      'client',
      registry,
      session,
    )?.behavior,
  ).toBe('allow');
});

it('registers repository preparation with the shared prefixed permission boundary', () => {
  const registry = new SessionRegistry();
  registry.register('client', {
    sessionId: 'origin',
    mode: 'agent',
    abortController: new AbortController(),
  } as never);
  const session = registry.get('client')!;
  expect(
    credentialSdkPermission(
      'mcp__mitzo-connections__PrepareRepositoryChat',
      { repository: 'example/repo', prompt: 'Fix parser' },
      'client',
      registry,
      session,
    )?.behavior,
  ).toBe('allow');
  expect(
    credentialSdkPermission(
      'mcp__mitzo-connections__PrepareRepositoryChat',
      { repository: 'example/repo', prompt: 'Fix parser', accountId: 'other' },
      'client',
      registry,
      session,
    )?.behavior,
  ).toBe('deny');
  session.mode = 'ask';
  expect(
    credentialSdkPermission(
      'mcp__mitzo-connections__PrepareRepositoryChat',
      { repository: 'example/repo', prompt: 'Fix parser' },
      'client',
      registry,
      session,
    )?.behavior,
  ).toBe('deny');
  expect(
    credentialSdkPermission(
      'mcp__mitzo-connections__GetRepositoryChatPreparation',
      {},
      'client',
      registry,
      session,
    )?.behavior,
  ).toBe('allow');
});

it('SDK profile calls create one durable proposal per verified request and retain their permission ceiling', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { SymposiumProfileProposalStore } = await import('../symposium-profile-proposals.js');
  const root = mkdtempSync(join(tmpdir(), 'profile-sdk-'));
  vi.stubEnv('REPO_PATH', root);
  const registry = new SessionRegistry();
  registry.register('client', {
    sessionId: 'chat',
    mode: 'agent',
    abortController: new AbortController(),
  } as never);
  const session = registry.get('client')!;
  const input = {
    definition: {
      name: 'Trace',
      role: 'agent',
      instructions: 'Diagnose',
      expectedOutput: 'Diagnosis',
      acceptanceCriteria: ['Evidence'],
      modelPolicyRole: 'agent',
    },
  };
  try {
    createCredentialSdkServer(() => 'chat', session, registry);
    const handler = mocked.tools.find((t) => t.name === 'SymposiumProposeProfile')!.handler;
    expect(
      credentialSdkPermission(
        'mcp__mitzo-connections__SymposiumProposeProfile',
        input,
        'client',
        registry,
        session,
      )?.behavior,
    ).toBe('allow');
    const first = await handler(input, { requestId: 4 });
    expect(await handler(input, { requestId: 4 })).toEqual(first);
    const store = new SymposiumProfileProposalStore(join(root, '.mitzo', 'events.db'));
    try {
      expect(store.listPending('user', 'chat')).toHaveLength(1);
    } finally {
      store.close();
    }
    session.activeSkillPolicy = new Set(['Read']);
    expect(
      credentialSdkPermission(
        'mcp__mitzo-connections__SymposiumProposeProfile',
        input,
        'client',
        registry,
        session,
      )?.behavior,
    ).toBe('deny');
    expect(JSON.stringify(await handler(input, { requestId: 5 }))).toContain('"isError":true');
  } finally {
    registry.dispose();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
