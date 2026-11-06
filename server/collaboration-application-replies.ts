import { createHash } from 'node:crypto';
import { CollaborationContractError } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { CodexConversationStore } from './codex-conversation-store.js';
import { OrdinaryCollaborationReplies } from './collaboration-ordinary-replies.js';
import { reconcileCollaborationCommandAcceptance } from './collaboration-ordinary-command.js';

function projectionRequest(group: string, commandId: string, messageId: string) {
  const h = createHash('sha256')
    .update(JSON.stringify([group, commandId, messageId]))
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Project retained native evidence without dispatch, context admission or new
 * sessions. Keyset reads retain old prompt identities outside the display page.
 * Each source is decoded independently with bounded visible-block reads. */
export function reconcileApplicationCollaborationReplies(
  store: EventStore,
  group: string,
  nativeStore?: () => CodexConversationStore | undefined,
) {
  const retained = store.collaborationConversation.view(group);
  const replies = new OrdinaryCollaborationReplies(store);
  let native: CodexConversationStore | undefined;
  let observedNative = false;
  let after = 0;
  for (;;) {
    const page = store.collaborationConversation.messagesForReplyReconciliation(
      group,
      after,
      retained.cursor,
    );
    if (!page.length) break;
    for (const prompt of page) {
      after = prompt.sequence;
      for (const delivery of prompt.deliveries) {
        if (
          delivery.purpose !== 'reply' ||
          !delivery.commandId ||
          !['queued', 'uncertain', 'delivered'].includes(delivery.status)
        )
          continue;
        if (delivery.status !== 'delivered' && nativeStore) {
          // An unavailable/missing native observation remains uncertain. Reading
          // must not initialize native persistence or start a provider to repair it.
          try {
            if (!observedNative) {
              native = nativeStore();
              observedNative = true;
            }
            const account = store.getSession(delivery.sessionId)?.accountBinding;
            if (native && account)
              reconcileCollaborationCommandAcceptance(
                store,
                native,
                delivery.sessionId,
                account,
                delivery.commandId,
              );
          } catch {
            /* Retain the original uncertain receipt for later inspection. */
          }
        }
        if (
          !retained.participantSessionIds.includes(delivery.sessionId) ||
          retained.unavailableParticipantSessionIds.includes(delivery.sessionId)
        )
          continue;
        try {
          store.collaborationConversation.assertCurrentDeliveryRecipient(
            group,
            prompt.messageId,
            delivery.deliveryId,
            delivery.sessionId,
          );
        } catch (error) {
          if (error instanceof CollaborationContractError) continue;
          throw error;
        }
        for (const messageId of replySources(store, delivery.sessionId, delivery.commandId)) {
          const mappings = store.getOrdinaryReplySourceEvents(
            delivery.sessionId,
            messageId,
          ) as Array<{ commandId?: string }>;
          if (mappings.length !== 1 || mappings[0].commandId !== delivery.commandId) continue;
          try {
            const source = store.readOrdinaryFinalizedReply(delivery.sessionId, messageId);
            if (!source) continue;
            replies.record(group, {
              requestId: projectionRequest(group, delivery.commandId, source.messageId),
              messageId: prompt.messageId,
              deliveryId: delivery.deliveryId,
              source: {
                conversationId: delivery.sessionId,
                commandId: delivery.commandId,
                messageId: source.messageId,
                blockIds: source.blocks.map((row) => row.blockId),
                throughSequence: source.sequence,
              },
            });
          } catch (error) {
            // Retained ordinary failures can make this source ineligible for
            // projection. Keep the rest of the conversation readable.
            if (!(error instanceof CollaborationContractError)) throw error;
          }
        }
      }
    }
    if (page.length < 50) break;
  }
  return store.collaborationConversation.view(group);
}

function* replySources(store: EventStore, sessionId: string, commandId: string) {
  let after = 0;
  for (;;) {
    const page = store.getOrdinaryReplySourcePage(sessionId, commandId, after);
    for (const row of page) {
      after = row.sequence;
      if (row.messageId) yield row.messageId;
    }
    if (page.length < 50) return;
  }
}
