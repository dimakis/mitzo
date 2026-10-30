import { expect, it } from 'vitest';
import { replayEventsToMessages, replayEventsToTranscript } from '../conversation-transcript.js';
import type { StoredEvent } from '@mitzo/protocol';
it('restores late reply ownership and queued messages from the same immutable prefix', () => {
  const rows = [
    ['user_message', { messageId: 'a', text: 'First' }],
    ['ordinary_provider_dispatch_started', { messageId: 'a' }],
    ['ordinary_command_state', { messageId: 'b', commandState: 'queued' }],
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

it('leaves already answered legacy input unknown and restores a first queued native command before dispatch', () => {
  const events = [
    ['user_message', { messageId: 'legacy', text: 'Old task' }],
    ['message_start', { messageId: 'old-answer' }],
    ['message_end', { messageId: 'old-answer' }],
    ['session_end', {}],
    ['ordinary_command_state', { messageId: 'native', commandState: 'queued' }],
    ['user_message', { messageId: 'native', text: 'New task' }],
  ].map(([type, payload], i) => ({
    seq: i + 1,
    sessionId: 'chat',
    createdAt: i,
    type,
    payload,
  })) as StoredEvent[];
  for (const messages of [
    replayEventsToMessages(events),
    replayEventsToTranscript(events).messages,
  ]) {
    expect(messages.find((m) => m.messageId === 'legacy')?.commandState).toBeUndefined();
    expect(messages.find((m) => m.messageId === 'native')?.commandState).toBe('queued');
  }
});
it('restores the same quoted source for a user reply from its captured immutable metadata', () => {
  const context = {
    messageId: 'source',
    role: 'assistant',
    text: 'Original visible answer',
    timestamp: 1000,
  };
  const events = [
    ['message_reply_context', { messageId: 'reply', context }],
    ['user_message', { messageId: 'reply', text: 'Correction' }],
  ].map(([type, payload], i) => ({
    type,
    payload,
    seq: i + 1,
    createdAt: i,
    sessionId: 'chat',
  })) as StoredEvent[];
  for (const messages of [
    replayEventsToMessages(events),
    replayEventsToTranscript(events).messages,
  ])
    expect(messages[0].inReplyTo).toEqual(context);
});
