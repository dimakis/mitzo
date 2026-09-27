import type { SessionRegistry } from '@mitzo/harness';
import { capabilityApprovalForConversation } from './connections/capabilities/approval.js';
import type { CapabilityApproval } from './connections/capabilities/types.js';
/** The existing controller registry is the approval owner. No writer seat, live
 * builder credential binding or parallel controller session is created. */
export function publicationControllerApproval(
  registry: SessionRegistry,
  isOwned: (connectionId: string, authSessionId: string) => boolean,
  conversationId: string,
  authSessionId: string,
  requestedConnection?: string,
): CapabilityApproval | undefined {
  const initial = registry.findBySessionId(conversationId);
  if (!initial) return undefined;
  const connection = initial.session.ownerConnectionId ?? initial.clientId.split(':')[0];
  const current = () => {
    const owner = registry.findBySessionId(conversationId);
    if (
      !owner ||
      owner.clientId !== initial.clientId ||
      owner.session !== initial.session ||
      !isOwned(connection, authSessionId) ||
      (requestedConnection && connection !== requestedConnection)
    )
      throw new Error('Authenticated publication controller changed');
  };
  try {
    current();
  } catch {
    return undefined;
  }
  const approve = capabilityApprovalForConversation(registry, conversationId);
  return async (request, signal) => {
    signal.throwIfAborted();
    current();
    const decision = await approve(request, signal);
    signal.throwIfAborted();
    current();
    return decision;
  };
}
