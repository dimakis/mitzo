import { describe, expect, it } from 'vitest';
import { parseServerMessage } from '../src/protocol-parser.js';
import { INITIAL_MESSAGES_STATE, messagesReducer } from '../src/slices/messages.js';

const provenance = (seatId: string, generation = 1) => ({
  version: 2 as const,
  seatId,
  seatLabel: seatId === 'architect' ? 'Original Architect' : 'Original Reviewer',
  seatRole: seatId === 'architect' ? 'architect' : 'reviewer',
  configRevision: 1,
  membershipGeneration: generation,
  capturedAt: 100,
  accountBinding: {
    accountId: `account-${seatId}`,
    accountLabel: `Account ${seatId}`,
    provider: 'openai-codex' as const,
    model: `model-${seatId}`,
    profileRevision: `account-rev-${seatId}`,
  },
  reasoningEffort: 'high',
  profileBinding: { profileId: `profile-${seatId}`, profileRevision: `seat-rev-${seatId}` },
  contextGrant: { grantId: `context-${seatId}`, revision: 1 },
  authorityGrant: { grantId: `authority-${seatId}`, revision: 1 },
  accountProfileRevision: `account-rev-${seatId}`,
  seatProfileRevision: `seat-rev-${seatId}`,
  contextGrantRevision: 1,
  authorityGrantRevision: 1,
  isolationDomainId: 'shared',
  isolationDomainRevision: 1,
});

const callbacks = { onSessionAssigned: () => {}, onSessionExpired: () => {} };

function reduceWire(state: typeof INITIAL_MESSAGES_STATE, event: Record<string, unknown>) {
  const parsed = parseServerMessage(
    event as { type: string },
    { currentSessionId: 'conversation' },
    callbacks,
    'conversation',
  );
  expect(parsed.resyncRequired).toBeFalsy();
  return parsed.messagesActions.reduce(messagesReducer, state);
}

