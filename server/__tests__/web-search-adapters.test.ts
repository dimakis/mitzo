import type { query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchOpenAI, searchGemini, searchSdk } from '../web-search-adapters.js';
afterEach(() => vi.unstubAllGlobals());
describe('selected-account native search adapters', () => {
  it('uses only the explicit OpenAI key/model and requires hosted search', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'completed',
          output: [
            { type: 'web_search_call', status: 'completed' },
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: 'Answer',
                  annotations: [
                    { type: 'url_citation', url: 'https://www.revenue.ie/', title: 'Revenue' },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const output = await searchOpenAI(
      'Revenue',
      new AbortController().signal,
      'explicit-key',
      'selected-model',
    );
    expect(output).toContain('https://www.revenue.ie/');
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer explicit-key');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      model: 'selected-model',
      tools: [{ type: 'web_search' }],
      tool_choice: { type: 'web_search' },
      store: false,
    });
  });
  it('never returns a model answer without a search receipt', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'guess' }] }],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(
      searchOpenAI('Revenue', new AbortController().signal, 'key', 'model'),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('uses the explicit Vertex project, region, token and model, with no function tools', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'STOP',
              content: { parts: [{ text: 'Answer' }] },
              groundingMetadata: {
                webSearchQueries: ['Revenue'],
                groundingChunks: [{ web: { uri: 'https://www.revenue.ie/', title: 'Revenue' } }],
                searchEntryPoint: { renderedContent: '<div>Google suggestions</div>' },
              },
            },
          ],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const output = await searchGemini(
      'Revenue',
      new AbortController().signal,
      {
        accountId: 'vertex-account',
        projectId: 'my-project',
        region: 'global',
        getAccessToken: async () => 'vertex-token',
      },
      'gemini-2.5-flash',
    );
    expect(fetch.mock.calls[0][0]).toContain(
      '/projects/my-project/locations/global/publishers/google/models/gemini-2.5-flash:generateContent',
    );
    expect(JSON.parse(fetch.mock.calls[0][1].body).tools).toEqual([{ googleSearch: {} }]);
    expect(JSON.parse(output)).toMatchObject({
      provider: 'google-vertex',
      searchSuggestions: '<div>Google suggestions</div>',
    });
  });
  it('does not fall back after a provider rejection', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('denied', { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    await expect(
      searchOpenAI('Revenue', new AbortController().signal, 'key', 'model'),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('restricts SDK search to WebSearch on the exact account environment and selected model', async () => {
    const sdk = vi.fn((_options: Parameters<typeof query>[0]) =>
      (async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'WebSearch' }] },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'Answer [source](https://example.com)',
        };
      })(),
    );
    const env = { ANTHROPIC_API_KEY: 'account-key' };
    expect(
      await searchSdk(
        'Revenue',
        new AbortController().signal,
        { env, cwd: '/tmp', model: 'selected-claude' },
        sdk,
      ),
    ).toContain('source');
    expect(sdk.mock.calls[0][0].options).toMatchObject({
      env,
      model: 'selected-claude',
      tools: ['WebSearch'],
      strictMcpConfig: true,
      mcpServers: {},
      settingSources: [],
      maxTurns: 3,
    });
  });
});
