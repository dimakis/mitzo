import { it, expect, vi } from 'vitest';
import { TerminalAdviser, AdviserBody } from '../terminal-adviser.js';
it('sends only deliberately supplied context with no tools and never executes suggestions', async () => {
  const factory = vi.fn(async (config) => ({
    provider: 'fake',
    async *turn(messages: unknown) {
      expect(messages).toEqual([
        { role: 'user', content: 'Explain this\n\nReviewed terminal output:\npermission denied' },
      ]);
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Try checking permissions.\n```sh\nls -la\n```' },
      };
    },
  }));
  const adviser = new TerminalAdviser(factory as never);
  const result = await adviser.ask(
    'owner',
    {
      accountId: 'work',
      model: 'luna',
      reasoningEffort: 'low',
      messages: [{ role: 'user', content: 'Explain this' }],
      output: 'permission denied',
    },
    new AbortController().signal,
  );
  expect(factory).toHaveBeenCalledWith(
    expect.objectContaining({ tools: [], model: 'luna', reasoningEffort: 'low' }),
    expect.objectContaining({ accountId: 'work' }),
  );
  expect(result.commands).toEqual(['ls -la']);
  expect(result.text).toContain('permissions');
});
it('fails closed if a provider emits a tool call, with no execution handler available', async () => {
  const adviser = new TerminalAdviser(async () => ({
    provider: 'fake',
    async *turn() {
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'x',
          name: 'shell',
          input: { command: 'touch /tmp/bad' },
        },
      };
    },
  }));
  await expect(
    adviser.ask(
      'owner',
      { accountId: 'work', model: 'luna', messages: [{ role: 'user', content: 'help' }] },
      new AbortController().signal,
    ),
  ).rejects.toThrow('tools');
});
it('rejects implicit output sharing, executable objects and oversized history', () => {
  expect(
    AdviserBody.safeParse({
      accountId: 'work',
      model: 'luna',
      messages: [{ role: 'user', content: 'help' }],
      terminalSnapshot: true,
    }).success,
  ).toBe(false);
  expect(
    AdviserBody.safeParse({
      accountId: 'work',
      model: 'luna',
      messages: [{ role: 'tool', content: 'help' }],
    }).success,
  ).toBe(false);
  expect(
    AdviserBody.safeParse({
      accountId: 'work',
      model: 'luna',
      messages: Array.from({ length: 13 }, () => ({ role: 'user', content: 'help' })),
    }).success,
  ).toBe(false);
});
