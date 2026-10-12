import { describe, expect, it } from 'vitest';
import { collectSessionResources, mergeSessionResources } from '../session-resources';
import type { FinishedMessage, StreamingMessage } from '../../types/chat';

describe('resource evidence classification', () => {
  it('preserves historical URLs as References in all roles, including failed results; tools are observed capabilities', () => {
    const messages: FinishedMessage[] = [
      {
        messageId: 'user',
        role: 'user',
        images: ['data:image/png;base64,input'],
        contextBlocks: ['context'],
        blocks: [{ blockId: 'u', blockType: 'text', content: 'https://example.com/reference' }],
      },
      {
        messageId: 'assistant',
        role: 'assistant',
        blocks: [
          {
            blockId: 'a',
            blockType: 'text',
            content: '[link](https://example.com/reference) and https://example.com/mentioned.',
          },
          {
            blockId: 't',
            blockType: 'tool_use',
            content: '',
            toolName: 'Write',
            rawInput: { type: 'write', path: '/tmp/report.md' },
            toolResult: 'https://example.com/result',
            toolResultImages: [{ id: 'arbitrary', mediaType: 'image/png' }],
          },
          {
            blockId: 'f',
            blockType: 'tool_use',
            content: '',
            toolName: 'Read',
            toolError: true,
            toolResult: 'Failed https://example.com/error',
          },
        ],
      },
    ];
    const value = collectSessionResources(messages);
    expect(value.sources.map((r) => r.kind)).toEqual(['context', 'image']);
    expect(value.capabilities.map((r) => r.label)).toEqual(['Write', 'Read']);
    expect(value.outputs).toEqual([]);
    expect(value.references.map((r) => r.href ?? r.path)).toEqual([
      'https://example.com/reference',
      'https://example.com/mentioned',
      'https://example.com/result',
      '/tmp/report.md',
      'https://example.com/error',
    ]);
  });
  it('preserves balanced URLs and recursively classifies nested streaming results without output inference', () => {
    const current = {
      messageId: 'stream',
      blockOrder: ['agent'],
      blocks: new Map([
        [
          'agent',
          {
            blockId: 'agent',
            blockType: 'tool_use',
            content: '',
            done: false,
            toolName: 'Agent',
            subagent: {
              messageId: 'nested',
              blocks: [
                {
                  blockId: 'read',
                  blockType: 'tool_use',
                  content: '',
                  toolName: 'Read',
                  toolResult: 'See http://host/Thing_(section).',
                  toolResultImages: [{ id: 'image', mediaType: 'image/png' }],
                },
              ],
            },
          },
        ],
      ]),
    } as StreamingMessage;
    const value = collectSessionResources([], current);
    expect(value.references[0].href).toBe('http://host/Thing_(section)');
    expect(value.capabilities.map((r) => r.label)).toEqual(['Agent', 'Read']);
    expect(value.outputs).toEqual([]);
    expect(mergeSessionResources(value, value).references).toHaveLength(1);
  });
});
