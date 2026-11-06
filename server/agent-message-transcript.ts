import type { EventStore } from './event-store.js';
import { AgentMessageProjectionSchema } from '@mitzo/protocol';
import { createLogger } from './logger.js';
const log = createLogger('agent-communication');

/** The original session owner supplies the authorized transport. Reconnect
 * replays these same durable events; message text is never copied to logs. */
export function watchAgentMessageTranscript(
  events: EventStore,
  conversationId: string,
  publish: (event: Record<string, unknown>) => void,
): () => void {
  let cursor = events.getSessionEventCursor(conversationId);
  return events.agentCommunication.subscribe(conversationId, () => {
    for (const event of events.getEventsAfter(conversationId, cursor)) {
      if (event.type === 'agent_message') {
        const { message, direction } = AgentMessageProjectionSchema.parse(event.payload.projection);
        log.info('Agent message receipt changed', {
          messageId: message.messageId,
          senderConversationId: message.senderConversationId,
          recipientConversationId: message.recipientConversationId,
          status: message.status,
          reason: message.reason,
          direction,
          seq: event.seq,
        });
        publish({
          ...event.payload,
          type: event.type,
          sessionId: conversationId,
          seq: event.seq,
          prevSessionSeq: events.getSessionPredecessorSeq(conversationId, event.seq),
        });
      }
      cursor = event.seq;
    }
  });
}
