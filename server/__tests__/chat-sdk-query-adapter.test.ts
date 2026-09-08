import { describe, expect, it, vi } from 'vitest';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { adaptSdkQuery } from '../chat.js';

function fakeQuery(messages: unknown[]) {
  return {
    state: 'bound-to-source',
    async *[Symbol.asyncIterator]() {
      yield* messages;
    },
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn(),
    close: vi.fn(),
    stopTask: vi.fn(),
    setModel: vi.fn(function (this: { state: string }) {
      return this.state;
    }),
  } as unknown as Query;
}

describe('adaptSdkQuery', () => {
  it('validates async messages and preserves bound SDK methods', async () => {
    const raw = fakeQuery([{ type: 'assistant', content: 'hello' }]);
    const adapted = adaptSdkQuery(raw);
    const messages: Record<string, unknown>[] = [];

    for await (const message of adapted) messages.push(message);

    expect(messages).toEqual([{ type: 'assistant', content: 'hello' }]);
    const runtime = adapted as unknown as { setModel: () => string };
    expect(runtime.setModel()).toBe('bound-to-source');
  });

  it.each([
    ['ask', 'plan'],
    ['agent', 'default'],
    ['auto', 'default'],
  ] as const)('translates Mitzo %s mode to SDK %s mode', async (mode, sdkMode) => {
    const raw = fakeQuery([]);
    await adaptSdkQuery(raw).setPermissionMode!(mode);
    expect(raw.setPermissionMode).toHaveBeenCalledWith(sdkMode);
  });

  it.each([
    [null, 'null'],
    [[], 'array'],
    ['unexpected', 'string'],
  ])('rejects a malformed %s message with its runtime kind', async (message, kind) => {
    const consume = async () => {
      await adaptSdkQuery(fakeQuery([message]))
        [Symbol.asyncIterator]()
        .next();
    };

    await expect(consume()).rejects.toThrow(
      `Invalid SDK message: expected an object, received ${kind}`,
    );
  });
});
