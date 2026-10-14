import { describe, expect, it, vi } from 'vitest';
import { searchCodex } from '../codex-approved-search.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';

function fixture(
  status = 'completed',
  searched = true,
  answer = 'Answer [Revenue](https://www.revenue.ie/)',
  searchItem: Record<string, unknown> = {
    action: { type: 'search', query: 'Revenue' },
    results: null,
  },
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
          item: { type: 'webSearch', id: 'search-item', query: 'Revenue', ...searchItem },
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
    { query: undefined },
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

it.each([
  [false, undefined],
  [false, 65536],
  [true, undefined],
  [true, 65536],
] as const)(
  'retains independent native document preference in approved search (disabled=%s, runtime bytes=%s)',
  async (packBound, runtimeBytes) => {
    const f = fixture();
    const createClient = vi.fn(f.createClient);
    const search = searchCodex('Approved lookup', new AbortController().signal, {
      createClient,
      verify: f.verify,
      model: 'selected-model',
      modelProvider: 'openshell',
      cwd: '/workspace',
      disableProjectDocuments: packBound,
      ...(runtimeBytes === undefined
        ? {}
        : { runtimeConfig: { project_doc_max_bytes: runtimeBytes } }),
    });
    await search;
    const thread = f.request.mock.calls.find(([method]) => method === 'thread/start');
    expect(thread).toBeDefined();
    const config = thread![1].config as Record<string, unknown>;
    if (packBound) expect(config.project_doc_max_bytes).toBe(0);
    else if (runtimeBytes === undefined) expect(config).not.toHaveProperty('project_doc_max_bytes');
    else expect(config.project_doc_max_bytes).toBe(runtimeBytes);
  },
);

it('rejects trusted pack-origin search before child client creation independently of document preferences', async () => {
  const f = fixture();
  const createClient = vi.fn(f.createClient);
  await expect(
    searchCodex('lookup', new AbortController().signal, {
      createClient,
      verify: f.verify,
      model: 'selected',
      modelProvider: 'openai',
      cwd: '/tmp',
      agentContextSource: 'packs',
      disableProjectDocuments: false,
    }),
  ).rejects.toThrow(/trusted native continuation barrier/);
  expect(createClient).not.toHaveBeenCalled();
  expect(f.verify).not.toHaveBeenCalled();
});

// Pinned Codex 0.160.0 WebSearchItem has id/query/action; completion is the
// item/completed notification, not an invented item.status field.
it('accepts the pinned native search receipt through the shared approval boundary', async () => {
  const { executeWebAccess } = await import('../request-web-access.js');
  const f = fixture('completed', true, 'Answer https://www.revenue.ie/', {
    status: undefined,
    action: { type: 'search', query: 'Revenue' },
  });
  const input = { operation: 'search' as const, query: 'Revenue', reason: 'Research' };
  const result = await executeWebAccess(input, new AbortController().signal, {
    isCurrent: () => true,
    approve: async () => ({ behavior: 'allow', updatedInput: input }),
    search: (query, signal) =>
      searchCodex(query, signal, {
        createClient: f.createClient,
        verify: f.verify,
        model: 'selected-model',
        modelProvider: 'openshell',
        cwd: '/workspace',
      }),
    fetchPage: vi.fn(),
  });
  expect(result.isError).toBe(false);
  expect(result.content).toContain('https://www.revenue.ie/');
  expect(f.close).toHaveBeenCalledOnce();
});

it('keeps an approved native search running beyond 90 seconds until caller cancellation', async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const timer = new AbortController();
    setTimeout(() => timer.abort(), ms);
    return timer.signal;
  });
  const f = fixture();
  f.verify.mockImplementation(() => new Promise(() => {}));
  const abort = new AbortController();
  try {
    const result = searchCodex('Revenue', abort.signal, {
      createClient: f.createClient,
      verify: f.verify,
      model: 'model',
      modelProvider: 'openshell',
      cwd: '/workspace',
    });
    const rejected = expect(result).rejects.toThrow(/interrupted/i);
    await vi.advanceTimersByTimeAsync(90_001);
    expect(f.close).not.toHaveBeenCalled();
    abort.abort();
    await rejected;
  } finally {
    timeout.mockRestore();
    vi.useRealTimers();
  }
});

it('preserves a safe native failure reason without leaking provider exceptions', async () => {
  const { executeWebAccess } = await import('../request-web-access.js');
  const f = fixture();
  f.verify.mockRejectedValue(new Error('private-account-token-provider-body'));
  const input = { operation: 'search' as const, query: 'Revenue', reason: 'Research' };
  const result = await executeWebAccess(input, new AbortController().signal, {
    isCurrent: () => true,
    approve: async () => ({ behavior: 'allow', updatedInput: input }),
    search: (query, signal) =>
      searchCodex(query, signal, {
        createClient: f.createClient,
        verify: f.verify,
        model: 'model',
        modelProvider: 'openshell',
        cwd: '/workspace',
      }),
    fetchPage: vi.fn(),
  });
  expect(result.isError).toBe(true);
  expect(result.content).toContain('account verification failed');
  expect(result.content).not.toContain('private-account-token-provider-body');
  expect(f.request.mock.calls.some(([method]) => method === 'thread/start')).toBe(false);
});
