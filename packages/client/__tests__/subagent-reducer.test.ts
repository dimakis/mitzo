import { describe, it, expect } from 'vitest';
import { messagesReducer, INITIAL_MESSAGES_STATE } from '../src/slices/messages.js';
import type { StreamingBlock } from '@mitzo/protocol';

describe('Subagent Reducer Actions', () => {
  it('SUBAGENT_START initializes subagent state on parent tool block', () => {
    const state = {
      ...INITIAL_MESSAGES_STATE,
      current: {
        messageId: 'msg-1',
        blocks: new Map<string, StreamingBlock>([
          [
            'b1',
            {
              blockId: 'b1',
              blockType: 'tool_use',
              content: '',
              done: true,
              toolName: 'Agent',
              toolId: 't1',
            },
          ],
        ]),
        blockOrder: ['b1'],
      },
    };

    const action = {
      type: 'SUBAGENT_START' as const,
      parentBlockId: 'b1',
      subagentMessageId: 'msg-sub-1',
    };

    const newState = messagesReducer(state, action);

    expect(newState.current?.blocks.get('b1')?.subagent).toBeDefined();
    expect(newState.current?.blocks.get('b1')?.subagent?.messageId).toBe('msg-sub-1');
    expect(newState.current?.blocks.get('b1')?.subagent?.running).toBe(true);
    expect(newState.current?.blocks.get('b1')?.subagent?.blocks.size).toBe(0);
  });

  it('SUBAGENT_BLOCK_START adds block to subagent state', () => {
    const state = {
      ...INITIAL_MESSAGES_STATE,
      current: {
        messageId: 'msg-1',
        blocks: new Map<string, StreamingBlock>([
          [
            'b1',
            {
              blockId: 'b1',
              blockType: 'tool_use',
              content: '',
              done: true,
              toolName: 'Agent',
              toolId: 't1',
              subagent: {
                messageId: 'msg-sub-1',
                blocks: new Map(),
                blockOrder: [],
                running: true as const,
              },
            },
          ],
        ]),
        blockOrder: ['b1'],
      },
    };

    const action = {
      type: 'SUBAGENT_BLOCK_START' as const,
      parentBlockId: 'b1',
      blockId: 'b-sub-1',
      blockType: 'thinking' as const,
    };

    const newState = messagesReducer(state, action);

    expect(newState.current?.blocks.get('b1')?.subagent?.blocks.size).toBe(1);
    expect(newState.current?.blocks.get('b1')?.subagent?.blockOrder).toEqual(['b-sub-1']);
    expect(newState.current?.blocks.get('b1')?.subagent?.blocks.get('b-sub-1')?.blockType).toBe(
      'thinking',
    );
  });

  it('SUBAGENT_BLOCK_DELTA appends to subagent block content', () => {
    const state = {
      ...INITIAL_MESSAGES_STATE,
      current: {
        messageId: 'msg-1',
        blocks: new Map<string, StreamingBlock>([
          [
            'b1',
            {
              blockId: 'b1',
              blockType: 'tool_use',
              content: '',
              done: true,
              toolName: 'Agent',
              toolId: 't1',
              subagent: {
                messageId: 'msg-sub-1',
                blocks: new Map([
                  [
                    'b-sub-1',
                    {
                      blockId: 'b-sub-1',
                      blockType: 'text',
                      content: 'Hello',
                      done: false,
                    },
                  ],
                ]),
                blockOrder: ['b-sub-1'],
                running: true as const,
              },
            },
          ],
        ]),
        blockOrder: ['b1'],
      },
    };

    const action = {
      type: 'SUBAGENT_BLOCK_DELTA' as const,
      parentBlockId: 'b1',
      blockId: 'b-sub-1',
      delta: ' world',
    };

    const newState = messagesReducer(state, action);

    expect(newState.current?.blocks.get('b1')?.subagent?.blocks.get('b-sub-1')?.content).toBe(
      'Hello world',
    );
  });

  it('SUBAGENT_BLOCK_END marks subagent block as done', () => {
    const state = {
      ...INITIAL_MESSAGES_STATE,
      current: {
        messageId: 'msg-1',
        blocks: new Map<string, StreamingBlock>([
          [
            'b1',
            {
              blockId: 'b1',
              blockType: 'tool_use',
              content: '',
              done: true,
              toolName: 'Agent',
              toolId: 't1',
              subagent: {
                messageId: 'msg-sub-1',
                blocks: new Map([
                  [
                    'b-sub-1',
                    {
                      blockId: 'b-sub-1',
                      blockType: 'text',
                      content: 'Done',
                      done: false,
                    },
                  ],
                ]),
                blockOrder: ['b-sub-1'],
                running: true as const,
              },
            },
          ],
        ]),
        blockOrder: ['b1'],
      },
    };

    const action = {
      type: 'SUBAGENT_BLOCK_END' as const,
      parentBlockId: 'b1',
      blockId: 'b-sub-1',
    };

    const newState = messagesReducer(state, action);

    expect(newState.current?.blocks.get('b1')?.subagent?.blocks.get('b-sub-1')?.done).toBe(true);
  });

  it('SUBAGENT_TOOL_RESULT patches tool result in subagent block', () => {
    const state = {
      ...INITIAL_MESSAGES_STATE,
      current: {
        messageId: 'msg-1',
        blocks: new Map<string, StreamingBlock>([
          [
            'b1',
            {
              blockId: 'b1',
              blockType: 'tool_use',
              content: '',
              done: true,
              toolName: 'Agent',
              toolId: 't1',
              subagent: {
                messageId: 'msg-sub-1',
                blocks: new Map([
                  [
                    'b-sub-2',
                    {
                      blockId: 'b-sub-2',
                      blockType: 'tool_use',
                      content: '',
                      done: true,
                      toolName: 'Read',
                      toolId: 'tool-read-1',
                    },
                  ],
                ]),
                blockOrder: ['b-sub-2'],
                running: true as const,
              },
            },
          ],
        ]),
        blockOrder: ['b1'],
      },
    };

    const action = {
      type: 'SUBAGENT_TOOL_RESULT' as const,
      parentBlockId: 'b1',
      toolId: 'tool-read-1',
      result: 'file contents',
      isError: false,
    };

    const newState = messagesReducer(state, action);

    expect(newState.current?.blocks.get('b1')?.subagent?.blocks.get('b-sub-2')?.toolResult).toBe(
      'file contents',
    );
    expect(newState.current?.blocks.get('b1')?.subagent?.blocks.get('b-sub-2')?.toolError).toBe(
      false,
    );
  });

  it('SUBAGENT_END finalizes subagent state with summary and usage', () => {
    const state = {
      ...INITIAL_MESSAGES_STATE,
      current: {
        messageId: 'msg-1',
        blocks: new Map<string, StreamingBlock>([
          [
            'b1',
            {
              blockId: 'b1',
              blockType: 'tool_use',
              content: '',
              done: true,
              toolName: 'Agent',
              toolId: 't1',
              subagent: {
                messageId: 'msg-sub-1',
                blocks: new Map([
                  [
                    'b-sub-1',
                    {
                      blockId: 'b-sub-1',
                      blockType: 'text',
                      content: 'Result',
                      done: true,
                    },
                  ],
                ]),
                blockOrder: ['b-sub-1'],
                running: true as const,
              },
            },
          ],
        ]),
        blockOrder: ['b1'],
      },
    };

    const action = {
      type: 'SUBAGENT_END' as const,
      parentBlockId: 'b1',
      summary: 'Search complete',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    };

    const newState = messagesReducer(state, action);

    const subagent = newState.current?.blocks.get('b1')?.subagent;
    expect(subagent?.running).toBeUndefined();
    expect(Array.isArray(subagent?.blocks)).toBe(true);
    expect(subagent?.summary).toBe('Search complete');
    expect(subagent?.usage?.inputTokens).toBe(100);
  });
});
