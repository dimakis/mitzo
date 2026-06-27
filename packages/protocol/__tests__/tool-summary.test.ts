import { describe, it, expect } from 'vitest';
import { summarizeToolInput, getRawInput, getToolInputSpanAttrs } from '../src/tool-summary.js';

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
    expect(summarizeToolInput('Glob', { pattern: '**/*.ts', path: '/src' })).toBe(
      '**/*.ts in /src',
    );
  });

  it('summarizes Glob tool with default directory', () => {
    expect(summarizeToolInput('Glob', { pattern: '*.js' })).toBe('*.js in workspace');
  });

  it('summarizes Grep tool with pattern and path', () => {
    expect(summarizeToolInput('Grep', { pattern: 'TODO', path: '/src' })).toBe('/TODO/ in /src');
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

  it('summarizes Agent tool with type and description', () => {
    expect(
      summarizeToolInput('Agent', {
        subagent_type: 'Explore',
        description: 'Find meeting transcript',
        prompt: 'Search for...',
      }),
    ).toBe('Explore · Find meeting transcript');
  });

  it('summarizes Agent tool with only description', () => {
    expect(summarizeToolInput('Agent', { description: 'Search codebase' })).toBe('Search codebase');
  });

  it('summarizes Agent tool with only subagent_type', () => {
    expect(summarizeToolInput('Agent', { subagent_type: 'Plan' })).toBe('Plan');
  });

  it('summarizes Agent tool with no fields as "subagent"', () => {
    expect(summarizeToolInput('Agent', {})).toBe('subagent');
  });

  it('balances truncation so both type and description are visible', () => {
    const longType = 'T'.repeat(200);
    const longDesc = 'D'.repeat(200);
    const result = summarizeToolInput('Agent', {
      subagent_type: longType,
      description: longDesc,
    });
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result).toContain('T');
    expect(result).toContain('D');
    expect(result).toContain(' · ');
    const [left, right] = result.split(' · ');
    expect(left.length).toBeGreaterThan(0);
    expect(right.length).toBeGreaterThan(0);
  });

  it('gives short field full length and allocates remainder to long field', () => {
    const result = summarizeToolInput('Agent', {
      subagent_type: 'Explore',
      description: 'D'.repeat(200),
    });
    expect(result.length).toBeLessThanOrEqual(200);
    // 'Explore' (7 chars) should appear untruncated
    expect(result.startsWith('Explore · ')).toBe(true);
    // Description gets the remaining budget (200 - 7 - 3 = 190 chars)
    const desc = result.split(' · ')[1];
    expect(desc.length).toBe(190);
  });

  it('gives short description full length and allocates remainder to long type', () => {
    const result = summarizeToolInput('Agent', {
      subagent_type: 'T'.repeat(200),
      description: 'short',
    });
    expect(result.length).toBeLessThanOrEqual(200);
    // 'short' (5 chars) should appear untruncated at end
    expect(result.endsWith('short')).toBe(true);
    // Type gets the remaining budget (200 - 5 - 3 = 192 chars)
    const stype = result.split(' · ')[0];
    expect(stype.length).toBe(192);
  });

  it('summarizes task MCP tools', () => {
    expect(summarizeToolInput('mcp__task-board__TaskSet', { tasks: [{}, {}, {}] })).toBe(
      '3 subtasks',
    );
    expect(
      summarizeToolInput('mcp__task-board__TaskComplete', { summary: 'Done with feature' }),
    ).toBe('Done with feature');
    expect(summarizeToolInput('mcp__task-board__TaskStatus', {})).toBe('get status');
    expect(summarizeToolInput('mcp__task-board__TaskBlock', { reason: 'Need clarification' })).toBe(
      'Need clarification',
    );
  });
});

