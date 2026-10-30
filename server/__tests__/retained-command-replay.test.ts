import { expect, it } from 'vitest';
import type { StoredEvent } from '../event-store.js';
import { replayEventsToMessages, replayEventsToTranscript } from '../conversation-transcript.js';

const sessionId = 'retained-replay';
const savedError = {
  v: 2,
  type: 'error',
  sessionId,
  clientMsgId: 'older',
  retainedCommandFailure: true,
  error:
    'Message saved. Codex queue admission could not finish. Check the connection before sending a new message.',
};
const rows = (events: Array<{ type: string; payload: Record<string, unknown> }>): StoredEvent[] =>
  events.map((event, index) => ({ ...event, seq: index + 1, createdAt: 1000, sessionId }));

it.each(['history', 'reconnect'] as const)(
  'restores an exact retained command failure with its original group during %s',
  (path) => {
    const events = rows([
      { type: 'user_message', payload: { messageId: 'older', text: 'Older request' } },
      { type: 'user_message', payload: { messageId: 'newer', text: 'Newer request' } },
      { type: 'message_start', payload: { messageId: 'newer-output' } },
      {
        type: 'block_start',
        payload: { messageId: 'newer-output', blockId: 'text', blockType: 'text' },
      },
      {
        type: 'block_delta',
        payload: { messageId: 'newer-output', blockId: 'text', delta: 'Newer partial output' },
      },
      {
        type: 'block_end',
        payload: { messageId: 'newer-output', blockId: 'text', blockType: 'text' },
      },
      { type: 'error', payload: savedError },
    ]);
    const transcript = replayEventsToTranscript(events);
    const messages = path === 'history' ? replayEventsToMessages(events) : transcript.messages;
    expect(messages.slice(0, 3).map((message) => message.messageId)).toEqual([
      'older',
      'runtime-error-7',
      'newer',
    ]);
    expect(messages[1].blocks[0].content).toBe(`**Error:** ${savedError.error}`);
    expect(transcript.current?.messageId).toBe('newer-output');
    expect(transcript.current?.blocks[0].content).toBe('Newer partial output');
    if (path === 'history') expect(messages.at(-1)?.messageId).toBe('newer-output');
  },
);

it.each([
  { name: 'unmarked startup diagnostic', patch: { retainedCommandFailure: undefined } },
  { name: 'unknown command', patch: { clientMsgId: 'unaccepted' } },
  { name: 'foreign session', patch: { sessionId: 'foreign' } },
  { name: 'wrong version', patch: { v: 1 } },
  { name: 'wrong type', patch: { type: 'other' } },
  { name: 'non-string command', patch: { clientMsgId: null } },
  { name: 'non-public diagnostic text', patch: { error: 'PRIVATE_STARTUP_DIAGNOSTIC' } },
])('keeps $name private even after a different durable echo', ({ patch }) => {
  const events = rows([
    { type: 'user_message', payload: { messageId: 'older', text: 'Accepted request' } },
    {
      type: 'error',
      payload: { ...savedError, error: 'Message saved. PRIVATE_STARTUP_DIAGNOSTIC', ...patch },
    },
  ]);
  for (const messages of [
    replayEventsToMessages(events),
    replayEventsToTranscript(events).messages,
  ]) {
    expect(messages.map((message) => message.messageId)).toEqual(['older']);
    expect(JSON.stringify(messages)).not.toContain('PRIVATE_STARTUP_DIAGNOSTIC');
  }
});

it('requires the exact same-session echo to precede a retained failure', () => {
  for (const events of [
    rows([
      { type: 'error', payload: savedError },
      { type: 'user_message', payload: { messageId: 'older', text: 'Later echo' } },
    ]),
    rows([
      {
        type: 'user_message',
        payload: { messageId: 'older', text: 'Foreign echo', sessionId: 'foreign' },
      },
      { type: 'error', payload: savedError },
    ]),
  ]) {
    expect(
      replayEventsToMessages(events).some((message) =>
        message.messageId.startsWith('runtime-error-'),
      ),
    ).toBe(false);
    expect(
      replayEventsToTranscript(events).messages.some((message) =>
        message.messageId.startsWith('runtime-error-'),
      ),
    ).toBe(false);
  }
});
