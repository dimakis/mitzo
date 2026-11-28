import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { discussionMaterial } from '../collaboration-application-messaging.js';

const prompt = 'A long operator prompt '.repeat(200);
const base = {
  sequence: 2,
  author: { sessionId: 'agent' },
  text: 'Agent reply',
  source: { conversationId: 'agent', commandId: 'command' },
} as unknown as Parameters<typeof discussionMaterial>[0];
const quote = { messageId: 'prompt', role: 'user' as const, text: prompt };

it('does not repeat an agent reply projection prompt in later agent history', () => {
  const material = discussionMaterial({
    ...base,
    replyToDeliveryId: randomUUID(),
    inReplyTo: quote,
  } as Parameters<typeof discussionMaterial>[0]);
  expect(material).not.toHaveProperty('inReplyTo');
  expect(JSON.stringify(material)).not.toContain(prompt);
});

it('keeps an explicit operator quote reply as discussion context', () => {
  const material = discussionMaterial({
    ...base,
    author: 'operator',
    replyToDeliveryId: null,
    inReplyTo: quote,
  } as Parameters<typeof discussionMaterial>[0]);
  expect(material).toMatchObject({ inReplyTo: quote });
});
