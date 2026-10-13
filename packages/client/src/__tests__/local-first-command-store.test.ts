import { expect, it, vi } from 'vitest';
import { createMitzoStore } from '../store.js';
const channel = vi.hoisted(() => ({
  listener: (_event: Record<string, unknown>) => {},
  id: null as string | null,
  send: vi.fn(),
}));
vi.mock('../sse-connection.js', () => ({
  SseConnection: class {
    onMessage(fn: typeof channel.listener) {
      channel.listener = fn;
    }
    connect() {}
    getConnectionId() {
      return channel.id;
    }
    isConnected() {
      return !!channel.id;
    }
    send = channel.send;
    getLastSeq() {
      return 0;
    }
    trackSeq() {}
    getTrackedSessions() {
      return [];
    }
    clearSession() {}
    clearPendingSends() {}
    advanceSendScope() {}
    blockAuthentication() {}
    invalidateAuthentication() {}
    restoreAuthentication() {}
    checkAndReconnect() {}
    sendSuspend() {}
  },
}));
const request = {
  runOn: 'local' as const,
  repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
  clientMsgId: 'local-first',
  capabilityRevision: 'caps-r1',
  runtime: {
    account: { accountId: 'personal', provider: 'openai-codex' as const, profileRevision: 'r1' },
    harness: 'codex' as const,
    targetId: 'mac',
    mode: 'agent' as const,
  },
  selection: {
    version: 1 as const,
    agent: { profileId: 'agent', revision: 1 },
    model: 'luna-fixture',
    thinking: 'low',
    context: { source: 'none' as const, revision: null },
    permission: { mode: 'agent' as const, revision: 0 as const },
  },
  payload: { text: 'Inspect' },
};
function setup() {
  let raw: string | null = null;
  channel.id = null;
  channel.send.mockClear();
  const fetch = vi.fn().mockImplementation((path: string) =>
    Promise.resolve(
      path === '/local/send'
        ? new Response(
            JSON.stringify({
              ok: true,
              clientMsgId: 'local-first',
              sessionId: 'owned-session',
              dispatched: true,
              state: 'consumed',
            }),
            { status: 202 },
          )
        : new Response('[]'),
    ),
  );
  const store = createMitzoStore({
    transport: { fetch },
    wsConfig: {
      buildUrl: () => '',
      createWebSocket: () => {
        throw Error('Unexpected WebSocket');
      },
    },
    sseConfig: { baseUrl: '', fetch },
    localFirstCommandConfig: {
      url: '/local/send',
      storage: {
        getItem: () => raw,
        setItem: (_: string, value: string) => {
          raw = value;
        },
      },
    },
  });
  return { store, fetch };
}
it('requires authenticated live SSE and then uses only exact dedicated POST with current connection identity', async () => {
  const { store, fetch } = setup();
  expect(store.getState().sendLocalFirstCommand(request)).toBe(false);
  expect(fetch).not.toHaveBeenCalledWith('/local/send', expect.anything());
  channel.id = 'live-operator-sse';
  const assigned = vi.fn();
  const delivered = vi.fn();
  expect(
    store
      .getState()
      .sendLocalFirstCommand(request, { onSessionAssigned: assigned, onDelivery: delivered }),
  ).toBe(true);
  await vi.waitFor(() => expect(assigned).toHaveBeenCalledWith('owned-session'));
  const call = fetch.mock.calls.find(([url]) => url === '/local/send')!;
  expect(JSON.parse(call[1].body)).toEqual(request);
  expect(call[1].headers['X-Connection-ID']).toBe('live-operator-sse');
  expect(delivered).toHaveBeenCalledWith('accepted');
  expect(store.getState().sessions.active).toBe('owned-session');
  expect(channel.send.mock.calls.some(([body]) => body.type === 'send')).toBe(false);
  expect(store.getState().sendLocalFirstCommand({ ...request, clientMsgId: 'followup' })).toBe(
    false,
  );
});
it('retains request after logout and never automatically retries on a new authenticated connection', async () => {
  const { store, fetch } = setup();
  channel.id = 'first-sse';
  fetch.mockRejectedValue(Error('lost'));
  store.getState().sendLocalFirstCommand(request);
  await vi.waitFor(() => expect(store.getState().localCommand?.state).toBe('uncertain'));
  store.getState().invalidateAuthentication();
  channel.id = 'new-sse';
  store.getState().restoreAuthentication();
  expect(fetch.mock.calls.filter(([path]) => path === '/local/send')).toHaveLength(1);
  expect(store.getState().localCommand?.request).toEqual(request);
});
it('keeps delayed assignment with its originating draft after New and exposes recovery without adopting the new composer', async () => {
  const { store, fetch } = setup();
  channel.id = 'live-sse';
  let complete!: (response: Response) => void;
  fetch.mockImplementation((path) =>
    path === '/local/send'
      ? new Promise<Response>((resolve) => {
          complete = resolve;
        })
      : Promise.resolve(new Response('[]')),
  );
  const assigned = vi.fn();
  store
    .getState()
    .sendLocalFirstCommand(request, { draftId: 'original-draft', onSessionAssigned: assigned });
  store.getState().newSession();
  complete(
    new Response(
      JSON.stringify({
        ok: true,
        clientMsgId: request.clientMsgId,
        sessionId: 'original-session',
        dispatched: true,
        state: 'consumed',
      }),
      { status: 202 },
    ),
  );
  await vi.waitFor(() => expect(store.getState().localCommand?.state).toBe('consumed'));
  expect(store.getState().sessions.active).toBeNull();
  expect(store.getState().localCommand?.originDraftId).toBe('original-draft');
  expect(store.getState().localCommand?.sessionId).toBe('original-session');
  expect(assigned).toHaveBeenCalledWith('original-session');
});
