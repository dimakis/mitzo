import { expect, it } from 'vitest';
import { storedEventToClientMessage } from '../src/stored-event-wire.js';
it('projects only safe reply identity from the durable provider mapping', () => {
  const wire = storedEventToClientMessage({
    seq: 4,
    sessionId: 'chat',
    type: 'ordinary_reply_source',
    payload: {
      version: 1,
      commandId: 'request-a',
      messageId: 'reply-a',
      providerThreadId: 'secret-thread',
      providerTurnId: 'secret-turn',
      extra: 'secret',
    },
  });
  expect(wire).toMatchObject({ messageId: 'reply-a', replyToMessageId: 'request-a' });
  expect(JSON.stringify(wire)).not.toContain('secret');
});
