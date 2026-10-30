import { expect, it } from 'vitest';
import { replayEventsToMessages, replayEventsToTranscript } from '../conversation-transcript.js';
import type { StoredEvent } from '@mitzo/protocol';
it('restores late reply ownership and queued messages from the same immutable prefix', () => {
  const rows = [
    ['user_message', { messageId: 'a', text: 'First' }],
    ['ordinary_provider_dispatch_started', { messageId: 'a' }],
    ['user_message', { messageId: 'b', text: 'Correction' }],
    [
      'ordinary_reply_source',
      {
        version: 1,
        commandId: 'a',
        messageId: 'reply',
        providerThreadId: 'private',
        providerTurnId: 'private',
      },
    ],
    ['message_start', { messageId: 'reply' }],
    ['block_start', { messageId: 'reply', blockId: 'b', blockType: 'text' }],
    ['block_delta', { messageId: 'reply', blockId: 'b', blockType: 'text', delta: 'Old answer' }],
    ['block_end', { messageId: 'reply', blockId: 'b', blockType: 'text' }],
    ['message_end', { messageId: 'reply' }],
  ] as const;
  const events = rows.map(([type, payload], index) => ({
    seq: index + 1,
    sessionId: 'chat',
    type,
    payload,
    createdAt: index,
  })) as StoredEvent[];
  for (const messages of [
    replayEventsToMessages(events),
    replayEventsToTranscript(events).messages,
  ]) {
    expect(messages.find((m) => m.messageId === 'reply')).toMatchObject({ replyToMessageId: 'a' });
    expect(messages.find((m) => m.messageId === 'b')).toMatchObject({ commandState: 'queued' });
    expect(JSON.stringify(messages)).not.toContain('private');
  }
});
