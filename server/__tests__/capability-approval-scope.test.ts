import { expect, it } from 'vitest';
import { SessionRegistry, resolvePending } from '@mitzo/harness';
import { capabilityApprovalForConversation } from '../connections/capabilities/approval.js';

it('reviews each capability operation without advertising or storing an integration grant', async () => {
  const registry = new SessionRegistry();
  const requests: Record<string, unknown>[] = [];
  const allowList = new Set<string>();
  registry.register('operator', {
    sessionId: 'conversation',
    transport: {
      send: (event) => {
        if (event.type === 'permission_request') requests.push(event);
      },
      isOpen: () => true,
    },
    abortController: new AbortController(),
    mode: 'agent',
    sessionAllowList: allowList,
  });
  const approve = capabilityApprovalForConversation(registry, 'conversation');
  try {
    for (const operationId of ['operation-1', 'operation-2']) {
      const pending = approve(
        {
          capabilityId: 'reviewed.write',
          capabilityVersion: 1,
          connectionId: 'connection',
          operationId,
          input: { title: 'Reviewed action' },
          forcePrompt: true,
        },
        new AbortController().signal,
      );
      await Promise.resolve();
      const request = requests.at(-1)!;
      expect(request.approvalScope).toBe('request');
      expect(resolvePending(request.permId as string, 'always', undefined, 'conversation')).toBe(
        true,
      );
      expect(await pending).toBe(true);
      expect(allowList.size).toBe(0);
    }
    expect(requests).toHaveLength(2);
  } finally {
    registry.dispose();
  }
});
