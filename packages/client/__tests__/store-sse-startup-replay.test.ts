import { expect, it, vi } from 'vitest';
import { createMitzoStore } from '../src/store.js';

it.each(['local', 'openshell'] as const)(
  'releases a %s startup snapshot before the send receipt without adopting its draft',
  async (runOn) => {
    let welcome!: (event: MessageEvent) => void;
    const source = {
      readyState: 1,
      addEventListener: vi.fn((type: string, listener: (event: MessageEvent) => void) => {
        if (type === 'welcome') welcome = listener;
      }),
      removeEventListener: vi.fn(),
      close: vi.fn(),
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null,
    };
    const emit = (data: Record<string, unknown>) =>
      source.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
    let accept!: (response: Response) => void;
    const fetch = vi.fn((url: string) => {
      if (url === '/local/send' || url === '/api/chat/runtime/send')
        return new Promise<Response>((resolve) => {
          accept = resolve;
        });
      if (url.includes('/messages'))
        return Promise.resolve(Response.json({ messages: [], current: null, cursor: 5 }));
      return Promise.resolve(Response.json(url.includes('/api/chat/') ? { applied: true } : []));
    });
    let saved = '[]';
    const store = createMitzoStore({
      transport: { fetch, connectWs: vi.fn() },
      wsConfig: {
        buildUrl: () => '',
        createWebSocket: () => {
          throw Error('SSE only');
        },
      },
      sseConfig: { baseUrl: '', fetch, createEventSource: () => source as unknown as EventSource },
      localFirstCommandConfig: {
        url: '/local/send',
        storage: {
          getItem: () => saved,
          setItem: (_, value) => {
            saved = value;
          },
        },
      },
    });
    const assigned = vi.fn();
    const delivered = vi.fn();
    try {
      welcome(new MessageEvent('welcome', { data: JSON.stringify({ connectionId: 'browser' }) }));
      expect(
        store.getState().sendLocalFirstCommand(
          {
            runOn,
            repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
            clientMsgId: 'startup',
            capabilityRevision: 'caps-r1',
            runtime: {
              account: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'r1' },
              harness: 'codex',
              targetId: 'mac',
              mode: 'agent',
            },
            selection: {
              version: 1,
              agent: { profileId: 'agent', revision: 1 },
              model: 'luna-fixture',
              thinking: 'low',
              context: { source: 'none', revision: null },
              permission: { mode: 'agent', revision: 0 },
            },
            payload: { text: 'Inspect' },
          },
          { draftId: 'draft', onSessionAssigned: assigned, onDelivery: delivered },
        ),
      ).toBe(true);
      emit({ type: 'session_id', sessionId: 'chat', clientMsgId: 'startup' });
      emit({
        type: 'session_reconnect_snapshot',
        sessionId: 'chat',
        cursor: 5,
        cursorValid: true,
        offerId: 'startup-offer',
        state: 'running',
      });
      await vi.waitFor(() =>
        expect(fetch.mock.calls.some(([url]) => url.endsWith('/reconnect-snapshot-applied'))).toBe(
          true,
        ),
      );
      expect(store.getState().sessions.active).toBeNull();
      expect(assigned).not.toHaveBeenCalled();
      expect(delivered).not.toHaveBeenCalledWith('accepted');
      accept(
        Response.json(
          {
            ok: true,
            clientMsgId: 'startup',
            sessionId: 'chat',
            dispatched: true,
            state: 'consumed',
          },
          { status: 202 },
        ),
      );
      await vi.waitFor(() => expect(store.getState().sessions.active).toBe('chat'));
      await vi.waitFor(() => expect(store.getState().historyLoading).toBe(false));
      // Use the actual SSE ordering implementation: an unreleased offer buffers these.
      emit({
        type: 'message_start',
        sessionId: 'chat',
        messageId: 'reply',
        seq: 6,
        prevSessionSeq: 5,
      });
      emit({
        type: 'block_start',
        sessionId: 'chat',
        messageId: 'reply',
        blockId: 'text',
        blockType: 'text',
        seq: 7,
        prevSessionSeq: 6,
      });
      emit({
        type: 'block_delta',
        sessionId: 'chat',
        messageId: 'reply',
        blockId: 'text',
        delta: 'Immediate output',
        seq: 8,
        prevSessionSeq: 7,
      });
      expect(store.getState().messages.current?.blocks.get('text')?.content).toBe(
        'Immediate output',
      );
      expect(source.close).not.toHaveBeenCalled();
    } finally {
      store.getState().invalidateAuthentication();
    }
  },
);
