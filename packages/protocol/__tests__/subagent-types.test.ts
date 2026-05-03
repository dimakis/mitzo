import { describe, it, expect } from 'vitest';
import type { StreamingBlock, FinishedBlock, SubagentUsage, SubagentState } from '../src/types.js';

describe('Subagent Protocol Types', () => {
  it('StreamingBlock supports nested subagent state', () => {
    const block: StreamingBlock = {
      blockId: 'b1',
      blockType: 'tool_use',
      content: '',
      done: false,
      toolName: 'Agent',
      toolId: 't1',
      subagent: {
        messageId: 'msg-sub-1',
        blocks: new Map(),
        blockOrder: [],
        running: true,
      },
    };

    expect(block.subagent).toBeDefined();
    expect(block.subagent?.running).toBe(true);
    expect(block.subagent?.blocks).toBeInstanceOf(Map);
  });

  it('FinishedBlock supports nested subagent state', () => {
    const subBlock: FinishedBlock = {
      blockId: 'b-sub-1',
      blockType: 'text',
      content: 'Subagent output',
    };

    const block: FinishedBlock = {
      blockId: 'b1',
      blockType: 'tool_use',
      content: '',
      toolName: 'Agent',
      toolId: 't1',
      subagent: {
        messageId: 'msg-sub-1',
        blocks: [subBlock],
        summary: 'Completed search',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
    };

    expect(block.subagent).toBeDefined();
    expect(block.subagent?.blocks).toHaveLength(1);
    expect(block.subagent?.summary).toBe('Completed search');
    expect(block.subagent?.usage?.inputTokens).toBe(100);
  });

  it('SubagentUsage type has required token fields', () => {
    const usage: SubagentUsage = {
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 50,
      cacheCreationTokens: 25,
    };

    expect(usage.inputTokens).toBe(200);
    expect(usage.outputTokens).toBe(100);
    expect(usage.cacheReadTokens).toBe(50);
    expect(usage.cacheCreationTokens).toBe(25);
  });

  it('SubagentState supports streaming mode', () => {
    const state: SubagentState = {
      messageId: 'msg-sub-1',
      blocks: new Map([
        [
          'b1',
          {
            blockId: 'b1',
            blockType: 'thinking',
            content: 'Analyzing...',
            done: false,
          },
        ],
      ]),
      blockOrder: ['b1'],
      running: true,
    };

    expect(state.running).toBe(true);
    expect(state.blocks.size).toBe(1);
    expect(state.blockOrder).toEqual(['b1']);
  });

  it('SubagentState supports finished mode', () => {
    const state: SubagentState = {
      messageId: 'msg-sub-1',
      blocks: [
        {
          blockId: 'b1',
          blockType: 'text',
          content: 'Done',
        },
      ],
      summary: 'Task complete',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    };

    expect(Array.isArray(state.blocks)).toBe(true);
    expect(state.running).toBeUndefined();
    expect(state.summary).toBe('Task complete');
  });
});
