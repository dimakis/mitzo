export const TRANSPORT_OWNERSHIP_GRACE_MS = 30_000;

interface ConnectionOwner {
  authSessionId: string;
  expiresAt: number | null;
  lifecycle?: {
    revision: number;
    originConnectionId: string;
    currentConnectionId: string;
  };
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
export function acceptTransportLifecycle(
  connectionId: string,
  revision?: number,
  replacesConnectionId?: string,
): boolean {
  pruneExpired();
  const owner = connectionOwners.get(connectionId);
  if (revision === undefined)
    return owner?.lifecycle === undefined && replacesConnectionId === undefined;
  if (
    !owner ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    (owner.lifecycle && owner.lifecycle.currentConnectionId !== connectionId)
  )
    return false;
  let lifecycle = owner.lifecycle;
  let predecessor: ConnectionOwner | undefined;
  if (replacesConnectionId && replacesConnectionId !== connectionId) {
    predecessor = connectionOwners.get(replacesConnectionId);
    // The initial stream's grace lease may have expired during bounded retries.
    // Its active same-login successor retains the shared origin and fence.
    predecessor ??= [...connectionOwners.values()].find(
      (candidate) =>
        candidate.authSessionId === owner.authSessionId &&
        candidate.lifecycle?.originConnectionId === replacesConnectionId,
    );
    if (predecessor && predecessor.authSessionId !== owner.authSessionId) return false;
    // A long background can expire every predecessor lease. Resume normally;
    // an unknown origin alone never proves replacement of a live driver.
    const source = predecessor?.lifecycle ??
      lifecycle ?? {
        revision: -1,
        originConnectionId: replacesConnectionId,
        currentConnectionId: replacesConnectionId,
      };
    if (lifecycle && lifecycle !== source) return false;
    lifecycle = source;
  }
  lifecycle ??= {
    revision: -1,
    originConnectionId: connectionId,
    currentConnectionId: connectionId,
  };
  if (revision <= lifecycle.revision) return false;
  lifecycle.revision = revision;
  lifecycle.currentConnectionId = connectionId;
  owner.lifecycle = lifecycle;
  if (predecessor) predecessor.lifecycle = lifecycle;
  return true;
}

/** A versioned replay may replace only its explicit, same-login stream lineage. */
export function transportConnectionReplaces(connectionId: string, predecessorId: string): boolean {
  const owner = connectionOwners.get(connectionId);
  const predecessor = connectionOwners.get(predecessorId);
  return (
    connectionId !== predecessorId &&
    !!owner?.lifecycle &&
    owner.lifecycle.currentConnectionId === connectionId &&
    owner.authSessionId === predecessor?.authSessionId &&
    owner.lifecycle === predecessor.lifecycle
  );
}
