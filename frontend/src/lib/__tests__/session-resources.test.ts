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

  it('keeps balanced URL parentheses while removing trailing prose punctuation', () => {
    const messages: FinishedMessage[] = [
      {
        messageId: 'assistant-1',
        role: 'assistant',
        blocks: [
          {
            blockId: 'a1',
            blockType: 'text',
            content:
              'See http://en.wikipedia.org/wiki/Thing_(section). Then http://host/path?q=1.,!?',
          },
        ],
      },
    ];

    expect(collectSessionResources(messages).outputs).toEqual([
      {
        id: 'url:http://en.wikipedia.org/wiki/Thing_(section)',
        kind: 'link',
        label: 'en.wikipedia.org/wiki/Thing_(section)',
        href: 'http://en.wikipedia.org/wiki/Thing_(section)',
      },
      {
        id: 'url:http://host/path?q=1',
        kind: 'link',
        label: 'host/path',
        href: 'http://host/path?q=1',
      },
    ]);
  });

  it('collects resources recursively from finished and streaming subagents', () => {
    const messages: FinishedMessage[] = [
      {
        messageId: 'assistant-1',
        role: 'assistant',
        blocks: [
          {
            blockId: 'agent-1',
            blockType: 'tool_use',
            content: '',
            toolName: 'Agent',
            subagent: {
              messageId: 'subagent-finished',
              blocks: [
                {
                  blockId: 'write-1',
                  blockType: 'tool_use',
                  content: '',
                  toolName: 'Write',
                  rawInput: { type: 'write', path: '/tmp/from-finished.md' },
                  toolResult: 'Saved. Preview: https://example.com/finished',
                },
              ],
            },
          },
        ],
      },
    ];
    const current: StreamingMessage = {
      messageId: 'assistant-current',
      blockOrder: ['agent-2'],
      blocks: new Map([
        [
          'agent-2',
          {
            blockId: 'agent-2',
            blockType: 'tool_use',
            content: '',
            done: false,
            toolName: 'Agent',
            subagent: {
              messageId: 'subagent-streaming',
              running: true,
              blockOrder: ['edit-1'],
              blocks: new Map([
                [
                  'edit-1',
                  {
                    blockId: 'edit-1',
                    blockType: 'tool_use',
                    content: '',
                    done: true,
                    toolName: 'Edit',
                    rawInput: { type: 'diff', path: '/tmp/from-streaming.md' },
                    toolResult: 'Updated',
                    toolResultImages: [{ id: 'subagent-image', mediaType: 'image/png' }],
                  },
                ],
              ]),
            },
          },
        ],
      ]),
    };

    const resources = collectSessionResources(messages, current);

    expect(resources.sources).toEqual([
      { id: 'tool:Agent', kind: 'tool', label: 'Agent' },
      { id: 'tool:Write', kind: 'tool', label: 'Write' },
      { id: 'tool:Edit', kind: 'tool', label: 'Edit' },
    ]);
    expect(resources.outputs).toEqual([
      {
        id: 'url:https://example.com/finished',
        kind: 'link',
        label: 'example.com/finished',
        href: 'https://example.com/finished',
      },
      {
        id: 'file:/tmp/from-finished.md',
        kind: 'file',
        label: 'from-finished.md',
        path: '/tmp/from-finished.md',
      },
      {
        id: 'file:/tmp/from-streaming.md',
        kind: 'file',
        label: 'from-streaming.md',
        path: '/tmp/from-streaming.md',
      },
      {
        id: 'result-image:subagent-image',
        kind: 'image',
        label: 'Generated image',
        imageId: 'subagent-image',
      },
    ]);
  });

  it('excludes pending and failed tool outputs while retaining successful ones', () => {
    const messages: FinishedMessage[] = [
      {
        messageId: 'assistant-1',
        role: 'assistant',
        blocks: [
          {
            blockId: 'failed-write',
            blockType: 'tool_use',
            content: '',
            toolName: 'Write',
            rawInput: { type: 'write', path: '/tmp/failed.md' },
            toolResult: 'Failed: https://example.com/error',
            toolError: true,
          },
          {
            blockId: 'successful-write',
            blockType: 'tool_use',
            content: '',
            toolName: 'Write',
            rawInput: { type: 'write', path: '/tmp/success.md' },
            toolResult: 'Saved',
          },
        ],
      },
    ];
    const current: StreamingMessage = {
      messageId: 'assistant-current',
      blockOrder: ['pending-write'],
      blocks: new Map([
        [
          'pending-write',
          {
            blockId: 'pending-write',
            blockType: 'tool_use',
            content: '',
            done: true,
            toolName: 'Write',
            rawInput: { type: 'write', path: '/tmp/pending.md' },
          },
        ],
      ]),
    };

    expect(collectSessionResources(messages, current).outputs).toEqual([
      {
        id: 'file:/tmp/success.md',
        kind: 'file',
        label: 'success.md',
        path: '/tmp/success.md',
      },
    ]);
  });
});
