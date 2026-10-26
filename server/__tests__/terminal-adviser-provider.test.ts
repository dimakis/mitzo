import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ provider: 'openai' }));
vi.mock('../account-profiles.js', () => ({
  loadAccountProfiles: () => ({
    resolve: (_account: string, model: string) => ({
      accountId: 'test',
      provider: mocks.provider,
      model,
    }),
    validateModelSelection: () => {},
    apiProfile: () => ({ credentialRef: { kind: 'test' } }),
    apiRoutingProfile: () => ({ credentialRef: { kind: 'test' } }),
    isEnrolledOpenAIAccount: () => false,
    googleProfile: () => ({
      credentialRef: '/synthetic.json',
      projectId: 'test-project',
      region: 'global',
    }),
  }),
}));
vi.mock('../credentials.js', () => ({ credentials: { resolve: async () => 'synthetic-key' } }));
vi.mock('../connections-runtime.js', () => ({ getConnectionsRuntime: () => undefined }));
vi.mock('../openai-key-controller.js', () => ({ assertOpenAIKeyController: () => {} }));
vi.mock('../openai-key-operation-store.js', () => ({ openAIKeyResourceBindings: () => [] }));
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    async getAccessToken() {
      return 'synthetic-token';
    }
  },
}));
import { TerminalAdviser } from '../terminal-adviser.js';
import { createTerminalAdviserSession } from '../terminal-adviser-model.js';
beforeEach(() => {
  mocks.provider = 'openai';
});
afterEach(() => vi.unstubAllGlobals());
it.each([
  ['gemini-3-flash-preview', 'low', { thinkingLevel: 'LOW' }],
  ['gemini-3-flash-preview', 'high', { thinkingLevel: 'HIGH' }],
  ['gemini-3.1-pro-preview', 'medium', { thinkingLevel: 'MEDIUM' }],
  ['gemini-2.5-pro', 'low', { thinkingBudget: 512 }],
  ['gemini-2.5-pro', 'high', { thinkingBudget: 2048 }],
  ['gemini-2.5-flash', 'none', { thinkingBudget: 0 }],
  ['gemini-3.1-flash-lite', undefined, { thinkingLevel: 'LOW' }],
  ['gemini-3.5-flash-lite', undefined, { thinkingLevel: 'LOW' }],
])(
  'applies %s %s thinking in the actual intercepted provider request',
  async (model, reasoningEffort, thinkingConfig) => {
    mocks.provider = 'google-vertex';
    const fetcher = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            candidates: [
              { content: { role: 'model', parts: [{ text: 'Advice' }] }, finishReason: 'STOP' },
            ],
          }),
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    const adviser = new TerminalAdviser(createTerminalAdviserSession);
    await adviser.ask(
      'test-login',
      { accountId: 'test', model, reasoningEffort, messages: [{ role: 'user', content: 'Help' }] },
      new AbortController().signal,
    );
    expect(
      JSON.parse(fetcher.mock.calls[0][1]!.body as string).generationConfig.thinkingConfig,
    ).toEqual(thinkingConfig);
  },
);
it.each([
  ['google-vertex', 'gemini-3-flash-preview'],
  ['google-vertex', 'gemini-3.1-flash-lite'],
  ['google-vertex', 'gemini-3.5-flash-lite'],
])(
  'supports consecutive reviewed-text turns through the real %s %s adapter without tools',
  async (provider, model) => {
    mocks.provider = provider;
    const wire: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        wire.push(JSON.parse(init.body));
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'Check permissions.' }] },
                finishReason: 'STOP',
              },
            ],
          }),
        );
      }),
    );
    const adviser = new TerminalAdviser(createTerminalAdviserSession);
    const first = await adviser.ask(
      'test-login',
      {
        accountId: 'test',
        model,
        messages: [{ role: 'user', content: 'Help' }],
        output: 'Reviewed marker',
      },
      new AbortController().signal,
    );
    const transcript = [
      { role: 'user' as const, content: 'Help\n\nReviewed terminal output:\nReviewed marker' },
      { role: 'assistant' as const, content: first.text },
      { role: 'user' as const, content: 'Why?' },
    ];
    expect(
      (
        await adviser.ask(
          'test-login',
          { accountId: 'test', model, messages: transcript },
          new AbortController().signal,
        )
      ).text,
    ).toBe('Check permissions.');
    expect(wire).toHaveLength(2);
    if (model.includes('flash-lite'))
      expect(
        wire.map(
          (request) => (request.generationConfig as { thinkingConfig: unknown }).thinkingConfig,
        ),
      ).toEqual([{ thinkingLevel: 'LOW' }, { thinkingLevel: 'LOW' }]);
    expect(wire[1].tools).toBeUndefined();
    expect(wire[1].contents).toEqual(
      transcript.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      })),
    );
  },
);
