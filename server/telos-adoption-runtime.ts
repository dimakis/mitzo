import type { EventStore } from './event-store.js';
import type { SessionRegistry } from '@mitzo/harness';
import type { CodexConversationStore } from './codex-conversation-store.js';
import { getCodexRuntime, retireIdleCodexChat } from './codex-chat-session.js';
import { drainQueryLoopFinalization } from './query-loop.js';
import type { TelosAdoptionRuntime } from './telos-existing-chat-adoption.js';

/** Canonical native owners only. A missing registry entry cannot attest to
 * cleanup of an executed chat; only a never-admitted preparation is cold-safe. */
export function createTelosAdoptionRuntime(deps: {
  events: EventStore;
  registry: SessionRegistry;
  native(): CodexConversationStore;
}): TelosAdoptionRuntime {
  // Exact objects survive registry removal for this host's interrupted drains.
  // A process restart cannot manufacture this evidence from an absent registry.
  const retiring = new Map<
    string,
    { conversationId: string; owner: NonNullable<ReturnType<SessionRegistry['findBySessionId']>> }
  >();
  const retainedOwner = (id: string, operationId: string) => {
    const retained = retiring.get(operationId);
    if (retained && retained.conversationId !== id)
      throw Error('Original retirement identity changed');
    return retained?.owner;
  };
  const assertRetirable = (id: string, operationId: string) => {
    const retained = retainedOwner(id, operationId);
    const live = deps.registry.findBySessionId(id);
    if (retained && live && retained.session !== live.session)
      throw Error('Original retirement owner changed');
    if (
      !live &&
      !retained &&
      (deps.native().hasConversation(id) ||
        deps.events.getOrdinaryInitialCommandId(id) ||
        deps.events.hasProviderDispatchForConversation(id))
    )
      throw Error(
        'Original runtime cleanup is unconfirmed; no adoption hold was acquired. Recover the original owner.',
      );
  };
  const assertQuiescent = (id: string, operationId: string) => {
    deps.events.assertOrdinaryContextQuiescent(id);
    const metadata = deps.events.getSession(id);
    if (!metadata?.accountBinding || !metadata.cwd)
      throw Error('Original adoption custody unavailable');
    const native = deps.native();
    if (native.hasConversation(id))
      native.assertContextTransitionQuiescent(id, metadata.accountBinding, metadata.cwd);
    else if (
      deps.events.getOrdinaryInitialCommandId(id) ||
      deps.events.hasProviderDispatchForConversation(id)
    )
      throw Error('Original native command owner unavailable');
    const live = deps.registry.findBySessionId(id);
    if (
      live &&
      retainedOwner(id, operationId)?.session !== live.session &&
      (deps.registry.isClosingOut(live.clientId) ||
        deps.registry.isUserClose(live.clientId) ||
        getCodexRuntime(live.session)?.peerMessageState() !== 'idle')
    )
      throw Error('Existing chat is busy or its exact native owner is unavailable');
  };
  return {
    assertQuiescent,
    assertRetirable,
    async retire(id, assertCurrent, signal, operationId) {
      signal.throwIfAborted();
      assertCurrent();
      assertQuiescent(id, operationId);
      assertRetirable(id, operationId);
      const live = deps.registry.findBySessionId(id) ?? retainedOwner(id, operationId);
      if (!live) {
        return;
      }
      retiring.set(operationId, { conversationId: id, owner: live });
      const current = () => {
        signal.throwIfAborted();
        assertCurrent();
        const next = deps.registry.findBySessionId(id);
        if (next && next.session !== live.session)
          throw Error('Existing chat runtime owner changed');
      };
      await retireIdleCodexChat(live.session, current);
      await drainQueryLoopFinalization(live.session);
      current();
      if (deps.registry.findBySessionId(id)) throw Error('Original query owner has not retired');
    },
  };
}
