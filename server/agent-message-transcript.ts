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
  // Retain the first cause until recovery without exposing private payloads or
  // repeating a diagnostic on every receipt wakeup.
  let failure: Error | undefined;
  return events.agentCommunication.subscribe(conversationId, () => {
    let stage = 'read';
    try {
      for (const event of events.getEventsAfter(conversationId, cursor)) {
        if (event.type === 'agent_message') {
          stage = 'projection';
          const { message, direction } = AgentMessageProjectionSchema.parse(
            event.payload.projection,
          );
          log.info('Agent message receipt changed', {
            messageId: message.messageId,
            senderConversationId: message.senderConversationId,
            recipientConversationId: message.recipientConversationId,
            status: message.status,
            reason: message.reason,
            direction,
            seq: event.seq,
          });
          stage = 'publication';
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
      failure = undefined;
    } catch (cause) {
      if (!failure) {
        failure = new Error('Agent message transcript update unavailable', { cause });
        log.warn('Agent message transcript update unavailable; retained events can be replayed', {
          code: 'agent_message_transcript_unavailable',
          stage,
          sessionId: conversationId,
        });
      }
    }
  });
}
