import { expect, it, vi } from 'vitest';
import { SessionRegistry, resolvePending } from '@mitzo/harness';
import { publicationControllerApproval } from '../symposium-publication-approval.js';
it('uses the real permission queue after builder removal and rejects a changed controller owner', async () => {
  const registry = new SessionRegistry();
  const send = vi.fn((value: Record<string, unknown>) => {
    if (value.type === 'permission_request') resolvePending(String(value.permId), 'once');
  });
  registry.register('controller:session', {
    sessionId: 'session',
    ownerConnectionId: 'controller',
    transport: { send, isOpen: () => true },
    abortController: new AbortController(),
    mode: 'agent',
    sessionAllowList: new Set(),
  });
  registry.register('builder', {
    sessionId: 'builder-session',
    transport: { send: vi.fn(), isOpen: () => true },
    abortController: new AbortController(),
    mode: 'agent',
    sessionAllowList: new Set(),
  });
  registry.abort('builder');
  let owner = true;
  const approval = publicationControllerApproval(
    registry,
    (connection, login) => owner && connection === 'controller' && login === 'login',
    'session',
    'login',
  );
  expect(approval).toBeDefined();
  expect(
    await approval!(
      {
        capabilityId: 'github.publish-pr',
        capabilityVersion: 1,
        connectionId: 'credential',
        operationId: 'operation',
        input: { title: 'Reviewed' },
        forcePrompt: true,
      },
      new AbortController().signal,
    ),
  ).toBe(true);
  expect(send).toHaveBeenCalled();
  expect(registry.findBySessionId('session')?.clientId).toBe('controller:session');
  owner = false;
  await expect(
    approval!(
      {
        capabilityId: 'github.publish-pr',
        capabilityVersion: 1,
        connectionId: 'credential',
        operationId: 'operation-2',
        input: {},
        forcePrompt: true,
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow('controller');
  registry.dispose();
});
it('cancels a lost approval watch without aborting or deleting an existing session', async () => {
  const { ConnectionRegistry } = await import('@mitzo/harness');
  const connections = new ConnectionRegistry(),
    registry = new SessionRegistry();
  const send = vi.fn();
  const transport = { send, isOpen: () => true };
  connections.register('browser', transport);
  connections.watch('browser', 'session');
  const model = new AbortController();
  registry.register('existing', {
    sessionId: 'session',
    ownerConnectionId: 'browser',
    transport,
    abortController: model,
    mode: 'agent',
    sessionAllowList: new Set(),
  });
  const approve = publicationControllerApproval(
    registry,
    () => true,
    'session',
    'login',
    undefined,
    connections,
  )!;
  const pending = approve(
    {
      capabilityId: 'github.publish-pr',
      capabilityVersion: 1,
      connectionId: 'write',
      operationId: 'op',
      input: {},
      forcePrompt: true,
    },
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(send).toHaveBeenCalled());
  connections.unwatch('browser', 'session');
  await expect(pending).rejects.toThrow();
  expect(model.signal.aborted).toBe(false);
  expect(registry.get('existing')).toBeDefined();
  registry.dispose();
  connections.dispose();
});
