import { expect, it, vi } from 'vitest';
import { sessionCredentialTools } from '../session-credential-tools.js';
import { SessionRegistry } from '@mitzo/harness';
it('combines managed providers with Keychain discovery and reuses managed session approval', async () => {
  const request = vi.fn(async () => ({ content: 'approved', isError: false }));
  const registry = new SessionRegistry();
  registry.register('client', {
    sessionId: 'session',
    mode: 'agent',
    abortController: new AbortController(),
  } as never);
  const session = registry.get('client')!;
  const tools = sessionCredentialTools('session', session, registry, '', {
    providers: () => [
      {
        id: 'openshell:github',
        label: 'GitHub',
        endpoint: 'https://api.github.com',
        provider: 'github',
        transport: 'openshell',
        access: 'approval_required',
      },
    ],
    request,
  });
  const listed = await tools.execute('ListConnections', {}, new AbortController().signal);
  expect(listed?.content).toContain('GitHub');
  await tools.execute(
    'RequestConnectionAccess',
    { connectionId: 'openshell:github' },
    new AbortController().signal,
  );
  expect(request).toHaveBeenCalledWith('github', expect.any(AbortSignal));
});

function setup() {
  const registry = new SessionRegistry();
  registry.register('client', {
    sessionId: 'session',
    mode: 'agent',
    abortController: new AbortController(),
  } as never);
  const session = registry.get('client')!;
  const providers = vi.fn(() => [
    {
      id: 'openshell:github',
      label: 'GitHub',
      provider: 'github',
      transport: 'openshell',
      access: 'approval_required',
    },
  ]);
  const request = vi.fn(async () => ({ content: 'approved', isError: false }));
  const tools = sessionCredentialTools('session', session, registry, '', { providers, request });
  return { registry, session, providers, request, tools };
}
it('validates current ownership, session cancellation and skill policy before discovery or managed dispatch', async () => {
  for (const change of ['owner', 'cancel', 'skill']) {
    const { registry, session, providers, request, tools } = setup();
    if (change === 'owner')
      registry.register('client', {
        sessionId: 'session',
        abortController: new AbortController(),
      } as never);
    if (change === 'cancel') session.abortController.abort();
    if (change === 'skill') session.activeSkillPolicy = new Set(['Bash']);
    for (const [name, input] of [
      ['ListConnections', {}],
      ['RequestConnectionAccess', { connectionId: 'openshell:github' }],
    ] as const) {
      expect((await tools.execute(name, input, new AbortController().signal))?.isError).toBe(true);
    }
    expect(providers).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  }
});
it('returns a cancellation result and stops delegated access when the owning session cancels', async () => {
  const { session, request, tools } = setup();
  request.mockImplementationOnce(async (_provider?: string, signal?: AbortSignal) => {
    session.abortController.abort();
    expect(signal?.aborted).toBe(true);
    return { content: 'approved', isError: false };
  });
  const result = await tools.execute(
    'RequestConnectionAccess',
    { connectionId: 'openshell:github' },
    new AbortController().signal,
  );
  expect(result?.isError).toBe(true);
  const cancelled = new AbortController();
  cancelled.abort();
  expect((await tools.execute('ListConnections', {}, cancelled.signal))?.isError).toBe(true);
});
it('rechecks policy when managed approval completes and blocks Ask writes before provider discovery', async () => {
  const { session, request, providers, tools } = setup();
  request.mockImplementationOnce(async () => {
    session.activeSkillPolicy = new Set(['ListConnections']);
    return { content: 'approved', isError: false };
  });
  expect(
    (
      await tools.execute(
        'RequestConnectionAccess',
        { connectionId: 'openshell:github' },
        new AbortController().signal,
      )
    )?.isError,
  ).toBe(true);
  session.activeSkillPolicy = null;
  session.pendingPermissionModes = new Map([[Symbol(), 'ask']]);
  providers.mockClear();
  expect(
    (
      await tools.execute(
        'ConnectionRequest',
        { connectionId: 'openshell:github', path: '/', method: 'POST' },
        new AbortController().signal,
      )
    )?.isError,
  ).toBe(true);
  expect(providers).not.toHaveBeenCalled();
});

it('uses prefixed skill restrictions and keeps access scoped to session despite model changes', async () => {
  const { session, registry, providers, request } = setup();
  const tools = sessionCredentialTools('session', session, registry, 'mcp__mitzo-connections__', {
    providers,
    request,
  });
  session.activeSkillPolicy = new Set(['ListConnections']);
  expect((await tools.execute('ListConnections', {}, new AbortController().signal))?.isError).toBe(
    true,
  );
  session.activeSkillPolicy = new Set([
    'mcp__mitzo-connections__ListConnections',
    'mcp__mitzo-connections__RequestConnectionAccess',
  ]);
  session.model = 'test-model-a';
  expect((await tools.execute('ListConnections', {}, new AbortController().signal))?.isError).toBe(
    false,
  );
  session.model = 'test-model-b';
  expect(
    (
      await tools.execute(
        'RequestConnectionAccess',
        { connectionId: 'openshell:github' },
        new AbortController().signal,
      )
    )?.isError,
  ).toBe(false);
});
