import type { RequestHandler } from 'express';
import type { EventStore } from './event-store.js';
/** Same authenticated read boundary as conversation history; receipt lookup never mutates a turn. */
export function createQueuedMessageReceiptHandler(
  store: Pick<EventStore, 'getSession' | 'hasUserMessage'>,
): RequestHandler {
  return (req, res) => {
    const sessionId = String(req.params.id),
      messageId = String(req.params.messageId);
    const session = store.getSession(sessionId);
    if (!session || session.symposiumConfig || session.sessionType === 'symposium') {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.json({ messageId, received: store.hasUserMessage(sessionId, messageId) });
  };
}
