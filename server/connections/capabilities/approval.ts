import { createHash, randomUUID } from 'node:crypto';
import {
  buildPermissionHandler,
  permissionDisplayInput,
  type SessionRegistry,
} from '@mitzo/harness';
import type { CapabilityApproval } from './types.js';
import { canonicalJson } from './input-validation.js';

export const EXECUTE_CAPABILITY_TOOL = 'ExecuteProviderCapability';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function capabilityApprovalPayload(request: Parameters<CapabilityApproval>[0]) {
  const payload = {
    // The executor supplies its semantic approval input. GitHub source and
    // long content use explicit previews with complete-value hashes; action
    // selectors remain visible and the durable projection is bound exactly.
    input: request.input,
    inputSha256: digest(canonicalJson(request.input)),
    capabilityId: request.capabilityId,
    capabilityVersion: request.capabilityVersion,
    connectionId: request.connectionId,
    operationId: request.operationId,
  };
  if (!permissionDisplayInput(EXECUTE_CAPABILITY_TOOL, payload))
    throw new Error('Capability input cannot fit a complete approval projection');
  return payload;
}

/** Trusted operation class and connection policy scope, isolated by the owning session. */
export function capabilitySessionGrantKey(request: Parameters<CapabilityApproval>[0]): string {
  return JSON.stringify([
    'capability',
    request.capabilityId,
    request.capabilityVersion,
    request.connectionId,
    request.connectionRevision ?? null,
  ]);
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
    const owner = registry.findBySessionId(conversationId, true);
    if (!owner) return false;
    const decision = await buildPermissionHandler(owner.clientId, registry)(
      EXECUTE_CAPABILITY_TOOL,
      capabilityApprovalPayload(request),
      {
        signal,
        toolUseID: randomUUID(),
        forcePrompt: request.forcePrompt,
        approvalScope: 'session',
        sessionGrantKey: capabilitySessionGrantKey(request),
        sessionGrantDescription:
          'This capability class on this connection until this session ends. Current inputs and connection policy are checked on every operation.',
        title: 'Approve provider capability?',
        description:
          'This performs the reviewed provider operation shown below. Mitzo will record the result and verify it before reporting success.',
      },
    );
    return decision.behavior === 'allow';
  };
}
