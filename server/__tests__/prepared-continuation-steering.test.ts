import { expect, it } from 'vitest';
import type { StoredEvent } from '@mitzo/protocol';
import { replayEventsToTranscript } from '../conversation-transcript.js';
import { MitzoApiClient } from '../../packages/client/src/api-client.js';
import {
  INITIAL_MESSAGES_STATE,
  messagesReducer,
} from '../../packages/client/src/slices/messages.js';
import {
  activeSteeringCommandId,
  restoreTranscriptCommandStates,
} from '../../packages/client/src/command-attribution.js';

it('restores the exact active repository continuation without inventing a user message', async () => {
  const continuation = `prepared-repository-${'a'.repeat(64)}`;
  const events: StoredEvent[] = [];
  const add = (type: string, payload: Record<string, unknown>) =>
    events.push({ type, payload, seq: events.length + 1, sessionId: 'chat', createdAt: 0 });
  add('user_message', { messageId: 'original', text: 'Continue in the prepared checkout' });
  add('ordinary_provider_dispatch_started', { messageId: 'original' });
  add('ordinary_command_completed', { messageId: 'original', status: 'completed' });
  add('ordinary_provider_dispatch_started', { messageId: continuation });
  add('ordinary_reply_source', { version: 1, messageId: 'answer', commandId: continuation });
  add('message_start', { messageId: 'answer' });
  const transcript = replayEventsToTranscript(events);
  const wire = await new MitzoApiClient(async () => Response.json(transcript)).getSessionTranscript(
    'chat',
  );
  const restored = restoreTranscriptCommandStates(
    messagesReducer(INITIAL_MESSAGES_STATE, { type: 'RESTORE', messages: wire.messages }),
    wire.commandStates,
  );
  expect(restored.messages.filter((message) => message.role === 'user')).toHaveLength(1);
  expect(activeSteeringCommandId(restored)).toBe(continuation);
  add('ordinary_command_completed', { messageId: continuation, status: 'interrupted' });
  const stopped = replayEventsToTranscript(events);
  expect(
    activeSteeringCommandId(restoreTranscriptCommandStates(restored, stopped.commandStates)),
  ).toBeUndefined();
});

it('keeps newer live terminal evidence when a transcript prefix still says running', () => {
  const live = messagesReducer(INITIAL_MESSAGES_STATE, {
    type: 'COMMAND_STATE',
    messageId: 'continuation',
    commandState: 'interrupted',
    seq: 20,
  });
  const restored = restoreTranscriptCommandStates(live, [
    { messageId: 'continuation', state: 'running', seq: 10 },
  ]);
  expect(activeSteeringCommandId(restored)).toBeUndefined();
  expect(restored.commandStates?.continuation).toBe('interrupted');
});

it('refuses an ambiguous active target', () => {
  let state = messagesReducer(INITIAL_MESSAGES_STATE, {
    type: 'COMMAND_STATE',
    messageId: 'first',
    commandState: 'running',
    seq: 1,
  });
  state = messagesReducer(state, {
    type: 'COMMAND_STATE',
    messageId: 'second',
    commandState: 'running',
    seq: 2,
  });
  expect(activeSteeringCommandId(state)).toBeUndefined();
});
