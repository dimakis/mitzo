export const TRANSPORT_OWNERSHIP_GRACE_MS = 30_000;

interface ConnectionOwner {
  authSessionId: string;
  expiresAt: number | null;
  lifecycleRevision?: number;
}

const connectionOwners = new Map<string, ConnectionOwner>();

function pruneExpired(now = Date.now()): void {
  for (const [connectionId, owner] of connectionOwners) {
    if (owner.expiresAt !== null && owner.expiresAt <= now) {
      connectionOwners.delete(connectionId);
    }
  }
}

/** Bind a transport connection ID to the login session that created it. */
export function claimTransportConnection(connectionId: string, authSessionId: string): void {
  pruneExpired();
  connectionOwners.set(connectionId, { authSessionId, expiresAt: null });
}

/** Retain a brief, auth-bound lease so teardown sendBeacon requests can arrive. */
export function releaseTransportConnection(connectionId: string, authSessionId: string): void {
  const now = Date.now();
  pruneExpired(now);
  const owner = connectionOwners.get(connectionId);
  if (owner?.authSessionId === authSessionId) {
    connectionOwners.set(connectionId, {
      ...owner,
      expiresAt: now + TRANSPORT_OWNERSHIP_GRACE_MS,
    });
  }
}

export function isTransportConnectionOwnedBy(connectionId: string, authSessionId: string): boolean {
  pruneExpired();
  return connectionOwners.get(connectionId)?.authSessionId === authSessionId;
}

/** A subscription can manage consent only when it shares the current owner's login. */
export function transportConnectionsShareOwner(
  connectionId: string,
  ownerConnectionId: string,
): boolean {
  pruneExpired();
  const owner = connectionOwners.get(ownerConnectionId);
  return (
    owner !== undefined && connectionOwners.get(connectionId)?.authSessionId === owner.authSessionId
  );
}

/** Only a live, authenticated transport carries interactive operator authority. */
export function liveTransportAuthSessionId(connectionId: string): string | undefined {
  pruneExpired();
  const owner = connectionOwners.get(connectionId);
  return owner?.expiresAt === null ? owner.authSessionId : undefined;
}

/** Fence HTTP/beacon lifecycle hints by client order, not network arrival order.
 * Lives in the existing login lease so teardown beacons retain the same fence.
 * Legacy clients remain supported until this connection opts into revisions. */
export function acceptTransportLifecycle(connectionId: string, revision?: number): boolean {
  pruneExpired();
  const owner = connectionOwners.get(connectionId);
  if (revision === undefined) return owner?.lifecycleRevision === undefined;
  if (
    !owner ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    (owner.lifecycleRevision !== undefined && revision <= owner.lifecycleRevision)
  )
    return false;
  owner.lifecycleRevision = revision;
  return true;
}
