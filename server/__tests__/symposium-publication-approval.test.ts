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

it('retains scoped controller consent across ephemeral runtimes and authenticated devices until cleared', async () => {
  const { ConnectionRegistry } = await import('@mitzo/harness');
  const { clearPublicationControllerSessionGrants } =
    await import('../symposium-publication-approval.js');
  const registry = new SessionRegistry();
  const connections = new ConnectionRegistry();
  const send = vi.fn((event: Record<string, unknown>) => {
    if (event.type === 'permission_request') resolvePending(String(event.permId), 'always');
  });
  for (const name of ['phone', 'web']) {
    connections.register(name, { send, isOpen: () => true });
    connections.watch(name, 'logical-conversation');
  }
  const owned = (connection: string, login: string) => `${connection}-login` === login;
  const request = {
    capabilityId: 'github.publish-pr',
    capabilityVersion: 1,
    connectionId: 'credential',
    connectionRevision: 1,
    input: { title: 'Reviewed' },
    forcePrompt: true as const,
  };
  const approve = (device: string) =>
    publicationControllerApproval(
      registry,
      owned,
      'logical-conversation',
      `${device}-login`,
      device,
      connections,
    )!;
  const run = async (device: string, operation: string, revision = 1) =>
    approve(device)(
      { ...request, operationId: operation, connectionRevision: revision },
      new AbortController().signal,
    );
  try {
    expect(await run('phone', 'first')).toBe(true);
    expect(registry.findBySessionId('logical-conversation')).toBeNull();
    expect(await run('web', 'second')).toBe(true);
    expect(send.mock.calls.filter(([event]) => event.type === 'permission_request')).toHaveLength(
      1,
    );
    expect(await run('web', 'changed-policy', 2)).toBe(true);
    expect(send.mock.calls.filter(([event]) => event.type === 'permission_request')).toHaveLength(
      2,
    );
    const other = { ...request, connectionId: 'other-credential', operationId: 'other-first' };
    expect(await approve('web')(other, new AbortController().signal)).toBe(true);
    expect(send.mock.calls.filter(([event]) => event.type === 'permission_request')).toHaveLength(
      3,
    );
    clearPublicationControllerSessionGrants(registry, 'logical-conversation', 'credential');
    expect(await run('phone', 'after-clear')).toBe(true);
    expect(send.mock.calls.filter(([event]) => event.type === 'permission_request')).toHaveLength(
      4,
    );
    expect(
      await approve('web')(
        { ...other, operationId: 'other-retained' },
        new AbortController().signal,
      ),
    ).toBe(true);
    expect(send.mock.calls.filter(([event]) => event.type === 'permission_request')).toHaveLength(
      4,
    );
    connections.unwatch('phone', 'logical-conversation');
    expect(approve('phone')).toBeUndefined();
    expect(
      publicationControllerApproval(
        registry,
        () => false,
        'logical-conversation',
        'web-login',
        'web',
        connections,
      ),
    ).toBeUndefined();
  } finally {
    registry.dispose();
    connections.dispose();
  }
});

it('does not repopulate controller retention when its connection is revoked during approval', async () => {
  const { ConnectionRegistry } = await import('@mitzo/harness');
  const { clearPublicationControllerSessionGrants } =
    await import('../symposium-publication-approval.js');
  const registry = new SessionRegistry();
  const connections = new ConnectionRegistry();
  const requests: Record<string, unknown>[] = [];
  connections.register('browser', {
    send: (event) => {
      if (event.type === 'permission_request') requests.push(event);
    },
    isOpen: () => true,
  });
  connections.watch('browser', 'revoked-conversation');
  const approve = () =>
    publicationControllerApproval(
      registry,
      () => true,
      'revoked-conversation',
      'login',
      'browser',
      connections,
    )!;
  const action = {
    capabilityId: 'github.publish-pr',
    capabilityVersion: 1,
    connectionId: 'credential',
    connectionRevision: 1,
    input: {},
    forcePrompt: true as const,
  };
  try {
    const pending = approve()(
      { ...action, operationId: 'before-revoke' },
      new AbortController().signal,
    );
    const settled = expect(pending).rejects.toThrow('consent changed');
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    clearPublicationControllerSessionGrants(registry, 'revoked-conversation', 'credential');
    resolvePending(requests[0].permId as string, 'always');
    await settled;
    const retry = approve()(
      { ...action, operationId: 'after-revoke' },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    resolvePending(requests[1].permId as string, 'once');
    expect(await retry).toBe(true);
  } finally {
    registry.dispose();
    connections.dispose();
  }
});
