import { expect, it, vi } from 'vitest';
import { createCredentialSdkServer, credentialSdkPermission } from '../credential-sdk-tools.js';
import * as credentialRuntime from '../credential-connections-runtime.js';
import { SessionRegistry } from '@mitzo/harness';
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
it('exposes the same discovery, session approval and request tools to SDK sessions', async () => {
  const session = { abortController: new AbortController() };
  const registry = new SessionRegistry();
  registry.register('client', { ...session, sessionId: 'a', mode: 'agent' } as never);
  createCredentialSdkServer(() => 'a', registry.get('client')!, registry);
  expect(mocked.tools.map((t) => t.name)).toEqual([
    'ListConnections',
    'RequestConnectionAccess',
    'ConnectionRequest',
  ]);
  const result = await mocked.tools[0].handler({});
  expect(JSON.stringify(result)).toContain('connections');
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
