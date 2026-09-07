import { describe, expect, it } from 'vitest';
import type { FinishedMessage, StreamingMessage } from '../../types/chat';
import { collectSessionResources } from '../session-resources';

describe('collectSessionResources', () => {
  it('collects and deduplicates context, images, tools, links, and written files', () => {
    const messages: FinishedMessage[] = [
      {
        messageId: 'user-1',
        role: 'user',
        blocks: [{ blockId: 'u1', blockType: 'text', content: 'Use this' }],
        images: ['data:image/png;base64,one'],
        contextBlocks: ['constitution'],
      },
      {
        messageId: 'assistant-1',
        role: 'assistant',
        blocks: [
          {
            blockId: 'a1',
            blockType: 'text',
            content: 'Preview: http://localhost:3196 and http://localhost:3196',
          },
          {
            blockId: 'a2',
            blockType: 'tool_use',
            content: '',
            toolName: 'Write',
            rawInput: { type: 'write', path: '/tmp/report.md' },
            toolResultImages: [{ id: 'result-1', mediaType: 'image/png' }],
          },
        ],
      },
    ];

    const current: StreamingMessage = {
      messageId: 'streaming',
      blockOrder: ['a3'],
      blocks: new Map([
        [
          'a3',
          {
            blockId: 'a3',
            blockType: 'tool_use',
            content: '',
            done: false,
            toolName: 'Write',
            rawInput: { type: 'diff', path: '/tmp/report.md' },
          },
        ],
      ]),
    };

    expect(collectSessionResources(messages, current)).toEqual({
      sources: [
        { id: 'context:constitution', kind: 'context', label: 'constitution' },
        {
          id: 'image:user-1:0',
          kind: 'image',
          label: 'Pasted image 1',
          preview: 'data:image/png;base64,one',
        },
        { id: 'tool:Write', kind: 'tool', label: 'Write' },
      ],
      outputs: [
        {
          id: 'url:http://localhost:3196',
          kind: 'link',
          label: 'localhost:3196',
          href: 'http://localhost:3196',
        },
        {
          id: 'file:/tmp/report.md',
          kind: 'file',
          label: 'report.md',
          path: '/tmp/report.md',
        },
        {
          id: 'result-image:result-1',
          kind: 'image',
          label: 'Generated image',
          imageId: 'result-1',
        },
      ],
    });
  });
});
