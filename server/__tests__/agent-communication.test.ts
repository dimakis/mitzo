import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventStore } from '../event-store.js';

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);

it('retains exact attributed peer messages, request identity and uncertain delivery across restart without sharing unrelated history', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-communication-'));
  let events = new EventStore(join(root, 'events.db'));
  cleanups.push(() => {
    events.close();
    rmSync(root, { recursive: true, force: true });
  });
  for (const id of ['a', 'b', 'c']) events.upsertSession({ sessionId: id });
  const input = {
    requestId: randomUUID(),
    recipientConversationId: 'b',
    text: 'Can you review the result?',
  };
  const origin = { turnId: 'native-a-turn', callId: 'native-a-call' };
  const first = events.agentCommunication.reserve('a', 'signed-operator', origin, input);
  expect(first.senderConversationId).toBe('a');
  expect(first.status).toBe('pending');
  expect(events.agentCommunication.reserve('a', 'signed-operator', origin, input)).toEqual(first);
  expect(() =>
    events.agentCommunication.reserve('a', 'signed-operator', origin, {
      ...input,
      text: 'Changed',
    }),
  ).toThrow(/identity/);
  expect(() => events.agentCommunication.read('c', first.messageId)).toThrow(/authorized/);
  expect(events.agentCommunication.claim(first.messageId)).toBe(true);
  expect(events.agentCommunication.claim(first.messageId)).toBe(false);
  events.close();
  events = new EventStore(join(root, 'events.db'));
  expect(events.agentCommunication.read('b', first.messageId).status).toBe('uncertain');
  expect(events.agentCommunication.inbox('b').messages.map((m) => m.messageId)).toEqual([
    first.messageId,
  ]);
  expect(events.agentCommunication.inbox('c').messages).toEqual([]);
  expect(JSON.stringify(events.agentCommunication.read('b', first.messageId))).not.toContain(
    'signed-operator',
  );
  expect(JSON.stringify(events.agentCommunication.read('b', first.messageId))).not.toContain(
    'native-a-turn',
  );
});

it('correlates an explicit reply with its original participants and never manufactures a further delivery', () => {
  const events = new EventStore(':memory:');
  cleanups.push(() => events.close());
  for (const id of ['a', 'b', 'c']) events.upsertSession({ sessionId: id });
  const first = events.agentCommunication.reserve(
    'a',
    'operator',
    { turnId: 'turn', callId: 'call' },
    { requestId: randomUUID(), recipientConversationId: 'b', text: 'Question' },
  );
  expect(() =>
    events.agentCommunication.reserve(
      'c',
      'operator',
      { turnId: 'other', callId: 'other' },
      {
        requestId: randomUUID(),
        recipientConversationId: 'a',
        text: 'Forged reply',
        replyTo: first.messageId,
      },
    ),
  ).toThrow(/reply/);
  const reply = events.agentCommunication.reserve(
    'b',
    'operator',
    { turnId: 'reply-turn', callId: 'reply-call' },
    {
      requestId: randomUUID(),
      recipientConversationId: 'a',
      text: 'Answer',
      replyTo: first.messageId,
    },
  );
  expect(reply.replyTo).toBe(first.messageId);
  expect(events.agentCommunication.inbox('a').messages).toHaveLength(1);
  expect(events.agentCommunication.inbox('b').messages).toHaveLength(1);
});
