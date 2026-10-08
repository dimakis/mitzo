import { EventStore } from '../event-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { query } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { searchOpenAI, searchGemini, searchSdk } from '../web-search-adapters.js';
const executionStore = new EventStore(':memory:');
executionStore.upsertSession({ sessionId: 'parent' });
const workspaceRoot = mkdtempSync(join(tmpdir(), 'sdk-search-test-'));
const owner = {
  executionStore,
  parentSessionId: 'parent',
  operationId: 'tool-call',
  workspaceRoot,
};
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  executionStore.close();
  rmSync(workspaceRoot, { recursive: true, force: true });
});
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
          message: { content: [{ type: 'tool_use', name: 'WebSearch', id: 'search-call' }] },
        };
        yield {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'search-call', is_error: false }],
          },
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
        { ...owner, env, model: 'selected-claude' },
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
      persistSession: false,
    });
  });
  it('registers owned execution before SDK startup and isolates storage and session environment', async () => {
    const env = {
      ANTHROPIC_API_KEY: 'explicit-account',
      MITZO_SESSION_ID: 'parent-task',
      MITZO_REPO_MGMT: '/parent/workspace',
      CLAUDE_CONFIG_DIR: '/selected/account',
    };
    const sdk = vi.fn((request: Parameters<typeof query>[0]) => {
      const id = request.options!.sessionId!;
      expect(executionStore.getInternalSdkExecution(id)).toMatchObject({
        parentSessionId: 'parent',
        operationId: 'tool-call',
        purpose: 'web_search',
        cwd: request.options!.cwd,
      });
      expect(executionStore.getSession(id)).toBeNull();
      expect(() => executionStore.upsertSession({ sessionId: id })).toThrow();
      expect(request.options!.cwd).toContain(workspaceRoot);
      expect(request.options!.env).toMatchObject({
        ANTHROPIC_API_KEY: 'explicit-account',
        CLAUDE_CONFIG_DIR: '/selected/account',
      });
      expect(request.options!.env).not.toHaveProperty('MITZO_SESSION_ID');
      expect(request.options!.env).not.toHaveProperty('MITZO_REPO_MGMT');
      return (async function* () {
        yield {
          type: 'assistant',
          session_id: id,
          message: { content: [{ type: 'tool_use', name: 'WebSearch', id: 'search' }] },
        };
        yield {
          type: 'user',
          session_id: id,
          message: { content: [{ type: 'tool_result', tool_use_id: 'search' }] },
        };
        yield {
          type: 'result',
          session_id: id,
          subtype: 'success',
          result: 'Answer https://example.com',
        };
      })();
    });
    expect(
      await searchSdk(
        'query',
        new AbortController().signal,
        { ...owner, env, model: 'selected-claude' },
        sdk,
      ),
    ).toContain('Answer');
    expect(env.MITZO_SESSION_ID).toBe('parent-task');
  });
  it('does not dispatch when durable ownership cannot be recorded', async () => {
    const sdk = vi.fn();
    const failed = {
      registerInternalSdkExecution() {
        throw new Error('Ownership unavailable');
      },
    };
    await expect(
      searchSdk(
        'query',
        new AbortController().signal,
        { ...owner, executionStore: failed, env: {}, model: 'selected-claude' },
        sdk,
      ),
    ).rejects.toThrow('Ownership unavailable');
    expect(sdk).not.toHaveBeenCalled();
  });
  it('rejects SDK events belonging to a different execution', async () => {
    const sdk = () =>
      (async function* () {
        yield { type: 'system', session_id: 'unexpected' };
      })();
    await expect(
      searchSdk(
        'query',
        new AbortController().signal,
        { ...owner, env: {}, model: 'selected-claude' },
        sdk,
      ),
    ).rejects.toThrow(/identity/i);
  });
  it('rejects a failed SDK search even if the model returns a plausible answer', async () => {
    const sdk = () =>
      (async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'WebSearch', id: 'search-call' }] },
        };
        yield {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'search-call', is_error: true }],
          },
        };
        yield { type: 'result', subtype: 'success', result: 'Guess [source](https://example.com)' };
      })();
    await expect(
      searchSdk('q', new AbortController().signal, { ...owner, env: {}, model: 'model' }, sdk),
    ).rejects.toThrow();
  });
});
