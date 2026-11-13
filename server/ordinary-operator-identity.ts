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

/** Live peers must prove both admitted identities belong to the primary realm.
 * Unlike historical creating-login custody, an unknown live owner is not provenance. */
export function ordinaryOperatorsShareIdentity(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return (
    !!left &&
    !!right &&
    (left === right ||
      (isAuthenticatedOperatorSessionId(left) && isAuthenticatedOperatorSessionId(right)))
  );
}
