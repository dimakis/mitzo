import { describe, it, expect } from 'vitest';
import { groupBlocks } from '../groupMessages';
import type { FinishedBlock } from '../../types/chat';

function toolBlock(id: string): FinishedBlock {
  return {
    blockId: id,
    blockType: 'tool_use',
    content: '',
    toolName: 'Read',
    toolId: id,
    toolInput: id,
  };
}

function textBlock(id = 'text-1'): FinishedBlock {
  return { blockId: id, blockType: 'text', content: 'hello' };
}

function thinkingBlock(id = 'th-1'): FinishedBlock {
  return { blockId: id, blockType: 'thinking', content: 'some thought' };
}

describe('groupBlocks', () => {
  it('groups a single ordinary tool call', () => {
    const blocks = [textBlock(), toolBlock('t1')];
    const grouped = groupBlocks(blocks);
    expect(grouped).toHaveLength(2);
    expect(grouped[1]).toMatchObject({ type: 'tool-group', tools: [blocks[1]] });
  });

  it('groups every contiguous tool run independently', () => {
    const blocks = [textBlock(), toolBlock('t1'), thinkingBlock(), toolBlock('t2')];
    const grouped = groupBlocks(blocks);
    expect(grouped).toHaveLength(4);
    expect(grouped[1].type).toBe('tool-group');
    expect(grouped[3].type).toBe('tool-group');
  });

  it('flushes separate tool batches independently', () => {
    const blocks = [
      textBlock('text-1'),
      toolBlock('t1'),
      toolBlock('t2'),
      thinkingBlock(),
      toolBlock('t3'),
      toolBlock('t4'),
      toolBlock('t5'),
      textBlock('text-2'),
    ];
    const grouped = groupBlocks(blocks);
    // Every batch, including short batches, is a disclosure group.
    const types = grouped.map((g) => g.type);
    expect(types).toEqual([
      'block', // text-1
      'tool-group', // t1+t2
      'block', // thinking
      'tool-group', // t3+t4+t5
      'block', // text-2
    ]);
  });

  describe('stable keys', () => {
    it('tool-group key is derived from first tool blockId', () => {
      const blocks = [textBlock(), toolBlock('abc'), toolBlock('def'), toolBlock('ghi')];
      const grouped = groupBlocks(blocks);
      const group = grouped[1];
      expect(group.type).toBe('tool-group');
      if (group.type === 'tool-group') {
        expect(group.key).toBe('abc');
      }
    });

    it('key is stable across re-runs with same blocks', () => {
      const blocks = [textBlock(), toolBlock('x1'), toolBlock('x2'), toolBlock('x3')];
      const a = groupBlocks(blocks);
      const b = groupBlocks(blocks);
      if (a[1].type === 'tool-group' && b[1].type === 'tool-group') {
        expect(a[1].key).toBe(b[1].key);
      }
    });

    it('two separate groups have different keys', () => {
      const blocks = [
        textBlock('t1'),
        toolBlock('a1'),
        toolBlock('a2'),
        toolBlock('a3'),
        thinkingBlock(),
        toolBlock('b1'),
        toolBlock('b2'),
        toolBlock('b3'),
      ];
      const grouped = groupBlocks(blocks);
      const groups = grouped.filter((g) => g.type === 'tool-group');
      expect(groups).toHaveLength(2);
      if (groups[0].type === 'tool-group' && groups[1].type === 'tool-group') {
        expect(groups[0].key).toBe('a1');
        expect(groups[1].key).toBe('b1');
        expect(groups[0].key).not.toBe(groups[1].key);
      }
    });
  });

  it('non-tool blocks are never grouped', () => {
    const blocks = [textBlock('t1'), thinkingBlock(), textBlock('t2')];
    const grouped = groupBlocks(blocks);
    expect(grouped).toHaveLength(3);
    expect(grouped.every((g) => g.type === 'block')).toBe(true);
  });

  it('groups a trailing short tool run', () => {
    const blocks = [textBlock(), toolBlock('t1'), toolBlock('t2')];
    const grouped = groupBlocks(blocks);
    expect(grouped).toHaveLength(2);
    expect(grouped[1].type).toBe('tool-group');
  });

  it('returns empty array for empty input', () => {
    expect(groupBlocks([])).toHaveLength(0);
  });

  it('returns empty array when blocks is undefined', () => {
    expect(groupBlocks(undefined as unknown as FinishedBlock[])).toHaveLength(0);
  });

  it('returns empty array when blocks is null', () => {
    expect(groupBlocks(null as unknown as FinishedBlock[])).toHaveLength(0);
  });
});
