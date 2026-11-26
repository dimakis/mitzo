import { expect, it } from 'vitest';
import { messagesReducer, INITIAL_MESSAGES_STATE } from '../slices/messages.js';

// The server's notice for an unconfirmed tool effect arrives as an ordinary
// `error` event (see server/uncertain-operations-notice.ts). The phone must keep
// it as a visible transcript entry, never drop it or present it as success.
const notice =
  'Outcome unknown for: TelosCreateChild (request ID req-9). It may or may not have taken effect, ' +
  'and nothing was replayed. Next safe step: ask the agent to read the current state, or to re-run ' +
  'the same call with the same request ID. Do not use a new ID.';

it('shows the uncertain operation, its original request ID and the next safe step in the transcript', () => {
  let state = messagesReducer(INITIAL_MESSAGES_STATE, {
    type: 'USER_MESSAGE_RECEIVED',
    messageId: 'u1',
    text: 'Create the child item',
    startedSeq: 1,
  });
  state = messagesReducer(state, { type: 'ERROR', error: notice });
  const entry = state.messages.at(-1)!;
  expect(entry.role).toBe('assistant');
  const text = entry.blocks.map((block) => ('content' in block ? block.content : '')).join('\n');
  expect(text).toContain('TelosCreateChild');
  expect(text).toContain('request ID req-9');
  expect(text).toContain('same request ID');
  expect(text).toContain('Do not use a new ID');
  expect(text).not.toMatch(/succeeded|completed successfully/i);
  // The turn is over, not hidden: the chat accepts the next message.
  expect(state.running).toBe(false);
  state = messagesReducer(state, {
    type: 'USER_MESSAGE_RECEIVED',
    messageId: 'u2',
    text: 'Read the item state',
    startedSeq: 2,
  });
  expect(state.messages.map((m) => m.messageId)).toContain('u2');
  expect(
    state.messages.some((m) => m.blocks.some((b) => 'content' in b && b.content.includes('req-9'))),
  ).toBe(true);
});
