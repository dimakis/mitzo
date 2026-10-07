import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionRegistry, resolvePending } from '@mitzo/harness';
import { createWebAccessTool } from '../web-access-tool.js';
import { REQUEST_WEB_ACCESS } from '../request-web-access.js';
const registries: SessionRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});
describe('web request through real Mitzo approval cards', () => {
  function fixture(
    provider: 'openai' | 'openai-codex' | 'google-vertex' | 'anthropic-vertex' = 'openai',
  ) {
    const registry = new SessionRegistry();
    registries.push(registry);
    const events: Record<string, unknown>[] = [];
    const abort = new AbortController();
    registry.register('owner', {
      sessionId: 'chat',
      accountBinding: {
        accountId: 'selected',
        accountLabel: 'Selected',
        provider,
        model: 'test',
        profileRevision: '1',
      },
      cwd: '/tmp',
      mode: 'auto',
      transport: {
        isOpen: () => true,
        send: (event) => {
          events.push(event);
        },
      },
      abortController: abort,
      sessionAllowList: new Set([REQUEST_WEB_ACCESS]),
    });
    const search = vi.fn().mockResolvedValue('Answer [source](https://example.com)');
    const execute = createWebAccessTool('chat', registry, search);
    return { registry, events, abort, search, execute };
  }
  it.each(['once', 'always', 'deny'] as const)(
    'uses an exact card despite Auto/cached grants and handles %s',
    async (decision) => {
      const f = fixture();
      const pending = f.execute(
        { operation: 'search', query: 'Revenue', reason: 'Verify current guidance' },
        f.abort.signal,
      );
      await vi.waitFor(() =>
        expect(f.events.some((event) => event.type === 'permission_request')).toBe(true),
      );
      const card = f.events.find((event) => event.type === 'permission_request')!;
      expect(card.approvalScope).toBe('request');
      expect(card.title).toBe('Allow this web search?');
      expect(f.search).not.toHaveBeenCalled();
      expect(resolvePending(card.permId as string, decision, undefined, 'chat')).toBe(true);
      const result = await pending;
      expect(result.isError).toBe(decision === 'deny');
      expect(f.search).toHaveBeenCalledTimes(decision === 'deny' ? 0 : 1);
      if (decision !== 'deny') {
        const next = f.execute(
          { operation: 'search', query: 'Another query', reason: 'Verify' },
          f.abort.signal,
        );
        await vi.waitFor(() =>
          expect(f.events.filter((event) => event.type === 'permission_request')).toHaveLength(2),
        );
        f.abort.abort();
        await next;
        expect(f.search).toHaveBeenCalledTimes(1);
      }
    },
  );
  it('cancels pending approval without dispatching a provider request', async () => {
    const f = fixture();
    const pending = f.execute({ operation: 'search', query: 'q', reason: 'why' }, f.abort.signal);
    await vi.waitFor(() =>
      expect(f.events.some((event) => event.type === 'permission_request')).toBe(true),
    );
    f.abort.abort();
    expect(await pending).toMatchObject({ isError: true });
    expect(f.search).not.toHaveBeenCalled();
  });
  it.each(['openai', 'openai-codex', 'google-vertex', 'anthropic-vertex'] as const)(
    'shows a local URL access card on the %s route and grants only the approved origin',
    async (provider) => {
      const f = fixture(provider);
      const pending = f.execute(
        {
          operation: 'request_access',
          url: 'http://127.0.0.1:8123/',
          reason: 'Read my Home Assistant instance',
        },
        f.abort.signal,
      );
      await vi.waitFor(() =>
        expect(f.events.some((event) => event.type === 'permission_request')).toBe(true),
      );
      const card = f.events.find((event) => event.type === 'permission_request')!;
      expect(card.title).toBe('Allow this session to read this website?');
      expect(String(card.toolInput)).toContain('http://127.0.0.1:8123');
      expect(String(card.toolInput)).toContain('127.0.0.1');
      expect(resolvePending(card.permId as string, 'once', undefined, 'chat')).toBe(true);
      expect(await pending).toMatchObject({ isError: false });
      expect(f.search).not.toHaveBeenCalled();
      expect(
        await f.execute(
          { operation: 'revoke_access', url: 'http://127.0.0.1:8123/', reason: 'Revoke approval' },
          f.abort.signal,
        ),
      ).toMatchObject({ isError: false });
    },
  );
});
