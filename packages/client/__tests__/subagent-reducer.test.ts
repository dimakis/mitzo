import { describe, it, expect } from 'vitest';
import { messagesReducer, finishCurrent, INITIAL_MESSAGES_STATE } from '../src/slices/messages.js';
import type {
  StreamingBlock,
  StreamingSubagentState,
  FinishedSubagentState,
} from '@mitzo/protocol';

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

    const sub = newState.current?.blocks.get('b1')?.subagent as StreamingSubagentState;
    expect(sub).toBeDefined();
    expect(sub.messageId).toBe('msg-sub-1');
    expect(sub.running).toBe(true);
    expect(sub.blocks.size).toBe(0);
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

    const sub = newState.current?.blocks.get('b1')?.subagent as StreamingSubagentState;
    expect(sub.blocks.size).toBe(1);
    expect(sub.blockOrder).toEqual(['b-sub-1']);
    expect(sub.blocks.get('b-sub-1')?.blockType).toBe('thinking');
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

    const sub = newState.current?.blocks.get('b1')?.subagent as StreamingSubagentState;
    expect(sub.blocks.get('b-sub-1')?.content).toBe('Hello world');
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

    const sub = newState.current?.blocks.get('b1')?.subagent as StreamingSubagentState;
    expect(sub.blocks.get('b-sub-1')?.done).toBe(true);
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

    const sub = newState.current?.blocks.get('b1')?.subagent as StreamingSubagentState;
    expect(sub.blocks.get('b-sub-2')?.toolResult).toBe('file contents');
    expect(sub.blocks.get('b-sub-2')?.toolError).toBe(false);
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

    const sub = newState.current?.blocks.get('b1')?.subagent as FinishedSubagentState;
    expect(sub.running).toBeUndefined();
    expect(Array.isArray(sub.blocks)).toBe(true);
    expect(sub.summary).toBe('Search complete');
    expect(sub.usage?.inputTokens).toBe(100);
  });

  it('finishCurrent converts already-finished subagent via passthrough', () => {
    // Simulate full lifecycle: SUBAGENT_START → blocks → SUBAGENT_END → MESSAGE_END
    let state = {
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

    // End the subagent first
    state = messagesReducer(state, {
      type: 'SUBAGENT_END',
      parentBlockId: 'b1',
      summary: 'All done',
    });

    // Now finish the message — finishSubagent should passthrough the already-finished state
    const finished = finishCurrent(state.current!);
    const sub = finished.blocks[0].subagent as FinishedSubagentState;
    expect(sub).toBeDefined();
    expect(Array.isArray(sub.blocks)).toBe(true);
    expect(sub.blocks).toHaveLength(1);
    expect(sub.blocks[0].content).toBe('Done');
    expect(sub.summary).toBe('All done');
  });

  it('finishCurrent converts still-streaming subagent to finished', () => {
    // Edge case: MESSAGE_END arrives without SUBAGENT_END
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
                      content: 'Partial',
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

    // Finish message without SUBAGENT_END — finishSubagent must convert Map→array
    const finished = finishCurrent(state.current!);
    const sub = finished.blocks[0].subagent as FinishedSubagentState;
    expect(sub).toBeDefined();
    expect(Array.isArray(sub.blocks)).toBe(true);
    expect(sub.blocks).toHaveLength(1);
    expect(sub.blocks[0].content).toBe('Partial');
    expect(sub.summary).toBeUndefined();
  });
});
