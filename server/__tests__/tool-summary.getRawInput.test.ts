import { describe, it, expect } from 'vitest';
import { getRawInput } from '../tool-summary.js';

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

  it('returns read type with no language for unknown extension', () => {
    const result = getRawInput('Read', { file_path: 'data.xyz' });
    expect(result).toEqual({ type: 'read', path: 'data.xyz', language: undefined });
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
