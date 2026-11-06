import { randomUUID } from 'node:crypto';
import {
  buildPermissionHandler,
  effectivePermissionMode,
  type SessionRegistry,
} from '@mitzo/harness';
import type { EventStore } from './event-store.js';

const grantKey = (operator: string, conversation: string) =>
  `agent-communication:${operator}:${conversation}`;

/** One explicit session grant covers this chat's exchanges with the same signed
 * operator's live peers, including their correlated replies. It conveys no
 * filesystem, runtime, work-control or merge authority to a recipient. */
export function createAgentMessageApprover(options: {
  events: EventStore;
  registry: SessionRegistry;
  conversationId: string;
  assertCurrent(): void;
  permissionOptions?: Parameters<typeof buildPermissionHandler>[2];
}) {
  return async (input: Record<string, unknown>, signal: AbortSignal) => {
    options.assertCurrent();
    signal.throwIfAborted();
    const owner = options.registry.findBySessionId(options.conversationId);
    const operator = owner?.session.ordinaryRuntimeOwner?.authSessionId;
    if (!owner || !operator || owner.session.abortController.signal.aborted)
      throw Error('Current signed native sender required');
    const ownerIdentity = owner.session.ordinaryRuntimeOwner;
    const ownGrantKey = grantKey(operator, options.conversationId);
    let replyGrantCurrent: (() => boolean) | undefined;
    if (typeof input.replyTo === 'string') {
      const original = options.events.agentCommunication.forHost(input.replyTo);
      const peer = options.registry.findBySessionId(original.message.senderConversationId);
      const peerIdentity = peer?.session.ordinaryRuntimeOwner;
      replyGrantCurrent = () =>
        Boolean(
          original.operatorAuthSessionId === operator &&
          original.message.recipientConversationId === options.conversationId &&
          original.message.senderConversationId === input.recipientConversationId &&
          peer &&
          options.registry.findBySessionId(original.message.senderConversationId)?.session ===
            peer.session &&
          peer.session.ordinaryRuntimeOwner === peerIdentity &&
          peerIdentity?.authSessionId === operator &&
          !peer.session.abortController.signal.aborted &&
          !options.registry.isClosingOut(peer.clientId) &&
          !options.registry.isUserClose(peer.clientId) &&
          peer.session.sessionAllowList.has(
            grantKey(operator, original.message.senderConversationId),
          ),
        );
    }
    const decision = await buildPermissionHandler(
      owner.clientId,
      options.registry,
      options.permissionOptions,
    )('AgentCommunication', input, {
      signal,
      toolUseID: randomUUID(),
      forcePrompt: true,
      allowSessionGrant: true,
      sessionGrantKey: ownGrantKey,
      isRetainedSessionGrantCurrent: replyGrantCurrent,
      sessionGrantDescription:
        'Exchange messages between this chat and your other live Local Mac Codex chats for this session, including their replies. This does not authorize their work or merges.',
      title: 'Allow agent messages?',
      description:
        'Allow this message once, or allow these same-operator exchanges for this session. Every message and delivery receipt appears in both chats.',
    });
    options.assertCurrent();
    signal.throwIfAborted();
    // Freeze the authority actually used. A correlated grant must not silently
    // become a different grant if it is revoked during asynchronous admission.
    const grantCurrent =
      decision.decisionClassification === 'user_permanent'
        ? owner.session.sessionAllowList.has(ownGrantKey)
          ? () => owner.session.sessionAllowList.has(ownGrantKey)
          : replyGrantCurrent
        : undefined;
    const assertCurrent = () => {
      options.assertCurrent();
      if (
        options.registry.findBySessionId(options.conversationId)?.session !== owner.session ||
        owner.session.ordinaryRuntimeOwner !== ownerIdentity ||
        ownerIdentity?.authSessionId !== operator ||
        owner.session.abortController.signal.aborted ||
        options.registry.isClosingOut(owner.clientId) ||
        options.registry.isUserClose(owner.clientId) ||
        effectivePermissionMode(owner.session) === 'ask' ||
        (decision.decisionClassification === 'user_permanent' && !grantCurrent?.())
      )
        throw Error('Agent messaging permission changed');
    };
    if (decision.behavior === 'allow') assertCurrent();
    return { ...decision, assertCurrent };
  };
}
