import { randomUUID } from 'node:crypto';
import {
  buildPermissionHandler,
  effectivePermissionMode,
  type SessionRegistry,
} from '@mitzo/harness';
import type { EventStore } from './event-store.js';

const grantKey = (operator: string, conversation: string) =>
  `agent-communication:${operator}:${conversation}`;
const adapterGrantKey = (operator: string, conversation: string) =>
  `agent-communication:adapters-v1:${operator}:${conversation}`;

/** One explicit session grant covers this chat's exchanges with the same signed
 * operator's live peers, including their correlated replies. It conveys no
 * filesystem, runtime, work-control or merge authority to a recipient. */
export function createAgentMessageApprover(options: {
  events: EventStore;
  registry: SessionRegistry;
  conversationId: string;
  toolName?: 'AgentCommunication' | 'mcp__mitzo-connections__AgentCommunication';
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
    // The original card approved Local Codex peers only. Preserve that narrow
    // grant without retroactively expanding its recipients to other runtimes.
    const nativePair = [options.conversationId, input.recipientConversationId].every((id) => {
      const binding = typeof id === 'string' && options.events.getSessionRuntimeBinding(id);
      return (
        binding &&
        binding.version === 2 &&
        binding.harness.implementation === 'codex' &&
        binding.execution.location === 'local'
      );
    });
    const expandedKey = adapterGrantKey(operator, options.conversationId);
    const ownGrantKey =
      nativePair && !owner.session.sessionAllowList.has(expandedKey)
        ? grantKey(operator, options.conversationId)
        : expandedKey;
    let replyGrantCurrent: (() => boolean) | undefined;
    if (typeof input.replyTo === 'string') {
      const original = options.events.agentCommunication.forHost(input.replyTo);
      const peer = options.registry.findBySessionId(original.message.senderConversationId);
      const peerIdentity = peer?.session.ordinaryRuntimeOwner;
      const replyKey = [
        adapterGrantKey(operator, original.message.senderConversationId),
        ...(nativePair ? [grantKey(operator, original.message.senderConversationId)] : []),
      ].find((key) => peer?.session.sessionAllowList.has(key));
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
          !!replyKey &&
          peer.session.sessionAllowList.has(replyKey),
        );
    }
    const decision = await buildPermissionHandler(
      owner.clientId,
      options.registry,
      options.permissionOptions,
    )(options.toolName ?? 'AgentCommunication', input, {
      signal,
      toolUseID: randomUUID(),
      forcePrompt: true,
      allowSessionGrant: true,
      sessionGrantKey: ownGrantKey,
      isRetainedSessionGrantCurrent: replyGrantCurrent,
      sessionGrantDescription:
        ownGrantKey === expandedKey
          ? 'Exchange messages between this chat and your other live chats with verified message adapters for this session, including their replies. This does not authorize their work, credentials, networking or merges.'
          : 'Exchange messages between this chat and your other live Local Mac Codex chats for this session, including their replies. This does not authorize their work or merges.',
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