describe('concurrent Symposium streams', () => {
  it('keeps two seats with the same block IDs and nested subagent IDs independent', () => {
    let state = INITIAL_MESSAGES_STATE;
    state = messagesReducer(state, { type: 'SESSION_STATE_CHANGED', state: 'running' });
    const architect = provenance('architect');
    const reviewer = provenance('reviewer');
    const event = (type: string, seat: typeof architect, extra: Record<string, unknown>) => ({
      type,
      seatId: seat.seatId,
      symposiumProvenance: seat,
      ...extra,
    });
    state = reduceWire(state, event('message_start', architect, { messageId: 'architect-msg' }));
    state = reduceWire(state, event('message_start', reviewer, { messageId: 'reviewer-msg' }));
    for (const [seat, messageId] of [
      [architect, 'architect-msg'],
      [reviewer, 'reviewer-msg'],
    ] as const) {
      state = reduceWire(
        state,
        event('block_start', seat, {
          messageId,
          blockId: 'b0',
          blockType: 'tool_use',
          toolName: 'Task',
        }),
      );
      state = reduceWire(
        state,
        event('block_end', seat, {
          messageId,
          blockId: 'b0',
          blockType: 'tool_use',
          toolId: 'task-0',
        }),
      );
      state = reduceWire(
        state,
        event('subagent_start', seat, { parentBlockId: 'b0', subagentMessageId: 'sub-0' }),
      );
      state = reduceWire(
        state,
        event('subagent_block_start', seat, {
          parentBlockId: 'b0',
          blockId: 'b1',
          blockType: 'text',
        }),
      );
      state = reduceWire(
        state,
        event('subagent_block_delta', seat, {
          parentBlockId: 'b0',
          blockId: 'b1',
          delta: seat.seatId,
        }),
      );
      state = reduceWire(
        state,
        event('tool_result', seat, { toolId: 'task-0', result: `${seat.seatId} result` }),
      );
    }
    expect(state.currentByMessage['architect-msg'].blocks.get('b0')?.subagent).toMatchObject({
      blocks: new Map([['b1', expect.objectContaining({ content: 'architect' })]]),
    });
    expect(state.currentByMessage['reviewer-msg'].blocks.get('b0')?.subagent).toMatchObject({
      blocks: new Map([['b1', expect.objectContaining({ content: 'reviewer' })]]),
    });
    expect(state.currentByMessage['architect-msg'].blocks.get('b0')?.toolResult).toBe(
      'architect result',
    );
    expect(state.currentByMessage['reviewer-msg'].blocks.get('b0')?.toolResult).toBe(
      'reviewer result',
    );
    state = reduceWire(state, event('session_end', architect, {}));
    expect(state.messages[0].symposiumProvenance).toEqual(architect);
    expect(state.currentByMessage['architect-msg']).toBeUndefined();
    expect(state.currentByMessage['reviewer-msg']).toBeDefined();
    expect(state.running).toBe(true);
    state = reduceWire(
      state,
      event('subagent_block_delta', reviewer, {
        parentBlockId: 'b0',
        blockId: 'b1',
        delta: '-continued',
      }),
    );
    const remaining = state.currentByMessage['reviewer-msg'].blocks.get('b0')?.subagent;
    expect(
      remaining && 'blocks' in remaining && remaining.blocks instanceof Map
        ? remaining.blocks.get('b1')?.content
        : null,
    ).toBe('reviewer-continued');
    state = reduceWire(state, event('message_end', reviewer, { messageId: 'reviewer-msg' }));
    expect(state.messages.map((message) => message.messageId)).toEqual([
      'architect-msg',
      'reviewer-msg',
    ]);
  });

  it('refuses mismatched envelopes and stale membership generations without relabeling history', () => {
    const original = provenance('reviewer');
    const mismatch = parseServerMessage(
      {
        type: 'message_start',
        messageId: 'm1',
        seatId: 'architect',
        symposiumProvenance: original,
      },
      { currentSessionId: 'conversation' },
      callbacks,
      'conversation',
    );
    expect(mismatch.resyncRequired).toBe(true);
    expect(mismatch.messagesActions).toEqual([]);
    let state = reduceWire(INITIAL_MESSAGES_STATE, {
      type: 'message_start',
      messageId: 'm1',
      seatId: 'reviewer',
      symposiumProvenance: original,
    });
    state = reduceWire(state, {
      type: 'block_start',
      messageId: 'm1',
      blockId: 'b0',
      blockType: 'text',
      seatId: 'reviewer',
      symposiumProvenance: original,
    });
    const stale = messagesReducer(state, {
      type: 'BLOCK_DELTA',
      messageId: 'm1',
      blockId: 'b0',
      blockType: 'text',
      delta: 'late',
      symposiumProvenance: provenance('reviewer', 2),
    });
    expect(stale.resyncRequired).toBe(true);
    expect(stale.currentByMessage['m1'].blocks.get('b0')?.content).toBe('');
    expect(stale.currentByMessage['m1'].symposiumProvenance).toEqual(original);
    const relabel = messagesReducer(state, {
      type: 'BLOCK_DELTA',
      messageId: 'm1',
      blockId: 'b0',
      blockType: 'text',
      delta: 'forged',
      symposiumProvenance: {
        ...original,
        accountBinding: { ...original.accountBinding, model: 'forged-model' },
      },
    });
    expect(relabel.resyncRequired).toBe(true);
    expect(relabel.currentByMessage['m1'].symposiumProvenance).toEqual(original);
    expect(relabel.currentByMessage['m1'].blocks.get('b0')?.content).toBe('');
    const restored = messagesReducer(stale, { type: 'RESTORE', messages: [] });
    expect(restored.resyncRequired).toBe(false);
    expect(restored.currentByMessage).toEqual({});
  });

  it('refuses a second same-seat snapshot while the first turn is active', () => {
    const reviewer = provenance('reviewer');
    const state = reduceWire(INITIAL_MESSAGES_STATE, {
      type: 'message_start',
      messageId: 'first',
      seatId: 'reviewer',
      symposiumProvenance: reviewer,
    });
    const next = messagesReducer(state, {
      type: 'MESSAGE_SNAPSHOT',
      messageId: 'second',
      blocks: [],
      symposiumProvenance: reviewer,
    });
    expect(next.resyncRequired).toBe(true);
    expect(Object.keys(next.currentByMessage)).toEqual(['first']);
  });
});
