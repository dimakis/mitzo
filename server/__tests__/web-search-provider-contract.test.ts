import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { executeWebAccess } from '../request-web-access.js';
import { searchGemini, searchSdk } from '../web-search-adapters.js';

afterEach(() => vi.unstubAllGlobals());
const input = { operation: 'search' as const, query: 'Research', reason: 'Verify' };
const google = {
  accountId: 'selected-vertex',
  projectId: 'selected-project',
  region: 'global',
  getAccessToken: async () => 'fixture-token',
};
const workspaceRoot = mkdtempSync(join(tmpdir(), 'web-search-contract-'));
afterAll(() => rmSync(workspaceRoot, { recursive: true, force: true }));
const sdkRoute = {
  workspaceRoot,
  ...{
    model: 'selected-claude',
    env: { ANTHROPIC_API_KEY: 'fixture-token' },
    parentSessionId: 'parent',
    operationId: 'operation',
    executionStore: { registerInternalSdkExecution: vi.fn() },
  },
};
const grounded = {
  candidates: [
    {
      finishReason: 'STOP',
      content: { parts: [{ text: 'Answer' }] },
      groundingMetadata: {
        webSearchQueries: ['Research'],
        groundingChunks: [{ web: { uri: 'https://example.com', title: 'Source' } }],
        searchEntryPoint: { renderedContent: '<div>Search Suggestions</div>' },
      },
    },
  ],
};
function run(search: (query: string, signal: AbortSignal) => Promise<string>) {
  return executeWebAccess(input, new AbortController().signal, {
    isCurrent: () => true,
    approve: async () => ({ behavior: 'allow', updatedInput: input }),
    search,
    fetchPage: vi.fn(),
  });
}
it('leaves Gemini output at the selected provider limit and preserves grounding/display evidence', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(grounded)));
  vi.stubGlobal('fetch', fetch);
  const result = await run((query, signal) =>
    searchGemini(query, signal, google, 'gemini-2.5-flash'),
  );
  expect(result.isError).toBe(false);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).not.toHaveProperty(
    'generationConfig.maxOutputTokens',
  );
  expect(fetch.mock.calls[0][0]).toContain('selected-project');
  expect(JSON.parse(result.content)).toMatchObject({
    provider: 'google-vertex',
    searchSuggestions: '<div>Search Suggestions</div>',
  });
});
it.each([
  [400, 'request was rejected'],
  [401, 'authentication failed'],
  [403, 'access was refused'],
  [429, 'rate or quota'],
  [503, 'service was unavailable'],
])('preserves Gemini HTTP %s as a safe search failure', async (status, reason) => {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response('private-body fixture-token', { status: Number(status) }));
  vi.stubGlobal('fetch', fetch);
  const result = await run((query, signal) =>
    searchGemini(query, signal, google, 'gemini-2.5-flash'),
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain(reason);
  expect(result.content).not.toContain('private-body');
  expect(result.content).not.toContain('fixture-token');
  expect(fetch).toHaveBeenCalledOnce();
});
it('distinguishes a Gemini output limit from unsupported search or denied consent', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS' }] })),
      ),
  );
  const result = await run((query, signal) =>
    searchGemini(query, signal, google, 'gemini-2.5-flash'),
  );
  expect(result.content).toContain('output-token');
  expect(result.isError).toBe(true);
});
it('returns a safe reason for SDK startup errors on the selected route', async () => {
  const sdk = vi.fn(() =>
    (async function* () {
      yield { type: 'system' };
      throw new Error('private-body fixture-token');
    })(),
  );
  const result = await run((query, signal) => searchSdk(query, signal, sdkRoute, sdk));
  expect(result.isError).toBe(true);
  expect(result.content).toContain('Claude SDK search');
  expect(result.content).not.toContain('private-body');
  expect(result.content).not.toContain('fixture-token');
  expect(sdk).toHaveBeenCalledOnce();
});
it('rejects an SDK success subtype whose final provider request failed', async () => {
  const sdk = vi.fn(() =>
    (async function* () {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'WebSearch', id: 'search' }] },
      };
      yield {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'search', is_error: false }] },
      };
      yield {
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 429,
        result: 'private-body https://example.com',
      };
    })(),
  );
  const result = await run((query, signal) => searchSdk(query, signal, sdkRoute, sdk));
  expect(result.isError).toBe(true);
  expect(result.content).toContain('rate or quota');
  expect(result.content).not.toContain('private-body');
});

it('refuses SDK search before child startup after original owner authority is withdrawn', async () => {
  const sdk = vi.fn();
  const assertCurrent = vi.fn(async () => {
    throw new Error('private-owner-details');
  });
  const result = await run((query, signal) =>
    searchSdk(query, signal, { ...sdkRoute, assertCurrent }, sdk),
  );
  expect(result.isError).toBe(true);
  expect(result.content).not.toContain('private-owner-details');
  expect(sdk).not.toHaveBeenCalled();
});
it('withholds SDK output after original owner authority changes during the child search', async () => {
  let current = true;
  const assertCurrent = vi.fn(async () => {
    if (!current) throw Error('private-owner-details');
  });
  const sdk = vi.fn(() =>
    (async function* () {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'WebSearch', id: 'search' }] },
      };
      current = false;
      yield {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'search', is_error: false }] },
      };
      yield { type: 'result', subtype: 'success', result: 'stale answer https://example.com' };
    })(),
  );
  const result = await run((query, signal) =>
    searchSdk(query, signal, { ...sdkRoute, assertCurrent }, sdk),
  );
  expect(result.isError).toBe(true);
  expect(result.content).not.toContain('stale answer');
  expect(result.content).not.toContain('private-owner-details');
  expect(sdk).toHaveBeenCalledOnce();
});
