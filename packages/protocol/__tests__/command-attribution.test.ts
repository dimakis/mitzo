import { expect, it } from 'vitest';
import { storedEventToClientMessage } from '../src/stored-event-wire.js';
it.each([1, 2])(
  'projects only safe reply identity from version %i durable provider mapping',
  (version) => {
    const wire = storedEventToClientMessage({
      seq: 4,
      sessionId: 'chat',
      type: 'ordinary_reply_source',
      payload: {
        version,
        executionFingerprint: 'secret-execution',
        commandId: 'request-a',
        messageId: 'reply-a',
        providerThreadId: 'secret-thread',
        providerTurnId: 'secret-turn',
        extra: 'secret',
      },
    });
    expect(wire).toMatchObject({ messageId: 'reply-a', replyToMessageId: 'request-a' });
    expect(JSON.stringify(wire)).not.toContain('secret');
  },
);

it.each([0, 3])('does not project reply identity from unknown mapping version %i', (version) => {
  const wire = storedEventToClientMessage({
    seq: 4,
    sessionId: 'chat',
    type: 'ordinary_reply_source',
    payload: {
      version,
      commandId: 'request-a',
      messageId: 'reply-a',
      executionFingerprint: 'secret',
    },
  });
  expect(wire.messageId).toBeUndefined();
  expect(wire.replyToMessageId).toBeUndefined();
  expect(JSON.stringify(wire)).not.toContain('secret');
});
