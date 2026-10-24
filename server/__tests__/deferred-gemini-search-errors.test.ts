import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeWebAccess } from '../request-web-access.js';
import { searchGemini } from '../web-search-adapters.js';
afterEach(() => vi.unstubAllGlobals());
const input = { operation: 'search' as const, query: 'approved query', reason: 'Verify sources' };
async function run(response: Response | Error) {
  const fetch = vi.fn();
  if (response instanceof Error) fetch.mockRejectedValue(response);
  else fetch.mockResolvedValue(response);
  vi.stubGlobal('fetch', fetch);
  const result = await executeWebAccess(input, new AbortController().signal, {
    isCurrent: () => true,
    approve: async () => ({ behavior: 'allow', updatedInput: input }),
    search: (query, signal) =>
      searchGemini(
        query,
        signal,
        {
          accountId: 'selected',
          projectId: 'selected-project',
          region: 'global',
          getAccessToken: async () => 'fixture-key',
        },
        'gemini-2.5-pro',
      ),
    fetchPage: vi.fn(),
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/^Approved web access failed: Gemini\/Vertex search /);
  expect(result.content).not.toContain('private-provider-body');
  expect(result.content).not.toContain('fixture-key');
  return result.content;
}
const json = (body: unknown) => new Response(JSON.stringify(body));
describe('approved deferred Gemini search error boundary', () => {
  it.each([
    [400, 'request was rejected (HTTP 400)'],
    [401, 'authentication failed (HTTP 401)'],
    [403, 'access was refused (HTTP 403)'],
    [429, 'rate or quota limit was reached (HTTP 429)'],
    [500, 'service was unavailable (HTTP 500)'],
    [503, 'service was unavailable (HTTP 503)'],
    [418, 'request failed (HTTP 418)'],
  ])('sanitizes HTTP %s without another account or raw body', async (status, detail) => {
    expect(await run(new Response('private-provider-body', { status: Number(status) }))).toContain(
      detail,
    );
  });
  it('distinguishes exhausted output budget and unknown noncompletion without raw provider details', async () => {
    expect(await run(json({ candidates: [{ finishReason: 'MAX_TOKENS' }] }))).toContain(
      'exhausted its output-token budget',
    );
    expect(await run(json({ candidates: [{ finishReason: 'private-provider-body' }] }))).toContain(
      'did not complete',
    );
  });
  it('requires grounding receipt and citations even when a model supplies an answer', async () => {
    expect(
      await run(
        json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Guess' }] } }] }),
      ),
    ).toContain('returned no complete grounding receipt');
    expect(
      await run(
        json({
          candidates: [
            {
              finishReason: 'STOP',
              content: { parts: [{ text: 'Answer' }] },
              groundingMetadata: {
                webSearchQueries: ['approved query'],
                groundingChunks: [],
                searchEntryPoint: { renderedContent: '<div>Suggestions</div>' },
              },
            },
          ],
        }),
      ),
    ).toContain('completed but returned no cited answer');
  });
  it.each([new Response('private-provider-body'), json({ candidates: 'private-provider-body' })])(
    'sanitizes malformed output',
    async (response) => {
      expect(await run(response)).toContain('returned an invalid response');
    },
  );
  it('sanitizes transport failures and keeps the selected route', async () => {
    expect(await run(Error('private-provider-body fixture-key'))).toContain(
      'could not complete on the selected route',
    );
  });
});