describe('getRawInput', () => {
  it('returns write type for Write tool', () => {
    const result = getRawInput('Write', { file_path: 'foo.ts', content: 'hello world' });
    expect(result).toEqual({
      type: 'write',
      path: 'foo.ts',
      contents: 'hello world',
      language: 'typescript',
    });
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
      language: 'typescript',
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
    expect(result).toEqual({ type: 'command', command: 'ls -la', language: 'bash' });
  });

  it('returns command type for Shell tool', () => {
    const result = getRawInput('Shell', { command: 'npm test' });
    expect(result).toEqual({ type: 'command', command: 'npm test', language: 'bash' });
  });

  it('returns read type for Read tool', () => {
    const result = getRawInput('Read', { file_path: 'foo.ts' });
    expect(result).toEqual({ type: 'read', path: 'foo.ts', language: 'typescript' });
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

  it('returns agent type for Agent tool', () => {
    const result = getRawInput('Agent', {
      description: 'Find transcript',
      subagent_type: 'Explore',
      prompt: 'Search for meeting notes',
    });
    expect(result).toEqual({
      type: 'agent',
      description: 'Find transcript',
      subagent_type: 'Explore',
      prompt: 'Search for meeting notes',
    });
  });

  it('caps Agent prompt at RAW_INPUT_MAX_CHARS', () => {
    const bigPrompt = 'z'.repeat(60_000);
    const result = getRawInput('Agent', { prompt: bigPrompt });
    expect(result?.prompt?.length).toBeLessThanOrEqual(50_000);
  });

  it('caps Agent description at TOOL_SUMMARY_MAX_CHARS', () => {
    const bigDesc = 'a'.repeat(300);
    const result = getRawInput('Agent', { description: bigDesc });
    expect(result?.description?.length).toBeLessThanOrEqual(200);
  });

  it('caps Agent subagent_type at TOOL_SUMMARY_MAX_CHARS', () => {
    const bigType = 'b'.repeat(300);
    const result = getRawInput('Agent', { subagent_type: bigType });
    expect(result?.subagent_type?.length).toBeLessThanOrEqual(200);
  });

  it('omits empty Agent fields', () => {
    const result = getRawInput('Agent', { description: 'Search' });
    expect(result).toEqual({ type: 'agent', description: 'Search' });
    expect(result).not.toHaveProperty('subagent_type');
    expect(result).not.toHaveProperty('prompt');
  });
});

describe('getToolInputSpanAttrs', () => {
  it('extracts file_path for Read', () => {
    expect(getToolInputSpanAttrs('Read', { file_path: '/src/index.ts' })).toEqual({
      'tool.input.file_path': '/src/index.ts',
    });
  });

  it('extracts file_path for Write', () => {
    expect(
      getToolInputSpanAttrs('Write', { file_path: '/tmp/out.txt', content: 'hello' }),
    ).toEqual({
      'tool.input.file_path': '/tmp/out.txt',
    });
  });

  it('extracts file_path for Edit and StrReplace', () => {
    expect(getToolInputSpanAttrs('Edit', { file_path: '/a.ts' })).toEqual({
      'tool.input.file_path': '/a.ts',
    });
    expect(getToolInputSpanAttrs('StrReplace', { file_path: '/b.ts' })).toEqual({
      'tool.input.file_path': '/b.ts',
    });
  });

  it('extracts command for Bash and Shell', () => {
    expect(getToolInputSpanAttrs('Bash', { command: 'npm test' })).toEqual({
      'tool.input.command': 'npm test',
    });
    expect(getToolInputSpanAttrs('Shell', { command: 'ls -la' })).toEqual({
      'tool.input.command': 'ls -la',
    });
  });

  it('extracts pattern and optional path for Glob', () => {
    expect(getToolInputSpanAttrs('Glob', { pattern: '**/*.ts', path: '/src' })).toEqual({
      'tool.input.pattern': '**/*.ts',
      'tool.input.path': '/src',
    });
    expect(getToolInputSpanAttrs('Glob', { pattern: '*.js' })).toEqual({
      'tool.input.pattern': '*.js',
    });
  });

  it('extracts pattern and optional path for Grep', () => {
    expect(getToolInputSpanAttrs('Grep', { pattern: 'TODO', path: '/src' })).toEqual({
      'tool.input.pattern': 'TODO',
      'tool.input.path': '/src',
    });
    expect(getToolInputSpanAttrs('Grep', { pattern: 'error' })).toEqual({
      'tool.input.pattern': 'error',
    });
  });

  it('extracts query for WebSearch', () => {
    expect(getToolInputSpanAttrs('WebSearch', { search_term: 'vitest mocking' })).toEqual({
      'tool.input.query': 'vitest mocking',
    });
  });

  it('extracts url for WebFetch', () => {
    expect(getToolInputSpanAttrs('WebFetch', { url: 'https://example.com' })).toEqual({
      'tool.input.url': 'https://example.com',
    });
  });

  it('extracts description and subagent_type for Agent', () => {
    expect(
      getToolInputSpanAttrs('Agent', {
        description: 'Find transcript',
        subagent_type: 'Explore',
        prompt: 'Search for...',
      }),
    ).toEqual({
      'tool.input.description': 'Find transcript',
      'tool.input.subagent_type': 'Explore',
    });
  });

  it('omits subagent_type for Agent when not provided', () => {
    const attrs = getToolInputSpanAttrs('Agent', { description: 'Search codebase' });
    expect(attrs).toEqual({ 'tool.input.description': 'Search codebase' });
    expect(attrs).not.toHaveProperty('tool.input.subagent_type');
  });

  it('extracts skill for Skill tool', () => {
    expect(getToolInputSpanAttrs('Skill', { skill: 'commit' })).toEqual({
      'tool.input.skill': 'commit',
    });
  });

  it('returns empty object for unknown tools', () => {
    expect(getToolInputSpanAttrs('mcp__jira__get_issue', { key: 'FOO-1' })).toEqual({});
  });

  it('omits empty string values', () => {
    expect(getToolInputSpanAttrs('Read', { file_path: '' })).toEqual({});
    expect(getToolInputSpanAttrs('Read', {})).toEqual({});
  });

  it('truncates long values to 256 chars', () => {
    const longPath = '/src/' + 'a'.repeat(300) + '.ts';
    const attrs = getToolInputSpanAttrs('Read', { file_path: longPath });
    expect(attrs['tool.input.file_path'].length).toBe(256);
  });
});
