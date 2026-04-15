import { describe, it, expect } from 'vitest';
import { summarizeToolInput, getRawInput } from '../src/tool-summary.js';

describe('summarizeToolInput', () => {
  it('summarizes Read tool with file path', () => {
    expect(summarizeToolInput('Read', { file_path: '/home/user/file.ts' })).toBe(
      '/home/user/file.ts',
    );
  });

  it('summarizes Write tool with path and content length', () => {
    const result = summarizeToolInput('Write', {
      file_path: '/tmp/out.txt',
      content: 'hello world',
    });
    expect(result).toBe('/tmp/out.txt (11 chars)');
  });

  it('summarizes Edit/StrReplace tool with path', () => {
    expect(summarizeToolInput('Edit', { file_path: '/src/index.ts' })).toBe('/src/index.ts');
    expect(summarizeToolInput('StrReplace', { file_path: '/src/index.ts' })).toBe('/src/index.ts');
  });

  it('summarizes Bash tool with truncated command', () => {
    const short = summarizeToolInput('Bash', { command: 'ls -la' });
    expect(short).toBe('ls -la');

    const long = summarizeToolInput('Bash', { command: 'x'.repeat(300) });
    expect(long.length).toBe(200);
  });

  it('summarizes Glob tool with pattern and directory', () => {
    expect(
      summarizeToolInput('Glob', { pattern: '**/*.ts', path: '/src' }),
    ).toBe('**/*.ts in /src');
  });

  it('summarizes Glob tool with default directory', () => {
    expect(summarizeToolInput('Glob', { pattern: '*.js' })).toBe('*.js in workspace');
  });

  it('summarizes Grep tool with pattern and path', () => {
    expect(
      summarizeToolInput('Grep', { pattern: 'TODO', path: '/src' }),
    ).toBe('/TODO/ in /src');
  });

  it('summarizes WebSearch tool', () => {
    expect(summarizeToolInput('WebSearch', { search_term: 'vitest mocking' })).toBe(
      'vitest mocking',
    );
  });

  it('summarizes WebFetch tool', () => {
    expect(summarizeToolInput('WebFetch', { url: 'https://example.com' })).toBe(
      'https://example.com',
    );
  });

  it('falls back to JSON.stringify for unknown tools', () => {
    const result = summarizeToolInput('CustomTool', { foo: 'bar', baz: 42 });
    expect(result).toContain('foo');
    expect(result).toContain('bar');
  });

  it('truncates unknown tool output to 200 chars', () => {
    const bigInput: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      bigInput[`key_${i}`] = 'a'.repeat(20);
    }
    const result = summarizeToolInput('CustomTool', bigInput);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it('handles missing fields gracefully', () => {
    expect(summarizeToolInput('Read', {})).toBe('');
    expect(summarizeToolInput('Write', {})).toBe(' (0 chars)');
    expect(summarizeToolInput('Bash', {})).toBe('');
    expect(summarizeToolInput('Glob', {})).toBe(' in workspace');
  });

  it('summarizes task MCP tools', () => {
    expect(
      summarizeToolInput('mcp__task-board__TaskSet', { tasks: [{}, {}, {}] }),
    ).toBe('3 subtasks');
    expect(
      summarizeToolInput('mcp__task-board__TaskComplete', { summary: 'Done with feature' }),
    ).toBe('Done with feature');
    expect(summarizeToolInput('mcp__task-board__TaskStatus', {})).toBe('get status');
    expect(
      summarizeToolInput('mcp__task-board__TaskBlock', { reason: 'Need clarification' }),
    ).toBe('Need clarification');
  });
});

describe('getRawInput', () => {
  it('returns write type for Write tool', () => {
    const result = getRawInput('Write', { file_path: 'foo.ts', content: 'hello world' });
    expect(result).toEqual({ type: 'write', path: 'foo.ts', contents: 'hello world' });
  });

  it('returns diff type for StrReplace tool', () => {
    const result = getRawInput('StrReplace', {
      file_path: 'bar.ts',
      old_string: 'old code',
      new_string: 'new code',
    });
    expect(result).toEqual({
      type: 'diff',
      path: 'bar.ts',
      old_string: 'old code',
      new_string: 'new code',
    });
  });

  it('returns diff type for Edit tool', () => {
    const result = getRawInput('Edit', {
      file_path: 'baz.ts',
      old_string: 'a',
      new_string: 'b',
    });
    expect(result?.type).toBe('diff');
  });

  it('returns command type for Bash tool', () => {
    const result = getRawInput('Bash', { command: 'ls -la' });
    expect(result).toEqual({ type: 'command', command: 'ls -la' });
  });

  it('returns command type for Shell tool', () => {
    const result = getRawInput('Shell', { command: 'npm test' });
    expect(result).toEqual({ type: 'command', command: 'npm test' });
  });

  it('returns undefined for Read tool', () => {
    expect(getRawInput('Read', { file_path: 'foo.ts' })).toBeUndefined();
  });

  it('returns undefined for Grep tool', () => {
    expect(getRawInput('Grep', { pattern: 'foo' })).toBeUndefined();
  });

  it('returns undefined for unknown MCP tools', () => {
    expect(getRawInput('mcp__jira__get_issue', { key: 'FOO-1' })).toBeUndefined();
  });

  it('caps contents at RAW_INPUT_MAX_CHARS', () => {
    const bigContent = 'x'.repeat(60_000);
    const result = getRawInput('Write', { file_path: 'big.ts', content: bigContent });
    expect(result?.contents?.length).toBeLessThanOrEqual(50_000);
  });

  it('caps old_string and new_string at RAW_INPUT_MAX_CHARS', () => {
    const big = 'y'.repeat(60_000);
    const result = getRawInput('StrReplace', {
      file_path: 'f.ts',
      old_string: big,
      new_string: big,
    });
    expect(
      (result?.old_string?.length || 0) + (result?.new_string?.length || 0),
    ).toBeLessThanOrEqual(100_000);
  });
});
