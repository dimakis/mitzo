import { expect, it } from 'vitest';
import { EventStore } from '../src/event-store.js';

it('freezes the completed public prefix while the calling lead is in an active tool turn', () => {
  const store = new EventStore(':memory:');
  try {
    store.upsertSession({ sessionId: 'lead' });
    const first = store.append('lead', 'user_message', {
      messageId: 'user',
      text: 'Plan this change',
    });
    store.append('lead', 'message_start', { messageId: 'in-progress', role: 'assistant' });
    store.append('lead', 'block_start', {
      messageId: 'in-progress',
      blockId: 'partial',
      blockType: 'text',
    });
    store.append('lead', 'block_delta', {
      messageId: 'in-progress',
      blockId: 'partial',
      delta: 'Unfinished text',
    });
    const boundary = store.getCollaborationCompletedBoundary('lead');
    expect(boundary).toEqual({ sequence: first, messageId: 'user' });
    const source = store.openCollaborationVisibleSource('lead', boundary);
    expect(
      source
        .readSelected(['user'])
        .flatMap((message) => message.blocks.map((block) => block.content)),
    ).toEqual(['Plan this change']);
    expect(() => source.readSelected(['in-progress'])).toThrow();
  } finally {
    store.close();
  }
});
