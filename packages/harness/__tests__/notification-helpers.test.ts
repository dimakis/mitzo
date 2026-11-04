import { describe, it, expect } from 'vitest';
import { extractSnippet } from '../src/notification-helpers.js';
import type { SnapshotBlock } from '@mitzo/protocol';

function textBlock(content: string): SnapshotBlock {
  return { blockId: '1', blockType: 'text', content, done: true };
}

describe('extractSnippet', () => {
  it('returns fallback for empty blocks', () => {
    expect(extractSnippet([], 200)).toBe('');
  });

  it('returns fallback for only tool_use blocks', () => {
    const blocks: SnapshotBlock[] = [
      { blockId: '1', blockType: 'tool_use', content: 'ls', done: true, toolName: 'Bash' },
    ];
    expect(extractSnippet(blocks, 200)).toBe('');
  });

  it('returns full text when under maxChars', () => {
    expect(extractSnippet([textBlock('Hello world')], 200)).toBe('Hello world');
  });

  it('truncates at word boundary', () => {
    const long = 'This is a fairly long message that exceeds the limit';
    const result = extractSnippet([textBlock(long)], 30);
    expect(result.length).toBeLessThanOrEqual(34); // 30 + "..."
    expect(result).toContain('...');
  });

  it('uses last text block', () => {
    const blocks: SnapshotBlock[] = [textBlock('first'), textBlock('second')];
    expect(extractSnippet(blocks, 200)).toBe('second');
  });

  it('keeps the written result when a trailing text block is empty', () => {
    expect(
      extractSnippet(
        [textBlock('Blocked: CI needs a source fingerprint update.'), textBlock('  ')],
        200,
      ),
    ).toBe('Blocked: CI needs a source fingerprint update.');
  });

  it('makes outcome bullets and links readable on a notification', () => {
    expect(
      extractSnippet(
        [
          textBlock(
            '## Result\n\n- **Fixed** Watch approvals.\n- [PR #1207](https://github.com/dimakis/mitzo/pull/1207) awaits review.\n- `18 tests` passed.',
          ),
        ],
        250,
      ),
    ).toBe('Result: Fixed Watch approvals. PR #1207 awaits review. 18 tests passed.');
  });
});
