import { describe, expect, it, vi } from 'vitest';
import { searchCodex } from '../codex-approved-search.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';

function fixture(
  status = 'completed',
  searched = true,
  answer = 'Answer [Revenue](https://www.revenue.ie/)',
  searchItem: Record<string, unknown> = { status: 'completed' },
) {
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
          item: { type: 'webSearch', id: 'search-item', ...searchItem },
        });
      callbacks.onNotification('item/completed', {
        threadId: 'unrelated',
        turnId: 'search-turn',
        item: { type: 'agentMessage', text: 'wrong' },
      });
      callbacks.onNotification('item/completed', {
        threadId: 'search-thread',
        turnId: 'search-turn',
        item: { type: 'agentMessage', text: answer },
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
  it('rejects an answer without usable source URLs', async () => {
    const f = fixture('completed', true, 'An uncited answer');
    await expect(
      searchCodex('q', new AbortController().signal, {
        createClient: f.createClient,
        verify: f.verify,
        model: 'model',
        modelProvider: 'openai',
        cwd: '/tmp',
      }),
    ).rejects.toThrow();
  });
  it('uses a separate search-only thread without modifying the parent thread', async () => {
    const f = fixture();
    const result = await searchCodex('Revenue', new AbortController().signal, {
      createClient: f.createClient,
      verify: f.verify,
      model: 'selected-model',
      modelProvider: 'openshell',
      cwd: '/workspace',
      runtimeConfig: {
        'features.shell_tool': true,
        'mcp_servers.sandbox.command': 'executable',
        'mcp_servers.sandbox.enabled': true,
        mcp_servers: { nested: { command: 'executable', enabled: true } },
        'model_providers.openshell.base_url': 'https://provider.example',
      },
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
    const config = params.config as Record<string, unknown>;
    expect(config).not.toHaveProperty('mcp_servers');
    expect(config).not.toHaveProperty('mcp_servers.sandbox.command');
    expect(config).not.toHaveProperty('mcp_servers.sandbox.enabled');
    expect(config['model_providers.openshell.base_url']).toBe('https://provider.example');
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
  it.each([
    { status: 'failed' },
    { status: 'inProgress' },
    {},
    { status: 'completed', error: { message: 'search failed' } },
  ])('rejects an unsuccessful search item %j even with a sourced answer', async (item) => {
    const f = fixture('completed', true, 'Answer https://www.revenue.ie/', item);
    await expect(
      searchCodex('q', new AbortController().signal, {
        createClient: f.createClient,
        verify: f.verify,
        model: 'model',
        modelProvider: 'openai',
        cwd: '/tmp',
      }),
    ).rejects.toThrow('receipt');
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
