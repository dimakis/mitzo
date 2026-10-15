import { describe, expect, it } from 'vitest';
import { collectSessionResources, mergeSessionResources } from '../session-resources';
import type { FinishedMessage, StreamingMessage } from '../../types/chat';

describe('resource evidence classification', () => {
  it('retains the exact submitted context text when injection evidence exists', () => {
    const value = collectSessionResources([
      {
        messageId: 'u',
        role: 'user',
        contextBlocks: ['Plan'],
        contextInjections: [{ name: 'Plan', source: 'plan.md', content: 'Exact submitted plan' }],
        blocks: [],
      },
    ]);
    expect(value.sources[0].content).toBe('Exact submitted plan');
    const changed = collectSessionResources(
      ['First version', 'Revised version'].map((content, index) => ({
        messageId: `u${index}`,
        role: 'user',
        contextBlocks: ['Plan'],
        contextInjections: [{ name: 'Plan', source: 'plan.md', content }],
        blocks: [],
      })),
    );
    expect(changed.sources.map((source) => source.content)).toEqual([
      'First version',
      'Revised version',
    ]);
  });
  it('reads a successful publication snapshot without inferring checks or state from a URL', () => {
    const href = 'https://github.com/acme/widgets/pull/12';
    const value = collectSessionResources([
      {
        messageId: 'a',
        role: 'assistant',
        blocks: [
          {
            blockId: 'p',
            blockType: 'tool_use',
            toolName: 'RequestGithubPublish',
            content: '',
            toolResult: JSON.stringify({
              status: 'succeeded',
              result: {
                pullRequestUrl: href,
                pullRequestState: 'open',
                draft: true,
                created: true,
                observedAt: 1000,
                sourceOid: 'a'.repeat(40),
              },
            }),
          },
        ],
      },
    ]);
    expect(value.references[0].pullRequest).toMatchObject({ state: 'Draft', observedAt: 1000 });
    expect(value.references[0].roles).toContain('created');
    expect(
      collectSessionResources([
        {
          messageId: 'u',
          role: 'user',
          blocks: [{ blockId: 'u', blockType: 'text', content: href }],
        },
      ]).references[0].pullRequest,
    ).toBeUndefined();
  });
  it('keeps multiple roles for one URL across messages and merges streaming provenance', () => {
    const href = 'https://example.com/page';
    const user = collectSessionResources([
      {
        messageId: 'u',
        role: 'user',
        blocks: [{ blockId: 'u', blockType: 'text', content: href }],
      },
    ]);
    const agent = collectSessionResources([
      {
        messageId: 'a',
        role: 'assistant',
        blocks: [
          { blockId: 'a', blockType: 'text', content: href },
          {
            blockId: 't',
            blockType: 'tool_use',
            toolName: 'WebSearch',
            content: '',
            toolResult: href,
          },
        ],
      },
    ]);
    const merged = mergeSessionResources(user, agent);
    expect(merged.references).toHaveLength(1);
    expect(merged.references[0].roles).toEqual(['user', 'cited', 'research']);
    expect(merged.references[0].mentions).toBe(3);
    expect(merged.references[0].roles).not.toContain('created');
  });
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
