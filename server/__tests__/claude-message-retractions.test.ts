import { expect, it } from 'vitest';
import { ClaudeMessageRetractions } from '../claude-message-retractions.js';
import { projectMessageRetractions, RETRACTED_TOOL_RESULT } from '@mitzo/protocol';
import { parseServerMessage } from '../../packages/client/src/protocol-parser.js';
import {
  INITIAL_MESSAGES_STATE,
  messagesReducer,
} from '../../packages/client/src/slices/messages.js';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const receipt = '33333333-3333-4333-8333-333333333333';
const assistant = (uuid = first, id = 'old') => ({
  type: 'assistant',
  session_id: 'session',
  parent_tool_use_id: null,
  uuid,
  message: { id },
});
const retract = (ids: unknown = [first]) => ({
  type: 'system',
  subtype: 'model_refusal_fallback',
  session_id: 'session',
  uuid: receipt,
  retracted_message_uuids: ids,
});
const owners = new Map([['tool', 'old']]);

it('refuses whole-response retraction after observing any frame without a wire UUID', () => {
  const owner = new ClaudeMessageRetractions();
  owner.observe({ ...assistant(), uuid: undefined }, 'session', 'old', owners);
  owner.observe(assistant(), 'session', 'old', owners);
  expect(owner.observe(retract(), 'session', 'next', owners)).toEqual({
    targets: [],
    unavailable: true,
  });
});

it('keeps conflict quarantine and incomplete-message caches bounded', () => {
  const owner = new ClaudeMessageRetractions();
  for (let n = 0; n < 1024; n++) {
    const id = `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
    owner.observe(assistant(id, `first-${n}`), 'session', `first-${n}`, owners);
    owner.observe(assistant(id, `conflict-${n}`), 'session', `conflict-${n}`, owners);
  }
  const caches = owner as unknown as { retracted: Set<string>; incompleteMessages: Set<string> };
  expect(caches.retracted.size).toBeLessThanOrEqual(512);
  expect(caches.incompleteMessages.size).toBeLessThanOrEqual(512);
});

it.each(['binding', 'conflict'])('does not rebind a forgotten UUID after %s overflow', (kind) => {
  const owner = new ClaudeMessageRetractions();
  for (let n = 0; n < 513; n++) {
    const id = `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
    owner.observe(assistant(id, `first-${n}`), 'session', `first-${n}`, owners);
    if (kind === 'conflict')
      owner.observe(assistant(id, `conflict-${n}`), 'session', `conflict-${n}`, owners);
  }
  const forgotten = '11111111-1111-4111-8111-000000000000';
  owner.observe(assistant(forgotten, 'new-aggregate'), 'session', 'new-aggregate', owners);
  expect(owner.observe(retract([forgotten]), 'session', 'next', owners)).toEqual({
    targets: [],
    unavailable: true,
  });
  owner.observe({ type: 'result', session_id: 'session' }, 'session', null, owners);
  owner.observe(assistant(), 'session', 'old', owners);
  expect(owner.observe(retract(), 'session', 'next', owners)).toEqual({
    targets: [{ messageId: 'old' }],
    unavailable: false,
  });
});

it('maps wire UUID to the observed API message ID and deduplicates the final receipt', () => {
  const owner = new ClaudeMessageRetractions();
  owner.observe(assistant(), 'session', 'old', owners);
  expect(
    owner.observe({ ...assistant(second, 'next'), supersedes: [first] }, 'session', 'next', owners),
  ).toEqual({ targets: [{ messageId: 'old' }], unavailable: false });
  expect(owner.observe(retract(), 'session', 'next', owners)).toEqual({
    targets: [],
    unavailable: false,
  });
});

it('binds a tool-result frame only to an observed message in the same uncompleted command', () => {
  const owner = new ClaudeMessageRetractions();
  owner.observe(assistant(), 'session', 'old', owners);
  const result = {
    type: 'user',
    session_id: 'session',
    uuid: second,
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'old result' }] },
  };
  owner.observe(result, 'session', 'old', owners);
  expect(owner.observe(retract([second]), 'session', 'next', owners).targets).toEqual([
    { messageId: 'old', toolId: 'tool' },
  ]);
  owner.observe({ type: 'result', session_id: 'session' }, 'session', null, owners);
  owner.observe(result, 'session', 'next', owners);
  expect(owner.observe(retract([second]), 'session', 'next', owners)).toEqual({
    targets: [],
    unavailable: true,
  });
});

it.each([{ session_id: 'foreign' }, { parent_tool_use_id: 'child' }])(
  'refuses foreign/child receipts %j without consuming the original mapping',
  (scope) => {
    const owner = new ClaudeMessageRetractions();
    owner.observe(assistant(), 'session', 'old', owners);
    expect(owner.observe({ ...retract(), ...scope }, 'session', 'next', owners).targets).toEqual(
      [],
    );
    expect(owner.observe(retract(), 'session', 'next', owners).targets).toEqual([
      { messageId: 'old' },
    ]);
  },
);

