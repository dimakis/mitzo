import type { EventStore } from './event-store.js';
import type { SessionRegistry } from '@mitzo/harness';
import type { CodexConversationStore } from './codex-conversation-store.js';
import { getCodexRuntime, retireIdleCodexChat } from './codex-chat-session.js';
import { drainQueryLoopFinalization } from './query-loop.js';
import { TelosAdoptionRefusal, type TelosAdoptionRuntime } from './telos-existing-chat-adoption.js';

/** Canonical native owners only. A missing registry entry cannot attest to
 * cleanup of an executed Codex chat; only a never-admitted preparation is
 * cold-safe. A Local Mac Claude SDK chat is cold-safe when its retained SDK
 * custody records no pending, queued or uncertain input: its SDK process lives
 * only inside the query loop, which leaves the registry after it finalizes. */
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
  const claudeChat = (id: string) => {
    const metadata = deps.events.getSession(id);
    return (
      metadata?.repositoryWorkspaceId != null &&
      deps.events.getSessionRuntimeBinding(id)?.harness.implementation === 'claude-sdk'
    );
  };
  const assertRetirable = (id: string, operationId: string) => {
    const retained = retainedOwner(id, operationId);
    const live = deps.registry.findBySessionId(id);
    if (retained && live && retained.session !== live.session)
      throw Error('Original retirement owner changed');
    if (
      !live &&
      !retained &&
      !(claudeChat(id) && deps.events.getOrdinaryLocalVertexCustody(id)) &&
      (deps.native().hasConversation(id) ||
        deps.events.getOrdinaryInitialCommandId(id) ||
        deps.events.hasProviderDispatchForConversation(id))
    )
      throw Error(
        'Original runtime cleanup is unconfirmed; no adoption hold was acquired. Recover the original owner.',
      );
  };
  const assertClaudeQuiescent = (id: string) => {
    const metadata = deps.events.getSession(id)!;
    if (!deps.events.getOrdinaryLocalVertexCustody(id))
      throw new TelosAdoptionRefusal('existing_chat_incompatible');
    if (
      deps.events.hasUncertainOrdinaryCommand(id) ||
      deps.events.getPendingOrdinaryLocalVertexCommandIds(id).length > 0 ||
      (metadata.executionPhase && metadata.executionPhase !== 'TERMINAL')
    )
      throw new TelosAdoptionRefusal('existing_chat_busy');
  };
  const assertQuiescent = (id: string, operationId: string) => {
    deps.events.assertOrdinaryContextQuiescent(id);
    const metadata = deps.events.getSession(id);
    if (!metadata?.accountBinding || !metadata.cwd)
      throw Error('Original adoption custody unavailable');
    const claude = claudeChat(id);
    const native = deps.native();
    if (claude) assertClaudeQuiescent(id);
    else if (native.hasConversation(id))
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
        (claude
          ? !live.session.ordinaryRuntimeOwner
          : getCodexRuntime(live.session)?.peerMessageState() !== 'idle'))
    )
      throw new TelosAdoptionRefusal('existing_chat_busy');
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
      if (claudeChat(id)) {
        // An idle SDK owner waits for its next input. Closing it ends that
        // query without interrupting a turn; the next ordinary command resumes
        // the retained SDK session with the newly retained role context.
        const owner = live.session.ordinaryRuntimeOwner;
        if (!owner) throw Error('Original Claude SDK owner unavailable');
        current();
        owner.close();
      } else await retireIdleCodexChat(live.session, current);
      await drainQueryLoopFinalization(live.session);
      current();
      if (deps.registry.findBySessionId(id)) throw Error('Original query owner has not retired');
    },
  };
}
