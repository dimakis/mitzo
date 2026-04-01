import { describe, it, expect } from 'vitest';
import { parseContentBlocks, extractToolResultText } from '../content-blocks.js';

describe('extractToolResultText', () => {
  it('returns string content directly', () => {
    expect(extractToolResultText('hello')).toBe('hello');
  });

  it('concatenates text blocks from array content', () => {
    const content = [
      { type: 'text', text: 'line 1\n' },
      { type: 'text', text: 'line 2' },
    ];
    expect(extractToolResultText(content)).toBe('line 1\nline 2');
  });

  it('ignores non-text blocks', () => {
    const content = [{ type: 'text', text: 'ok' }, { type: 'image' }];
    expect(extractToolResultText(content as Parameters<typeof extractToolResultText>[0])).toBe(
      'ok',
    );
  });

  it('returns empty string for undefined', () => {
    expect(extractToolResultText(undefined)).toBe('');
  });
});

describe('parseContentBlocks', () => {
  it('extracts text from text blocks', () => {
    const blocks = [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
    ];
    const result = parseContentBlocks(blocks);
    expect(result.text).toBe('Hello world');
    expect(result.toolCalls).toHaveLength(0);
    expect(result.toolResults).toHaveLength(0);
  });

  it('extracts tool_use blocks', () => {
    const blocks = [
      { type: 'tool_use', name: 'Read', id: 'tc-1', input: { path: '/tmp/file.ts' } },
    ];
    const result = parseContentBlocks(blocks);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].toolName).toBe('Read');
    expect(result.toolCalls[0].toolId).toBe('tc-1');
    expect(result.toolCalls[0].input).toBe('/tmp/file.ts');
  });

  it('extracts tool_result blocks', () => {
    const blocks = [{ type: 'tool_result', tool_use_id: 'tc-1', content: 'file contents here' }];
    const result = parseContentBlocks(blocks);
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0].toolId).toBe('tc-1');
    expect(result.toolResults[0].result).toBe('file contents here');
  });

  it('truncates tool results to 2000 chars', () => {
    const blocks = [{ type: 'tool_result', tool_use_id: 'tc-1', content: 'x'.repeat(3000) }];
    const result = parseContentBlocks(blocks);
    expect(result.toolResults[0].result.length).toBe(2000);
  });

  it('handles mixed blocks', () => {
    const blocks = [
      { type: 'text', text: 'prefix' },
      { type: 'tool_use', name: 'Bash', id: 'tc-2', input: { command: 'ls' } },
      { type: 'tool_result', tool_use_id: 'tc-2', content: 'output' },
    ];
    const result = parseContentBlocks(blocks);
    expect(result.text).toBe('prefix');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolResults).toHaveLength(1);
  });
});
