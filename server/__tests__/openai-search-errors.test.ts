import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeWebAccess } from '../request-web-access.js';
import { searchOpenAI } from '../web-search-adapters.js';

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
    search: (query, signal) => searchOpenAI(query, signal, 'fixture-key', 'fixture-model'),
    fetchPage: vi.fn(),
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/^Approved web access failed: OpenAI search /);
  expect(result.content).not.toContain('private-provider-body');
  expect(result.content).not.toContain('fixture-key');
  return result.content;
}
const json = (body: unknown) => new Response(JSON.stringify(body));

describe('approved OpenAI search failures', () => {
  it.each([
    [400, 'request was rejected (HTTP 400)'],
    [401, 'authentication failed (HTTP 401)'],
    [403, 'access was refused (HTTP 403)'],
    [429, 'rate or quota limit was reached (HTTP 429)'],
    [500, 'service was unavailable (HTTP 500)'],
    [503, 'service was unavailable (HTTP 503)'],
    [418, 'request failed (HTTP 418)'],
  ])(
    'reports HTTP %s without leaking the response or changing accounts',
    async (status, detail) => {
      expect(await run(new Response('private-provider-body', { status }))).toContain(detail);
    },
  );
  it('distinguishes an exhausted output budget from provider rejection', async () => {
    expect(
      await run(
        json({
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [],
        }),
      ),
    ).toContain('exhausted its output-token budget before a complete sourced answer');
  });
  it('does not expose unknown incomplete reasons', async () => {
    expect(
      await run(
        json({
          status: 'incomplete',
          incomplete_details: { reason: 'private-provider-body' },
          output: [],
        }),
      ),
    ).toContain('returned an incomplete response');
  });
  it('reports a failed response without exposing its error', async () => {
    expect(
      await run(
        json({ status: 'failed', error: { message: 'private-provider-body' }, output: [] }),
      ),
    ).toContain('did not complete');
  });
  it('requires a successful search receipt even when an answer is present', async () => {
    expect(
      await run(
        json({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Guess' }] }],
        }),
      ),
    ).toContain('returned no completed web-search receipt');
  });
  it('distinguishes missing citations after a successful search', async () => {
    expect(
      await run(
        json({
          status: 'completed',
          output: [
            { type: 'web_search_call', status: 'completed' },
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'Answer', annotations: [] }],
            },
          ],
        }),
      ),
    ).toContain('completed but returned no cited answer');
  });
  it.each([
    new Response('private-provider-body'),
    json({ status: 'completed', output: 'private-provider-body' }),
  ])('reports malformed provider output without leaking it', async (response) => {
    expect(await run(response)).toContain('returned an invalid response');
  });
  it('reports a transport failure without forwarding raw exceptions', async () => {
    expect(await run(new Error('private-provider-body fixture-key'))).toContain(
      'could not connect to the provider',
    );
  });
});