it.each([
  { ids: [second] },
  { ids: ['not-a-uuid'] },
  { ids: [receipt] },
  { ids: 'invalid' },
  { ids: Array(257).fill(first) },
])('reports unknown/malformed/self/oversized receipt %j without guessing', ({ ids }) => {
  const owner = new ClaudeMessageRetractions();
  owner.observe(assistant(), 'session', 'old', owners);
  expect(owner.observe(retract(ids), 'session', 'next', owners)).toEqual({
    targets: [],
    unavailable: true,
  });
});

it('does not bind an envelope to a different active public message or a conflicting UUID', () => {
  const owner = new ClaudeMessageRetractions();
  owner.observe(assistant(), 'session', 'different', owners);
  expect(owner.observe(retract(), 'session', 'different', owners)).toEqual({
    targets: [],
    unavailable: true,
  });
  owner.observe(assistant(), 'session', 'old', owners);
  expect(owner.observe(assistant(first, 'new'), 'session', 'new', owners).unavailable).toBe(true);
  expect(owner.observe(retract(), 'session', 'new', owners).targets).toEqual([]);
});

it('requires every observed wire fragment before retracting an aggregated API message', () => {
  const owner = new ClaudeMessageRetractions();
  owner.observe(assistant(), 'session', 'old', owners);
  owner.observe(assistant(second), 'session', 'old', owners);
  expect(owner.observe(retract([first]), 'session', 'next', owners)).toEqual({
    targets: [],
    unavailable: true,
  });
  expect(owner.observe(retract([first, second]), 'session', 'next', owners)).toEqual({
    targets: [{ messageId: 'old' }],
    unavailable: false,
  });
});

it('evicts bounded old wire mappings with an explicit unavailable result', () => {
  const owner = new ClaudeMessageRetractions();
  for (let n = 0; n < 513; n++) {
    const id = `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
    owner.observe(assistant(id, `message-${n}`), 'session', `message-${n}`, owners);
  }
  expect(
    owner.observe(retract(['11111111-1111-4111-8111-000000000000']), 'session', 'next', owners),
  ).toEqual({ targets: [], unavailable: true });
});

it('preserves user, attributed and host messages while removing response text and retaining tool activity', () => {
  const text = { blockId: 'text', blockType: 'text', content: 'refused text' };
  const tool = {
    blockId: 'call',
    blockType: 'tool_use',
    content: '',
    toolId: 'tool',
    toolResult: 'retracted result',
    toolError: true,
    toolResultImages: [{ id: 'image', mediaType: 'image/png' }],
  };
  const messages = [
    { messageId: 'old', role: 'assistant', blocks: [text, tool] },
    { messageId: 'old', role: 'user', blocks: [text] },
    {
      messageId: 'old',
      role: 'assistant',
      symposiumProvenance: { seatId: 'seat' },
      blocks: [text],
    },
    { messageId: 'old', role: 'assistant', agentMessage: { id: 'host-owned' }, blocks: [text] },
  ];
  const projected = projectMessageRetractions(messages, [
    { messageId: 'old' },
    { messageId: 'old', toolId: 'tool' },
  ]);
  expect(projected[0].blocks).toEqual(
    [
      {
        ...tool,
        toolResult: RETRACTED_TOOL_RESULT,
        toolError: undefined,
        toolResultImages: undefined,
      },
    ].map(({ toolError: _error, toolResultImages: _images, ...b }) => b),
  );
  expect(projected.slice(1)).toEqual(messages.slice(1));
  expect(messages[0].blocks[1]).toBe(tool);
});

it('keeps a live successor/running state and refuses stale restore or late content resurrection', () => {
  let state = messagesReducer(INITIAL_MESSAGES_STATE, { type: 'MESSAGE_START', messageId: 'old' });
  state = messagesReducer(state, {
    type: 'BLOCK_START',
    messageId: 'old',
    blockId: 'text',
    blockType: 'text',
  });
  state = messagesReducer(state, {
    type: 'BLOCK_DELTA',
    messageId: 'old',
    blockId: 'text',
    blockType: 'text',
    delta: 'old response',
  });
  state = messagesReducer(state, { type: 'MESSAGE_START', messageId: 'successor' });
  state = { ...state, running: true };
  state = messagesReducer(state, { type: 'MESSAGE_RETRACTED', messageId: 'old' });
  expect(state.current?.messageId).toBe('successor');
  expect(state.running).toBe(true);
  expect(state.messages).toEqual([]);
  state = messagesReducer(state, {
    type: 'RESTORE',
    messages: [
      {
        messageId: 'old',
        role: 'assistant',
        blocks: [{ blockId: 'text', blockType: 'text', content: 'stale restore' }],
      },
    ],
  });
  expect(JSON.stringify(state.messages)).not.toContain('stale restore');
  state = messagesReducer(state, { type: 'MESSAGE_START', messageId: 'old' });
  expect(state.current).toBeNull();
  expect(messagesReducer(state, { type: 'CLEAR' }).messageRetractions).toBeUndefined();
});

it.each([{ sessionId: 'foreign' }, { seatId: 'child' }, { messageId: '' }])(
  'requests authoritative resync for an invalid public retraction %j',
  (extra) => {
    expect(
      parseServerMessage(
        { type: 'message_retracted', sessionId: 'session', messageId: 'old', ...extra },
        { currentSessionId: 'session' },
        {} as never,
        'client',
      ),
    ).toEqual({ messagesActions: [], resyncRequired: true });
  },
);
