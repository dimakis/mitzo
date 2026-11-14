import { isDeepStrictEqual } from 'node:util';
import { checkSkillPolicy, type ManagedSession, type SessionRegistry } from '@mitzo/harness';
import type { EventStore } from './event-store.js';
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
import { sessionToolOperatorConnection } from './native-host-tool-operator.js';
import { agentToolAllowed } from './agent-tool-selection.js';
import { SDK_CONNECTION_PREFIX } from './ordinary-sdk-helper-registration.js';
import { captureSessionHistoryAuthorization } from './session-history-authorization.js';
import { sessionHistoryTools } from './session-history-tools.js';

/** Adapt the existing guarded SDK callback to the shared history owner. This
 * captures no provider files and creates no operator/account/session grant. */
export function sessionSdkHistoryTools(owners: {
  events: EventStore;
  session: ManagedSession;
  registry: SessionRegistry;
  signal: AbortSignal;
  assertCurrent(signal: AbortSignal): Promise<void>;
  assertCurrentSync(signal: AbortSignal): void;
}) {
  return sessionHistoryTools({
    store: owners.events,
    projectPublicText: (text) => text,
    capture(call, toolName) {
      const { session, registry, signal } = owners;
      const id = session.sessionId;
      const initial = id ? registry.findBySessionId(id) : undefined;
      if (!initial || initial.session !== session)
        throw Error('Original history session unavailable');
      const connectionId = sessionToolOperatorConnection(session, initial.clientId);
      const operator = captureAgentLibraryAuthorization(connectionId);
      const account = structuredClone(session.accountBinding);
      const assertCurrentSync = () => {
        signal.throwIfAborted();
        session.abortController.signal.throwIfAborted();
        owners.assertCurrentSync(signal);
        operator.assertCurrent();
        const current = registry.findBySessionId(id!);
        if (
          !current ||
          current.session !== session ||
          session.sessionId !== id ||
          sessionToolOperatorConnection(session, current.clientId) !== connectionId ||
          !isDeepStrictEqual(session.accountBinding, account) ||
          !agentToolAllowed(session, toolName) ||
          checkSkillPolicy(registry, current.clientId, SDK_CONNECTION_PREFIX + toolName) === 'deny'
        )
          throw Error('Original history caller unavailable');
      };
      return captureSessionHistoryAuthorization({
        context: {
          ...call,
          toolName,
          session,
          signal,
          assertCurrentSync,
          async assertCurrent() {
            assertCurrentSync();
            await owners.assertCurrent(signal);
            assertCurrentSync();
          },
          // No per-call resource is acquired; the SDK owns callback lifetime.
          dispose() {},
        },
        events: owners.events,
        call,
        toolName,
        permissionPrefix: SDK_CONNECTION_PREFIX,
      });
    },
  });
}
