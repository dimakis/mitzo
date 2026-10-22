import { isAuthenticatedOperatorSessionId } from './auth.js';

/** Ordinary Mitzo has one signed interactive subject (`user`). Creating-login
 * IDs are provenance, not permanent device ACLs. Separate custodian realms and
 * internal/agent tokens never enter this verified primary-operator registry.
 * Callers retain their current transport/auth checks and effect fences.
 */
export function ordinaryOperatorOwnsConversation(
  ownerLoginId: string | undefined,
  actorLoginId: string | undefined,
): boolean {
  return (
    !!ownerLoginId &&
    !!actorLoginId &&
    (ownerLoginId === actorLoginId || isAuthenticatedOperatorSessionId(actorLoginId))
  );
}
