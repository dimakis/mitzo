import { describe, it, expect } from 'vitest';
import { extractSnippet } from '../notification-helpers.js';
import type { SnapshotBlock } from '../session-registry.js';

function textBlock(content: string, done = true): SnapshotBlock {
  return { blockId: 'b0', blockType: 'text', content, done };
}

function toolBlock(name = 'Read'): SnapshotBlock {
  return { blockId: 'b1', blockType: 'tool_use', content: '', done: true, toolName: name };
}

describe('extractSnippet', () => {
  it('returns content from the last text block', () => {
    const blocks = [textBlock('First message'), toolBlock(), textBlock('Final reply')];
    expect(extractSnippet(blocks, 150)).toBe('Final reply');
  });

  it('truncates on word boundary with ellipsis', () => {
    const long = 'The quick brown fox jumps over the lazy dog and keeps running far away';
    const result = extractSnippet([textBlock(long)], 40);
    expect(result.length).toBeLessThanOrEqual(43); // 40 + '...'
    expect(result.endsWith('...')).toBe(true);
    expect(result).not.toContain('away'); // cut before last word
  });

  it('returns fallback when no text blocks exist', () => {
    expect(extractSnippet([toolBlock()], 150)).toBe('Agent finished its turn.');
  });

  it('returns fallback for empty blocks array', () => {
    expect(extractSnippet([], 150)).toBe('Agent finished its turn.');
  });

  it('does not truncate content under max length', () => {
    const short = 'Done!';
    expect(extractSnippet([textBlock(short)], 150)).toBe('Done!');
  });

  it('returns fallback when text block has empty content', () => {
    expect(extractSnippet([textBlock('')], 150)).toBe('Agent finished its turn.');
  });
});
