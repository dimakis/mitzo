import { afterEach, expect, it, vi } from 'vitest';
import type { AccountBinding } from '@mitzo/protocol';
import { NativeResponsesRunner } from '../native-responses-runner.js';
import { NativeResponsesStore } from '../native-responses-store.js';
const binding: AccountBinding = {
  accountId: 'work',
  accountLabel: 'Work API',
  provider: 'openai',
  model: 'model',
  profileRevision: 'pinned',
};
afterEach(() => vi.unstubAllGlobals());
it('rejects retained and new OpenAI custom execution before credentials, history writes or network', () => {
  const store = new NativeResponsesStore(':memory:');
  const history = {
    status: 'idle' as const,
    history: [{ role: 'user' as const, content: 'Historical request' }],
  };
  store.save('retained', binding, history);
  const getApiKey = vi.fn(async () => 'MUST NOT RESOLVE');
  const executeTool = vi.fn();
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  for (const conversationId of ['new', 'retained']) {
    expect(
      () =>
        new NativeResponsesRunner({
          conversationId,
          binding,
          getApiKey,
          systemPrompt: 'Never execute',
          maxTokens: 100,
          store,
          executeTool,
        }),
    ).toThrow('retired');
  }
  expect(getApiKey).not.toHaveBeenCalled();
  expect(executeTool).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(store.load('retained', binding)).toEqual(history);
  expect(store.load('new', binding)).toBeUndefined();
  store.close();
});

it('rejects the ordinary custom chat wrapper before connecting tools or resolving credentials', async () => {
  const { openResponsesChat } = await import('../responses-chat-session.js');
  const getApiKey = vi.fn();
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(
    openResponsesChat({ binding, getApiKey } as unknown as Parameters<typeof openResponsesChat>[0]),
  ).rejects.toThrow('retired');
  expect(getApiKey).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
