import { describe, it, expect } from 'vitest';
import { summarizeToolInput } from '../tool-summary.js';

describe('summarizeToolInput', () => {
  it('summarizes Read tool with file path', () => {
    expect(summarizeToolInput('Read', { path: '/home/user/file.ts' })).toBe('/home/user/file.ts');
  });

  it('summarizes Write tool with path and content length', () => {
    const result = summarizeToolInput('Write', {
      path: '/tmp/out.txt',
      contents: 'hello world',
    });
    expect(result).toBe('/tmp/out.txt (11 chars)');
  });

  it('summarizes Edit/StrReplace tool with path', () => {
    expect(summarizeToolInput('Edit', { path: '/src/index.ts' })).toBe('/src/index.ts');
    expect(summarizeToolInput('StrReplace', { path: '/src/index.ts' })).toBe('/src/index.ts');
  });

  it('summarizes Bash tool with truncated command', () => {
    const short = summarizeToolInput('Bash', { command: 'ls -la' });
    expect(short).toBe('ls -la');

    const long = summarizeToolInput('Bash', { command: 'x'.repeat(300) });
    expect(long.length).toBe(200);
  });

  it('summarizes Glob tool with pattern and directory', () => {
    expect(
      summarizeToolInput('Glob', {
        glob_pattern: '**/*.ts',
        target_directory: '/src',
      }),
    ).toBe('**/*.ts in /src');
  });

  it('summarizes Glob tool with default directory', () => {
    expect(summarizeToolInput('Glob', { glob_pattern: '*.js' })).toBe('*.js in workspace');
  });

  it('summarizes Grep tool with pattern and path', () => {
    expect(
      summarizeToolInput('Grep', {
        pattern: 'TODO',
        path: '/src',
      }),
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
  });
});
