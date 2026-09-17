import { randomUUID } from 'node:crypto';
import { buildPermissionHandler, type SessionRegistry } from '@mitzo/harness';
import type { CapabilityApproval } from './types.js';

export const EXECUTE_CAPABILITY_TOOL = 'ExecuteProviderCapability';

export function capabilityApprovalPayload(request: Parameters<CapabilityApproval>[0]) {
  return {
    input: request.input,
    capabilityId: request.capabilityId,
    capabilityVersion: request.capabilityVersion,
    connectionId: request.connectionId,
    operationId: request.operationId,
  };
}

/**
 * Capability mutations deliberately use Mitzo's existing permission queue. A
 * model, browser, or reconnect cannot convert a prior tool permission into a
 * grant: each operation passes forcePrompt and is tied to one conversation.
 */
export function capabilityApprovalForConversation(
  registry: SessionRegistry,
  conversationId: string,
): CapabilityApproval {
  return async (request, signal) => {
    const owner = registry.findBySessionId(conversationId);
    if (!owner) return false;
    const decision = await buildPermissionHandler(owner.clientId, registry)(
      EXECUTE_CAPABILITY_TOOL,
      capabilityApprovalPayload(request),
      {
        signal,
        toolUseID: randomUUID(),
        forcePrompt: request.forcePrompt,
        approvalScope: 'conversation',
        title: 'Approve provider capability?',
        description:
          'This performs the reviewed provider operation shown below. Mitzo will record the result and verify it before reporting success.',
      },
    );
    return decision.behavior === 'allow';
  };
}
