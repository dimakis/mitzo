import { randomUUID } from 'node:crypto';
import type { ManagedSession } from '@mitzo/harness';
import {
  captureAgentLibraryAuthorization,
  bindAgentLibraryTransport,
} from './agent-library-transport.js';

const retainedOperators = new WeakMap<ManagedSession, string>();

/** Retain the already-admitted ordinary runtime login under the chat lifetime, independently
 * of its viewer connection. The existing auth registry still owns revocation. */
export function retainNativeHostToolOperator(
  session: ManagedSession,
  operatorConnectionId: string,
): () => void {
  session.abortController.signal.throwIfAborted();
  const authorization = captureAgentLibraryAuthorization(operatorConnectionId);
  authorization.assertCurrent();
  if (
    !session.ownedLocalAuthSessionId ||
    session.ownedLocalAuthSessionId !== authorization.auth.id ||
    retainedOperators.has(session)
  )
    throw Error('Original native host operator unavailable');
  const connectionId = `native-host:${randomUUID()}`;
  const release = bindAgentLibraryTransport(connectionId, { ...authorization.auth });
  retainedOperators.set(session, connectionId);
  session.abortController.signal.addEventListener('abort', release, { once: true });
  return () => {
    // Keep the selected identity until this session is collected. Releasing it
    // must not silently fall back to a still-connected viewer's authorization.
    session.abortController.signal.removeEventListener('abort', release);
    release();
  };
}

/** Controller-only admitted identity; never resolves a detached viewer as a grant. */
export function retainedNativeHostToolOperator(session: ManagedSession): string | undefined {
  return retainedOperators.get(session);
}

/** Tool authority follows the admitted runtime, never a replacement viewer.
 * Keep a released retained ID selected so revocation cannot fall back to a viewer.
 * Legacy runtimes without retained authority still require their signed transport. */
export function sessionToolOperatorConnection(session: ManagedSession, clientId: string): string {
  return (
    retainedNativeHostToolOperator(session) ?? session.ownerConnectionId ?? clientId.split(':')[0]
  );
}
