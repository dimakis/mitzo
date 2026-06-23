import { describe, it, expect } from 'vitest';
import {
  parseContentBlocks,
  extractToolResultText,
  extractToolResultImages,
} from '../src/content-blocks.js';

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
      { type: 'tool_use', name: 'Read', id: 'tc-1', input: { file_path: '/tmp/file.ts' } },
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

  it('truncates tool results to 50000 chars', () => {
    const blocks = [{ type: 'tool_result', tool_use_id: 'tc-1', content: 'x'.repeat(60000) }];
    const result = parseContentBlocks(blocks);
    expect(result.toolResults[0].result.length).toBe(50_000);
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

describe('extractToolResultImages', () => {
  it('returns empty array for string content', () => {
    expect(extractToolResultImages('hello')).toEqual([]);
  });

  it('returns empty array for undefined content', () => {
    expect(extractToolResultImages(undefined)).toEqual([]);
  });

  it('extracts image blocks with base64 source', () => {
    const content = [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'iVBOR...' },
      },
    ];
    const result = extractToolResultImages(content);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ data: 'iVBOR...', mediaType: 'image/png' });
  });

  it('ignores non-image blocks', () => {
    const content = [
      { type: 'text', text: 'hello' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4...' },
      },
    ];
    const result = extractToolResultImages(content);
    expect(result).toHaveLength(1);
    expect(result[0].mediaType).toBe('image/jpeg');
  });

  it('skips image blocks missing source fields', () => {
    const content = [
      { type: 'image' },
      { type: 'image', source: { type: 'url', url: 'https://example.com/img.png' } },
      { type: 'image', source: { type: 'base64' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png' } },
    ];
    expect(extractToolResultImages(content)).toEqual([]);
  });

  it('extracts multiple images', () => {
    const content = [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'aaa' },
      },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/webp', data: 'bbb' },
      },
    ];
    const result = extractToolResultImages(content);
    expect(result).toHaveLength(2);
    expect(result[0].mediaType).toBe('image/png');
    expect(result[1].mediaType).toBe('image/webp');
  });
});
