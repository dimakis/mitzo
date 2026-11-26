import { afterAll, expect, it } from 'vitest';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createApplicationJourney } from './fixtures/symposium-application-journey.js';
import { SdkUserSteering } from '../sdk-user-steering.js';

const journey = createApplicationJourney();
afterAll(() => journey.close());

it('retains an acknowledged active-turn correction through durable capture and reviewed joining', async () => {
  const h = await journey.getApplicationUiJourney();
  const sessionId = 'existing-chat';
  const start = h.events.append(sessionId, 'message_start', { messageId: 'answer' });
  h.events.append(sessionId, 'block_start', {
    messageId: 'answer',
    blockId: 'text',
    blockType: 'text',
  });
  h.events.append(sessionId, 'block_delta', {
    messageId: 'answer',
    blockId: 'text',
    delta: 'Before correction. ',
  });
  let submitted: SDKUserMessage | undefined;
  const query = {};
  const steering = new SdkUserSteering({
    events: h.events,
    sessionId,
    operator: 'operator',
    assertCurrent() {},
    activeCommandId: () => 'selected-source',
    push: (input) => {
      submitted = input;
    },
  });
  const input = {
    requestId: crypto.randomUUID(),
    targetCommandId: 'selected-source',
    text: 'Use the corrected requirement.',
  };
  await steering.steer(input, () => {});
  expect(steering.beforeInput(submitted!, true, query)).toBe(true);
  expect(steering.observe({ ...submitted! }, query)).toBe(true);
  expect(await steering.steer(input, () => {})).toEqual({ status: 'accepted' });
  h.events.append(sessionId, 'block_delta', {
    messageId: 'answer',
    blockId: 'text',
    delta: 'After correction.',
  });
  h.events.append(sessionId, 'block_end', { messageId: 'answer', blockId: 'text' });
  const end = h.events.append(sessionId, 'message_end', { messageId: 'answer' });

  const source = await h.typedApi.getDurableSessionTranscript(sessionId);
  // Frozen messages retain completion anchors; the start and correction target
  // make overlap explicit without reordering or changing older source pins.
  expect(source.messages.map((message) => message.messageId)).toEqual([
    'selected-source',
    input.requestId,
    'answer',
  ]);
  expect(source.messages[1]).toMatchObject({
    author: 'operator',
    steersMessageId: 'selected-source',
    blocks: [{ content: input.text }],
  });
  expect(source.messages[2]).toMatchObject({
    author: { sessionId },
    sequence: end,
    startedAtSequence: start,
    blocks: [{ content: 'Before correction. After correction.' }],
  });
  const joinedSessionId = await journey.joinReviewedParticipant(
    {
      accountId: 'offline-personal',
      harness: 'codex',
      targetId: 'offline-observation',
    },
    source,
  );
  expect(joinedSessionId).not.toBe(h.joinedSessionId);
  expect(journey.state.reviewedSnapshot!.messages).toEqual(source.messages);
  expect(h.events.getOrdinaryInitialCommandId(joinedSessionId)).toBeUndefined();
}, 30000);

it('refuses an unqualified overlap at reviewed joining with an actionable diagnostic', async () => {
  const h = await journey.getApplicationUiJourney();
  const sessionId = 'existing-chat';
  const previous = h.events.getDurableSessionTranscript(sessionId);
  h.events.append(sessionId, 'message_start', { messageId: 'corrupt-answer' });
  h.events.append(sessionId, 'block_start', {
    messageId: 'corrupt-answer',
    blockId: 'text',
    blockType: 'text',
  });
  h.events.append(sessionId, 'user_message', { messageId: 'unqualified-overlap', text: 'PRIVATE' });
  h.events.append(sessionId, 'block_end', { messageId: 'corrupt-answer', blockId: 'text' });
  const end = h.events.append(sessionId, 'message_end', { messageId: 'corrupt-answer' });
  // The UI boundary is only a selector; the real review owner must independently
  // validate retained events before accepting any source or allocating a seat.
  const before = await h.api.view(h.group);
  await expect(
    journey.joinReviewedParticipant(
      {
        accountId: 'offline-personal',
        harness: 'codex',
        targetId: 'offline-observation',
      },
      { ...previous, boundary: { sequence: end, messageId: 'corrupt-answer' } },
    ),
  ).rejects.toThrow('overlapping messages');
  expect((await h.api.view(h.group)).membershipRevision).toBe(before.membershipRevision);
}, 30000);
