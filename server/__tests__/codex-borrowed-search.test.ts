import { describe, expect, it, vi } from 'vitest';
import { BorrowedCodexSearch } from '../codex-borrowed-search.js';
import { searchCodex } from '../codex-approved-search.js';

function fixture() {
  let current = true;
  const assertCurrent = vi.fn(async () => {
    if (!current) throw Error('Revoked owner');
  });
  const rpc = {
    initialize: vi.fn(),
    close: vi.fn(),
    request: vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === 'config/read') return { config: {} };
      if (method === 'thread/start')
        return { thread: { id: 'search-child' }, model: 'fixture-model', modelProvider: 'openai' };
      if (method === 'turn/start') {
        expect(params.threadId).toBe('search-child');
        child.notification('item/completed', {
          threadId: 'search-child',
          turnId: 'search-turn',
          item: { type: 'webSearch', id: 'receipt', query: 'Ireland' },
        });
        child.notification('item/completed', {
          threadId: 'search-child',
          turnId: 'search-turn',
          item: { type: 'agentMessage', text: 'Evidence https://example.test/source' },
        });
        child.notification('turn/completed', {
          threadId: 'search-child',
          turn: { id: 'search-turn', status: 'completed' },
        });
        return { turn: { id: 'search-turn' } };
      }
      return {};
    }),
  };
  const child = new BorrowedCodexSearch(rpc, 'parent-thread', assertCurrent);
  const run = (signal = new AbortController().signal) =>
    searchCodex('Ireland', signal, {
      createClient: (callbacks) => child.attach(callbacks),
      verify: assertCurrent,
      model: 'fixture-model',
      modelProvider: 'openai',
      cwd: '/offline',
      disableProjectDocuments: true,
    });
  return {
    child,
    rpc,
    run,
    revoke: () => {
      current = false;
    },
  };
}

describe('approved search on the original owned Codex transport', () => {
  it('returns cited search evidence without reattaching or closing the parent connection', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toContain('https://example.test/source');
    expect(f.rpc.initialize).not.toHaveBeenCalled();
    expect(f.rpc.close).not.toHaveBeenCalled();
    expect(f.rpc.request).toHaveBeenCalledWith('thread/unsubscribe', { threadId: 'search-child' });
    expect(f.rpc.request).not.toHaveBeenCalledWith('turn/interrupt', expect.anything());
    expect(f.rpc.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        ephemeral: true,
        dynamicTools: [],
        config: expect.objectContaining({
          web_search: 'live',
          project_doc_max_bytes: 0,
          'features.shell_tool': false,
        }),
      }),
    );
    expect(f.child.notification('turn/completed', { threadId: 'parent-thread' })).toBe(false);
  });

  it('refuses a revoked owner before starting a search', async () => {
    const f = fixture();
    f.revoke();
    await expect(f.run()).rejects.toThrow();
    expect(f.rpc.request).not.toHaveBeenCalled();
    expect(f.rpc.close).not.toHaveBeenCalled();
  });

  it('interrupts only its child when cancelled while turn/start is outstanding', async () => {
    const f = fixture();
    let release!: (value: unknown) => void;
    const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation((method, params) =>
      method === 'turn/start'
        ? new Promise((resolve) => {
            release = resolve;
          })
        : original(method, params),
    );
    const abort = new AbortController();
    const result = f.run(abort.signal);
    const rejected = expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    abort.abort();
    release({ turn: { id: 'pending-search' } });
    await rejected;
    expect(f.rpc.request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'search-child',
      turnId: 'pending-search',
    });
    expect(f.rpc.request).toHaveBeenCalledWith('thread/unsubscribe', { threadId: 'search-child' });
    expect(f.rpc.close).not.toHaveBeenCalled();
  });

  it('rejects a child that aliases the parent thread and never cleans up the parent', async () => {
    const f = fixture();
    const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) =>
      method === 'thread/start'
        ? { thread: { id: 'parent-thread' }, model: 'fixture-model', modelProvider: 'openai' }
        : original(method, params),
    );
    await expect(f.run()).rejects.toThrow();
    expect(f.rpc.request).not.toHaveBeenCalledWith('thread/unsubscribe', expect.anything());
    expect(f.rpc.request).not.toHaveBeenCalledWith('turn/start', expect.anything());
  });
});
