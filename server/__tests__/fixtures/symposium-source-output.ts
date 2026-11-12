import { createHash, randomUUID } from 'node:crypto';
import type { EventStore } from '../../event-store.js';

/** External ordinary source text, registered through the real durable owner. */
export function registerSymposiumSourceOutput(
  store: EventStore,
  sessionId: string,
  text: string,
  title = 'Selected saved design',
) {
  const messageId = randomUUID(),
    blockId = 'saved-text';
  store.append(sessionId, 'message_start', { messageId });
  store.append(sessionId, 'block_start', { messageId, blockId, blockType: 'text' });
  store.append(sessionId, 'block_delta', { messageId, blockId, delta: text });
  store.append(sessionId, 'block_end', { messageId, blockId, blockType: 'text' });
  const messageEndSeq = store.append(sessionId, 'message_end', { messageId });
  return store.registerSessionOutput(sessionId, {
    requestId: randomUUID(),
    title,
    source: {
      messageId,
      blockId,
      messageEndSeq,
      sha256: createHash('sha256').update(text).digest('hex'),
    },
  });
}
