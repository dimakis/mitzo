import { createHash, randomUUID } from 'node:crypto';
import { buildPermissionHandler, type SessionRegistry } from '@mitzo/harness';
import type { CapabilityApproval } from './types.js';
import { canonicalJson } from './input-validation.js';
import { MAX_CAPABILITY_APPROVAL_PAYLOAD_CHARS } from './approval-contract.js';

export const EXECUTE_CAPABILITY_TOOL = 'ExecuteProviderCapability';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function capabilityApprovalPayload(request: Parameters<CapabilityApproval>[0]) {
  const payload = {
    // The complete executor input is shown verbatim. A digest binds that
    // visible representation to the durable operation without hiding any
    // action-affecting content behind an abbreviated preview.
    input: request.input,
    inputSha256: digest(canonicalJson(request.input)),
    capabilityId: request.capabilityId,
    capabilityVersion: request.capabilityVersion,
    connectionId: request.connectionId,
    operationId: request.operationId,
  };
  if (JSON.stringify(payload).length > MAX_CAPABILITY_APPROVAL_PAYLOAD_CHARS)
    throw new Error('Capability input cannot fit a complete approval projection');
  return payload;
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
