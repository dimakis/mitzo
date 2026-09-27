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
