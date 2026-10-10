import { afterEach, expect, it, vi } from 'vitest';
import { ChatGptPlanAdviserAccounts } from '../chatgpt-plan-adviser.js';
import { TerminalPlanAdviserHost, setTerminalPlanAdviserHost } from '../terminal-plan-adviser.js';
import { createTerminalAdviserSession } from '../terminal-adviser-model.js';
import { TerminalAdviser } from '../terminal-adviser.js';
vi.mock('../account-profiles.js', () => ({
  loadAccountProfiles: () => {
    throw Error('Legacy account credentials must not be loaded');
  },
}));
afterEach(() => {
  setTerminalPlanAdviserHost(null);
  vi.unstubAllGlobals();
});
const id = 'chatgpt_plan_' + 'a'.repeat(64);
function setup() {
  const fetcher = vi.fn(
    async () =>
      new Response(
        'data: ' +
          JSON.stringify({
            type: 'response.created',
            response: { id: 'response', model: 'gpt-6-luna' },
          }) +
          '\n\ndata: ' +
          JSON.stringify({
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'message', id: 'message' },
          }) +
          '\n\ndata: ' +
          JSON.stringify({
            type: 'response.content_part.added',
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: '' },
          }) +
          '\n\ndata: ' +
          JSON.stringify({
            type: 'response.output_text.delta',
            output_index: 0,
            content_index: 0,
            delta: 'Check permissions.\n```sh\nls -la\n```',
          }) +
          '\n\ndata: ' +
          JSON.stringify({
            type: 'response.content_part.done',
            output_index: 0,
            content_index: 0,
          }) +
          '\n\ndata: ' +
          JSON.stringify({
            type: 'response.completed',
            response: {
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [
                    { type: 'output_text', text: 'Check permissions.\n```sh\nls -la\n```' },
                  ],
                },
              ],
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          }) +
          '\n\n',
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  const accounts = new ChatGptPlanAdviserAccounts({
    store: {
      load: () => ({ hostId: 'urn:uuid:test', accounts: [] }),
      save: () => {},
    },
  });
  const ready = vi.spyOn(accounts, 'ready').mockResolvedValue({
    assertCurrent: () => {},
    signal: new AbortController().signal,
    accessToken: () => 'synthetic-plan-token',
  });
  const host = new TerminalPlanAdviserHost({
    accounts,
    openBrowser: vi.fn(async () => {}),
    closeStore: () => {},
  });
  setTerminalPlanAdviserHost(host);
  return { host, accounts, ready, fetcher };
}
it('routes the selected subscription straight to text inference with no CLI or API billing fallback', async () => {
  const f = setup();
  const result = await new TerminalAdviser(createTerminalAdviserSession).ask(
    'operator',
    {
      accountId: id,
      model: 'gpt-6-luna',
      reasoningEffort: 'high',
      messages: [{ role: 'user', content: 'Help' }],
      output: 'Reviewed marker',
    },
    new AbortController().signal,
  );
  expect(result.commands).toEqual(['ls -la']);
  expect(f.ready).toHaveBeenCalledWith(id, 'gpt-6-luna', 'high', expect.any(AbortSignal));
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = f.fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://api.openai.com/v1/responses');
  const wire = JSON.parse(init.body as string);
  expect(wire.input).toEqual([
    { role: 'user', content: 'Help\n\nReviewed terminal output:\nReviewed marker' },
  ]);
  expect(wire.tools).toBeUndefined();
  expect(wire.reasoning.effort).toBe('high');
  expect(JSON.stringify(result)).not.toContain('synthetic');
});
it('refuses unavailable grants before a network request and does not try a legacy account', async () => {
  const f = setup();
  f.ready.mockRejectedValueOnce(Error('private-grant-detail'));
  await expect(
    createTerminalAdviserSession(
      { model: 'gpt-6-luna', systemPrompt: 'test', maxTokens: 4096, tools: [] },
      { accountId: id, model: 'gpt-6-luna', messages: [{ role: 'user', content: 'Help' }] },
    ),
  ).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled();
  setTerminalPlanAdviserHost(null);
  await expect(
    createTerminalAdviserSession(
      { model: 'gpt-6-luna', systemPrompt: 'test', maxTokens: 4096 },
      { accountId: id, model: 'gpt-6-luna', messages: [{ role: 'user', content: 'Help' }] },
    ),
  ).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled();
});

it('rejects config/model/thinking mismatches before obtaining a grant', async () => {
  const f = setup();
  await expect(
    f.host.session(
      {
        model: 'different',
        reasoningEffort: 'high',
        systemPrompt: 'test',
        maxTokens: 4096,
        tools: [],
      },
      {
        accountId: id,
        model: 'gpt-6-luna',
        reasoningEffort: 'low',
        messages: [{ role: 'user', content: 'Help' }],
      },
    ),
  ).rejects.toThrow();
  expect(f.ready).not.toHaveBeenCalled();
});
it('keeps sign-in status operator-owned and cancels the loopback listener', async () => {
  const f = setup(),
    begun = vi.spyOn(f.accounts, 'begin'),
    cancel = vi.spyOn(f.accounts, 'cancel');
  const attempt = await f.host.start('operator', Date.now() + 60000, 'Personal');
  expect(begun.mock.calls[0][1]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  expect(() => f.host.status('another', attempt.id)).toThrow();
  expect(f.host.status('operator', attempt.id).state).toBe('pending');
  await f.host.cancel('operator', attempt.id);
  expect(cancel).toHaveBeenCalledWith('operator');
  expect(f.host.status('operator', attempt.id).state).toBe('cancelled');
  await f.host.close();
});
