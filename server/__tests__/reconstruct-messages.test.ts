import { describe, it, expect } from 'vitest';
import { reconstructMessages } from '../chat.js';
import type { RawSdkMessage } from '../chat.js';

describe('reconstructMessages', () => {
  it('returns empty array for empty input', () => {
    expect(reconstructMessages([])).toEqual([]);
  });

  it('reconstructs user prompts stored as plain strings', () => {
    const raw: RawSdkMessage[] = [
      { type: 'user', message: { id: 'u1', content: 'Hello, help me with this' } },
    ];
    const result = reconstructMessages(raw);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].blocks).toHaveLength(1);
    expect(result[0].blocks[0].blockType).toBe('text');
    expect(result[0].blocks[0].content).toBe('Hello, help me with this');
  });

  it('reconstructs assistant messages with text content blocks', () => {
    const raw: RawSdkMessage[] = [
      {
        type: 'assistant',
        message: { id: 'a1', content: [{ type: 'text', text: 'Here is my response' }] },
      },
    ];
    const result = reconstructMessages(raw);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    expect(result[0].blocks[0].content).toBe('Here is my response');
  });

  it('reconstructs assistant messages with tool_use blocks', () => {
    const raw: RawSdkMessage[] = [
      {
        type: 'assistant',
        message: {
          id: 'a1',
          content: [
            { type: 'tool_use', name: 'Read', id: 'tc-1', input: { file_path: '/tmp/f.ts' } },
          ],
        },
      },
    ];
    const result = reconstructMessages(raw);
    expect(result).toHaveLength(1);
    expect(result[0].blocks[0].blockType).toBe('tool_use');
    expect(result[0].blocks[0].toolName).toBe('Read');
    expect(result[0].blocks[0].toolId).toBe('tc-1');
  });

  it('attaches tool results from user-type SDK messages to matching tool blocks', () => {
    const raw: RawSdkMessage[] = [
      {
        type: 'assistant',
        message: {
          id: 'a1',
          content: [{ type: 'tool_use', name: 'Bash', id: 'tc-1', input: { command: 'ls' } }],
        },
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tc-1', content: 'file1\nfile2' }],
        },
      },
    ];
    const result = reconstructMessages(raw);
    const assistantMsg = result.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.blocks[0].toolResult).toBe('file1\nfile2');
  });

  it('filters out user messages that only contain tool_result blocks', () => {
    const raw: RawSdkMessage[] = [
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tc-1', content: 'output' }],
        },
      },
    ];
    const result = reconstructMessages(raw);
    expect(result).toHaveLength(0);
  });

  it('skips messages with empty string content', () => {
    const raw: RawSdkMessage[] = [{ type: 'user', message: { id: 'u1', content: '' } }];
    const result = reconstructMessages(raw);
    expect(result).toHaveLength(0);
  });

  it('skips messages with undefined content', () => {
    const raw: RawSdkMessage[] = [{ type: 'user', message: { id: 'u1' } }];
    const result = reconstructMessages(raw);
    expect(result).toHaveLength(0);
  });

  it('handles a full multi-turn conversation', () => {
    const raw: RawSdkMessage[] = [
      { type: 'user', message: { id: 'u1', content: 'List my files' } },
      {
        type: 'assistant',
        message: {
          id: 'a1',
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', name: 'Bash', id: 'tc-1', input: { command: 'ls' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tc-1', content: 'README.md\nsrc/' }],
        },
      },
      {
        type: 'assistant',
        message: { id: 'a2', content: [{ type: 'text', text: 'You have README.md and src/.' }] },
      },
      { type: 'user', message: { id: 'u2', content: 'Thanks!' } },
    ];

    const result = reconstructMessages(raw);

    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({ role: 'user', blocks: [{ content: 'List my files' }] });
    expect(result[1]).toMatchObject({ role: 'assistant' });
    expect(result[1].blocks).toHaveLength(2);
    expect(result[1].blocks[0].content).toBe('Let me check.');
    expect(result[1].blocks[1].toolResult).toBe('README.md\nsrc/');
    expect(result[2]).toMatchObject({
      role: 'assistant',
      blocks: [{ content: 'You have README.md and src/.' }],
    });
    expect(result[3]).toMatchObject({ role: 'user', blocks: [{ content: 'Thanks!' }] });
  });

  it('generates unique block IDs across messages', () => {
    const raw: RawSdkMessage[] = [
      { type: 'user', message: { id: 'u1', content: 'First' } },
      { type: 'user', message: { id: 'u2', content: 'Second' } },
    ];
    const result = reconstructMessages(raw);
    const ids = result.flatMap((m) => m.blocks.map((b) => b.blockId));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
