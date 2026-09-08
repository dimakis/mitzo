const connectionOwners = new Map<string, string>();

/** Bind a transport connection ID to the login session that created it. */
export function claimTransportConnection(connectionId: string, authSessionId: string): void {
  connectionOwners.set(connectionId, authSessionId);
}

/** Release only the binding owned by this login, protecting replacement connections. */
export function releaseTransportConnection(connectionId: string, authSessionId: string): void {
  if (connectionOwners.get(connectionId) === authSessionId) connectionOwners.delete(connectionId);
}

export function isTransportConnectionOwnedBy(connectionId: string, authSessionId: string): boolean {
  return connectionOwners.get(connectionId) === authSessionId;
}
