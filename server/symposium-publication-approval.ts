import { randomUUID } from 'node:crypto';
import type { ConnectionRegistry, SessionRegistry } from '@mitzo/harness';
import {
  capabilityApprovalForConversation,
  capabilitySessionGrantKey,
} from './connections/capabilities/approval.js';
import type { CapabilityApproval } from './connections/capabilities/types.js';
// Logical conversations outlive the borrowed permission-registry runtime. This
// stores only scoped consent, never an owner or authentication decision.
const controllerGrants = new WeakMap<SessionRegistry, Map<string, Set<string>>>();
function conversationGrants(registry: SessionRegistry, conversationId: string): Set<string> {
  let conversations = controllerGrants.get(registry);
  if (!conversations) controllerGrants.set(registry, (conversations = new Map()));
  let grants = conversations.get(conversationId);
  if (!grants) conversations.set(conversationId, (grants = new Set()));
  return grants;
}

/** Clear only controller consent when its logical conversation or publication access closes. */
export function clearPublicationControllerSessionGrants(
  registry: SessionRegistry,
  conversationId?: string,
): void {
  const conversations = controllerGrants.get(registry);
  if (!conversations) return;
  for (const [id, grants] of conversations) {
    if (conversationId && id !== conversationId) continue;
    const session = registry.findBySessionId(id, true)?.session;
    for (const grant of grants) session?.sessionAllowList.delete(grant);
    grants.clear();
    conversations.delete(id);
  }
}

/** Native conversations already own ConnectionRegistry watches. Borrow the existing
 * SessionRegistry permission-owner contract only during approval; no SDK dispatch,
 * parallel owner map or durable controller session is introduced. */
export function publicationControllerApproval(
  registry: SessionRegistry,
  isOwned: (connectionId: string, authSessionId: string) => boolean,
  conversationId: string,
  authSessionId: string,
  requestedConnection?: string,
  connections?: ConnectionRegistry,
): CapabilityApproval | undefined {
  const initial = registry.findBySessionId(conversationId, true);
  const initialConnection = initial?.session.ownerConnectionId ?? initial?.clientId.split(':')[0];
  const candidates = connections
    ?.getConnectionsWatching(conversationId, true)
    .filter(
      (value) =>
        isOwned(value.connectionId, authSessionId) &&
        (!requestedConnection || value.connectionId === requestedConnection) &&
        (!initialConnection || value.connectionId === initialConnection),
    );
  const connection =
    initialConnection ?? (candidates?.length === 1 ? candidates[0].connectionId : undefined);
  if (
    !connection ||
    !isOwned(connection, authSessionId) ||
    (requestedConnection && connection !== requestedConnection)
  )
    return undefined;
  const watcher = connections?.get(connection);
  const checkWatch = () => {
    if (
      !isOwned(connection, authSessionId) ||
      (connections &&
        (!watcher ||
          connections.get(connection) !== watcher ||
          !watcher.watchedSessions.has(conversationId) ||
          !watcher.transport.isOpen()))
    )
      throw new Error('Authenticated publication controller changed');
  };
  try {
    checkWatch();
  } catch {
    return undefined;
  }
  return async (request, signal) => {
    signal.throwIfAborted();
    checkWatch();
    let owner = registry.findBySessionId(conversationId, true);
    if (!owner) {
      if (!watcher || initial) throw new Error('Authenticated publication controller changed');
      const clientId = `publication-${randomUUID()}`;
      registry.register(clientId, {
        ownerConnectionId: connection,
        sessionId: conversationId,
        transport: watcher.transport,
        abortController: new AbortController(),
        sessionAllowList: conversationGrants(registry, conversationId),
        mode: 'agent',
        symposiumPublicationUsers: 0,
      });
      owner = registry.findBySessionId(conversationId, true)!;
    }
    const session = owner.session;
    const ephemeral = session.symposiumPublicationUsers !== undefined;
    if (
      (session.ownerConnectionId ?? owner.clientId.split(':')[0]) !== connection ||
      (initial && initial.session !== session) ||
      (!initial && !ephemeral)
    )
      throw new Error('Authenticated publication controller changed');
    if (ephemeral) session.symposiumPublicationUsers!++;
    const current = () => {
      checkWatch();
      const found = registry.findBySessionId(conversationId, true);
      const matches = [...registry.entries(true)].filter(
        ([, value]) => value.sessionId === conversationId,
      );
      if (matches.length !== 1) throw new Error('Authenticated publication controller changed');
      if (!found || found.clientId !== owner.clientId || found.session !== session)
        throw new Error('Authenticated publication controller changed');
    };
    const watchAbort = new AbortController();
    const changed = () => {
      try {
        current();
      } catch {
        watchAbort.abort();
      }
    };
    const unsubscribe = connections?.onWatchChange(changed);
    const combined = AbortSignal.any([signal, session.abortController.signal, watchAbort.signal]);
    try {
      current();
      combined.throwIfAborted();
      const grants = conversationGrants(registry, conversationId);
      const key = capabilitySessionGrantKey(request);
      if (grants.has(key)) session.sessionAllowList.add(key);
      const decision = await capabilityApprovalForConversation(registry, conversationId)(
        request,
        combined,
      );
      current();
      combined.throwIfAborted();
      if (decision && session.sessionAllowList.has(key)) grants.add(key);
      return decision;
    } finally {
      unsubscribe?.();
      if (ephemeral) {
        session.symposiumPublicationUsers!--;
        if (session.symposiumPublicationUsers === 0 && registry.get(owner.clientId) === session) {
          registry.remove(owner.clientId);
          session.abortController.abort();
        }
      }
    }
  };
}
