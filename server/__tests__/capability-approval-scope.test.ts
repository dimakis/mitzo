import { expect, it } from 'vitest';
import { SessionRegistry, resolvePending } from '@mitzo/harness';
import { capabilityApprovalForConversation } from '../connections/capabilities/approval.js';

it('retains only the approved capability class, connection and policy revision for the session', async () => {
  const registry = new SessionRegistry();
  const requests: Record<string, unknown>[] = [];
  const allowList = new Set<string>(['ExecuteProviderCapability']);
  const abort = new AbortController();
  registry.register('operator', {
    sessionId: 'conversation',
    transport: {
      send: (event) => {
        if (event.type === 'permission_request') requests.push(event);
      },
      isOpen: () => true,
    },
    abortController: abort,
    mode: 'agent',
    sessionAllowList: allowList,
  });
  const approve = capabilityApprovalForConversation(registry, 'conversation');
  const request = {
    capabilityId: 'reviewed.write',
    capabilityVersion: 1,
    connectionId: 'connection',
    connectionRevision: 1,
    input: { title: 'Reviewed action' },
    forcePrompt: true as const,
  };
  try {
    const first = approve({ ...request, operationId: 'operation-1' }, abort.signal);
    await Promise.resolve();
    expect(requests[0].approvalScope).toBe('session');
    expect(requests[0].sessionGrantDescription).toContain('this connection');
    expect(resolvePending(requests[0].permId as string, 'always', undefined, 'conversation')).toBe(
      true,
    );
    expect(await first).toBe(true);
    expect(
      await approve(
        { ...request, operationId: 'operation-2', input: { title: 'Current new action' } },
        abort.signal,
      ),
    ).toBe(true);
    expect(requests).toHaveLength(1);
    for (const [index, changed] of [
      { connectionId: 'different' },
      { connectionRevision: 2 },
      { capabilityId: 'reviewed.other' },
      { capabilityVersion: 2 },
    ].entries()) {
      const execution = approve(
        { ...request, ...changed, operationId: `scope-${index}` },
        abort.signal,
      );
      await Promise.resolve();
      expect(requests).toHaveLength(index + 2);
      expect(
        resolvePending(requests.at(-1)!.permId as string, 'once', undefined, 'conversation'),
      ).toBe(true);
      expect(await execution).toBe(true);
    }
    registry.setMode('operator', 'ask');
    expect(await approve({ ...request, operationId: 'downgraded' }, abort.signal)).toBe(false);
  } finally {
    abort.abort();
    registry.dispose();
  }
});
