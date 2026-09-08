export const TRANSPORT_OWNERSHIP_GRACE_MS = 30_000;

interface ConnectionOwner {
  authSessionId: string;
  expiresAt: number | null;
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
      authSessionId,
      expiresAt: now + TRANSPORT_OWNERSHIP_GRACE_MS,
    });
  }
}

export function isTransportConnectionOwnedBy(connectionId: string, authSessionId: string): boolean {
  pruneExpired();
  return connectionOwners.get(connectionId)?.authSessionId === authSessionId;
}
