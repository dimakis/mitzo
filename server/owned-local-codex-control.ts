import type { IncomingWsMessage } from '@mitzo/protocol';
import type { SessionRegistry, SessionTransport } from '@mitzo/harness';
import type { EventStore } from './event-store.js';
import { liveTransportAuthSessionId } from './transport-auth-ownership.js';
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
import { getPendingSessionId } from './permissions.js';

export type OwnedLocalControlContext = {
  sessionRegistry: Pick<SessionRegistry, 'get' | 'findBySessionId'>;
  eventStore: Pick<EventStore, 'getSessionRuntimeBinding'>;
};

/** Retained execution ownership belongs to a login, independently of attachment keys. */
export function ownedLocalControlStatus(
  connectionId: string,
  sessionId: string,
  transport: SessionTransport | undefined,
  ctx: OwnedLocalControlContext,
): 'unrestricted' | 'authorized' | 'denied' {
  const found = ctx.sessionRegistry.findBySessionId(sessionId, true);
  if (!found) return 'unrestricted';
  const owner = found.session?.ownedLocalAuthSessionId;
  const binding = ctx.eventStore.getSessionRuntimeBinding?.(sessionId);
  const boundLocal =
    binding?.execution?.location === 'local' && binding.harness.implementation === 'codex';
  if (!owner && !boundLocal) return 'unrestricted';
  return owner && liveTransportAuthSessionId(connectionId) === owner && transport?.isOpen()
    ? 'authorized'
    : 'denied';
}

/** Called before any legacy attachment, native command, queue or approval effect. */
export function assertLegacyOwnedControlAllowed(
  connectionId: string,
  clientId: string,
  transport: SessionTransport,
  message: IncomingWsMessage,
  ctx: OwnedLocalControlContext,
): void {
  const targets = new Set<string>();
  const currentSessionId = ctx.sessionRegistry.get(clientId)?.sessionId;
  if (currentSessionId) targets.add(currentSessionId);
  const pendingSessionId =
    message.type === 'permission_response' ? getPendingSessionId(message.permId) : undefined;
  const explicitTarget =
    message.type === 'reattach'
      ? ctx.sessionRegistry.get(message.clientId)?.sessionId
      : message.type === 'subscribe'
        ? message.sessionId
        : message.type === 'send'
          ? message.resume
          : message.type === 'permission_response'
            ? pendingSessionId
            : undefined;
  if (explicitTarget) targets.add(explicitTarget);
  for (const sessionId of targets) {
    const status = ownedLocalControlStatus(connectionId, sessionId, transport, ctx);
    const binding = ctx.eventStore.getSessionRuntimeBinding?.(sessionId);
    if (
      status === 'denied' ||
      (status === 'unrestricted' &&
        sessionId === pendingSessionId &&
        binding?.execution.location === 'local' &&
        binding.harness.implementation === 'codex')
    )
      throw Error('Owned local session belongs to another login');
    if (status === 'authorized') {
      // The assigned connection carries auth. A reattached driver key never replaces it.
      try {
        const captured = captureAgentLibraryAuthorization(connectionId);
        captured.assertCurrent();
        if (captured.auth.id !== liveTransportAuthSessionId(connectionId)) throw Error();
      } catch {
        throw Error('Owned local session belongs to another login');
      }
    }
    if ((message.type === 'send' || message.type === 'set_mode') && binding)
      throw Error('Runtime-bound commands require guarded admission');
  }
}

/** A stale socket can never detach the transport that replaced it. */
export function legacyChatOwnsAttachment(
  clientId: string,
  transport: SessionTransport,
  ctx: OwnedLocalControlContext,
): boolean {
  return ctx.sessionRegistry.get(clientId)?.transport === transport;
}
