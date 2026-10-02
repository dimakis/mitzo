import { describe, expect, it, vi } from 'vitest';
import { searchCodex } from '../codex-approved-search.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';

function fixture(status = 'completed', searched = true) {
  let callbacks: CodexLifecycleTransport;
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'config/read') return { config: { mcp_servers: { inherited: {} } } };
    if (method === 'thread/start')
      return {
        thread: { id: 'search-thread' },
        model: params.model,
        modelProvider: params.modelProvider,
      };
    if (method === 'turn/start') {
      if (searched)
        callbacks.onNotification('item/completed', {
          threadId: 'search-thread',
          turnId: 'search-turn',
          item: { type: 'webSearch', id: 'search-item' },
        });
      callbacks.onNotification('item/completed', {
        threadId: 'unrelated',
        turnId: 'search-turn',
        item: { type: 'agentMessage', text: 'wrong' },
      });
      callbacks.onNotification('item/completed', {
        threadId: 'search-thread',
        turnId: 'search-turn',
        item: { type: 'agentMessage', text: 'Answer [Revenue](https://www.revenue.ie/)' },
      });
      callbacks.onNotification('turn/completed', {
        threadId: 'search-thread',
        turn: { id: 'search-turn', status },
      });
      return { turn: { id: 'search-turn' } };
    }
    return {};
  });
  const close = vi.fn();
  const createClient = (value: CodexLifecycleTransport) => {
    callbacks = value;
    return { initialize: async () => {}, request, close };
  };
  const verify = vi.fn().mockResolvedValue(undefined);
  return { createClient, verify, request, close, callbacks: () => callbacks };
}
describe('approved Codex search on the bound runtime', () => {
  it('uses a separate search-only thread without modifying the parent thread', async () => {
    const f = fixture();
    const result = await searchCodex('Revenue', new AbortController().signal, {
      createClient: f.createClient,
      verify: f.verify,
      model: 'selected-model',
      modelProvider: 'openshell',
      cwd: '/workspace',
      runtimeConfig: { 'features.shell_tool': true },
    });
    expect(result).toContain('Revenue');
    expect(result).not.toContain('wrong');
    expect(f.verify).toHaveBeenCalledTimes(1);
    const params = f.request.mock.calls.find(([method]) => method === 'thread/start')![1];
    expect(params).toMatchObject({
      model: 'selected-model',
      modelProvider: 'openshell',
      config: {
        web_search: 'live',
        'features.shell_tool': false,
        'features.code_mode_host': false,
        'mcp_servers.inherited.enabled': false,
      },
    });
    expect(f.request.mock.calls.some(([method]) => method === 'thread/resume')).toBe(false);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['failed', true],
    ['completed', false],
  ] as const)('rejects %s or unsearched output', async (status, searched) => {
    const f = fixture(status, searched);
    await expect(
      searchCodex('q', new AbortController().signal, {
        createClient: f.createClient,
        verify: f.verify,
        model: 'model',
        modelProvider: 'openai',
        cwd: '/tmp',
      }),
    ).rejects.toThrow();
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('never starts a thread when account verification fails', async () => {
    const f = fixture();
    f.verify.mockRejectedValue(new Error('Account changed'));
    await expect(
      searchCodex('q', new AbortController().signal, {
        createClient: f.createClient,
        verify: f.verify,
        model: 'model',
        modelProvider: 'openai',
        cwd: '/tmp',
      }),
    ).rejects.toThrow();
    expect(f.request.mock.calls.some(([method]) => method === 'thread/start')).toBe(false);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
});
