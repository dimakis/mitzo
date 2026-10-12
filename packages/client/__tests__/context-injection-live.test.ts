import { describe, expect, it } from 'vitest';
import { INITIAL_MESSAGES_STATE, messagesReducer } from '../src/slices/messages.js';

const text = 'What state are my Strats in?';
const expanded = `The user has attached the following reference files for this message.\nUse them to inform your response.\n\n<context name="Jira Essentials" source="routing.md">\nUse the maintained Jira command.\n</context>\n\n---CONTEXT_END---\n${text}`;

describe('live and replay context disclosure', () => {
  it('shows selection immediately and enriches the optimistic message on echo without replacing its prompt', () => {
    const selected = messagesReducer(INITIAL_MESSAGES_STATE, {
      type: 'USER_SEND',
      clientMsgId: 'user-1',
      text,
      contextBlocks: ['Jira Essentials'],
      images: ['image-preview'],
    });
    expect(selected.messages[0].contextBlocks).toEqual(['Jira Essentials']);
    const echoed = messagesReducer(selected, {
      type: 'USER_MESSAGE_RECEIVED',
      messageId: 'user-1',
      text: expanded,
      contextBlocks: ['Jira Essentials'],
    });
    expect(echoed.messages).toHaveLength(1);
    expect(echoed.messages[0].blocks[0].content).toBe(text);
    expect(echoed.messages[0].images).toEqual(['image-preview']);
    expect(echoed.messages[0].contextInjections).toEqual([
      {
        name: 'Jira Essentials',
        source: 'routing.md',
        content: 'Use the maintained Jira command.',
      },
    ]);
  });

  it('gives observers and restored history the same short prompt and context content', () => {
    const echo = messagesReducer(INITIAL_MESSAGES_STATE, {
      type: 'USER_MESSAGE_RECEIVED',
      messageId: 'user-1',
      text: expanded,
      contextBlocks: ['Jira Essentials'],
    });
    const replay = messagesReducer(INITIAL_MESSAGES_STATE, {
      type: 'RESTORE',
      messages: [
        {
          messageId: 'user-1',
          role: 'user',
          contextBlocks: ['Jira Essentials'],
          blocks: [{ blockId: 'text', blockType: 'text', content: expanded }],
        },
      ],
    });
    for (const message of [echo.messages[0], replay.messages[0]]) {
      expect(message.blocks[0].content).toBe(text);
      expect(message.contextInjections?.[0].content).toBe('Use the maintained Jira command.');
    }
  });

  it('enriches an already visible optimistic message when history supplies its context', () => {
    const selected = messagesReducer(INITIAL_MESSAGES_STATE, {
      type: 'USER_SEND',
      clientMsgId: 'user-1',
      text,
      contextBlocks: ['Jira Essentials'],
    });
    const replay = messagesReducer(selected, {
      type: 'RESTORE',
      messages: [
        {
          messageId: 'user-1',
          role: 'user',
          blocks: [{ blockId: 'text', blockType: 'text', content: expanded }],
        },
      ],
    });
    expect(replay.messages).toHaveLength(1);
    expect(replay.messages[0].contextInjections?.[0].content).toBe(
      'Use the maintained Jira command.',
    );
    expect(replay.messages[0].blocks[0].content).toBe(text);
  });
});
