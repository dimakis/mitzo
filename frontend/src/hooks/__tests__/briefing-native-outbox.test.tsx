// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createMitzoStore, WS_READY_STATE, type WebSocketLike } from '@mitzo/client';
import { briefingCommandHandoff, localBriefingConversation } from '../../lib/briefing-registration';
import { apiFetch } from '../../lib/api-fetch';
import { createReviewedOutboxStorage } from '../../lib/reviewed-outbox-storage';
vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
  getApiBaseUrl: () => '',
  AUTH_LOST_EVENT: 'mitzo:auth-lost',
}));
const source = {
  kind: 'briefing' as const,
  date: '2026-10-09',
  revision: 'a'.repeat(64),
  content: 'Captured original briefing',
};
const selection = { accountId: 'work', model: 'luna', reasoningEffort: 'low' };
class Socket implements WebSocketLike {
  readyState: number = WS_READY_STATE.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: Record<string, unknown>[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = WS_READY_STATE.CLOSED;
    this.onclose?.();
  }
  emit(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  open() {
    this.readyState = WS_READY_STATE.OPEN;
    this.onopen?.({});
    this.emit({ type: 'welcome', protocolVersion: 2, connectionId: 'socket-1' });
  }
}
afterEach(() => {
  localStorage.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const url = '/api/chat/send';
function cold(sse = false) {
  const socket = new Socket();
  const store = createMitzoStore({
    transport: { fetch: apiFetch },
    wsConfig: { buildUrl: () => 'ws://fixture.test', createWebSocket: () => socket },
    sendHandoff: briefingCommandHandoff,
    reviewedSendConfig: {
      url,
      storage: createReviewedOutboxStorage(localStorage, 'https://fixture.test/api/chat/send'),
    },
    ...(sse
      ? {
          sseConfig: {
            baseUrl: '',
            fetch: apiFetch,
            outboxStorage: sessionStorage,
            createEventSource: () =>
              ({
                readyState: 0,
                onmessage: null,
                onerror: null,
                addEventListener() {},
                removeEventListener() {},
                close() {},
              }) as unknown as EventSource,
          },
        }
      : {}),
    initiallyAuthenticated: false,
  });
  return { store, socket };
}
it.each(['before socket opens', 'accepted ACK lost'] as const)(
  'recovers native reviewed delivery after cold recreation %s with the original command and one logical turn',
  async (mode) => {
    vi.useFakeTimers();
    const delivered: Record<string, unknown>[] = [];
    const accepted = new Map<string, string>();
    let restore = false;
    let dispatches = 0;
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (String(path) === url) {
        const command = JSON.parse(String(init?.body));
        delivered.push(command);
        expect(new Headers(init?.headers).has('X-Connection-ID')).toBe(false);
        if (mode === 'before socket opens' && !restore) return new Promise<Response>(() => {});
        if (!accepted.has(command.clientMsgId)) {
          accepted.set(command.clientMsgId, 'native-assigned');
          dispatches++;
        }
        if (!restore) throw new Error('Accepted response lost');
        return new Response(
          JSON.stringify({
            accepted: true,
            clientMsgId: command.clientMsgId,
            sessionId: accepted.get(command.clientMsgId),
          }),
          { status: 202 },
        );
      }
      if (String(path).endsWith('/meta')) return new Response(JSON.stringify({ isHidden: false }));
      return new Response('[]', { status: init?.method === 'POST' ? 503 : 200 });
    });
    const first = cold();
    first.store.getState().restoreAuthentication();
    if (mode === 'accepted ACK lost') first.socket.open();
    first.store.getState().setPendingSession({
      prompt: 'Discuss original report',
      context: 'Briefing',
      briefing: { date: source.date, revision: source.revision },
      accountSelection: selection,
      sourceSnapshots: [source],
    });
    first.store.getState().sendPendingSession();
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toHaveLength(1);
    const original = delivered[0];
    expect(first.socket.sent.filter((message) => message.type === 'send')).toEqual([]);
    await expect(localBriefingConversation(source, selection)).rejects.toThrow(
      'awaiting assignment',
    );
    // A replacement WKWebView has no sessionStorage, pending launch, or assignment observers.
    sessionStorage.clear();
    restore = true;
    const fresh = cold();
    expect(fresh.store.getState().pendingSession).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toHaveLength(1); // restoration waits for explicit authenticated startup
    fresh.store.getState().restoreAuthentication();
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toEqual(original);
    expect(dispatches).toBe(1);
    await expect(localBriefingConversation(source, selection)).resolves.toBe('native-assigned');
    expect(fresh.socket.sent.filter((message) => message.type === 'send')).toEqual([]);
    expect(
      JSON.parse(
        createReviewedOutboxStorage(localStorage, 'https://fixture.test/api/chat/send').getItem(
          'queue',
        )!,
      ),
    ).toEqual([]);
  },
);
it('does not dispatch or leave an awaiting receipt when native full-command storage is unavailable', async () => {
  vi.useFakeTimers();
  const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.startsWith('mitzo-reviewed-send-outbox:')) throw new Error('Quota');
    original.call(this, key, value);
  });
  vi.mocked(apiFetch).mockResolvedValue(new Response('[]'));
  const { store } = cold();
  store.getState().restoreAuthentication();
  store
    .getState()
    .sendMessage('Discuss original report', { ...selection, sourceSnapshots: [source] });
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => String(path) === url)).toEqual([]);
  await expect(localBriefingConversation(source, selection)).resolves.toBeNull();
  expect(store.getState().sendError).toContain('could not be retained for recovery');
});
it('retains an ambiguously accepted reviewed command through auth loss and cold authenticated recovery', async () => {
  vi.useFakeTimers();
  const commands: Record<string, unknown>[] = [];
  let accepting = false;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (String(path) === url) {
      const body = JSON.parse(String(init?.body));
      commands.push(body);
      if (!accepting) return new Promise<Response>(() => {});
      return new Response(
        JSON.stringify({
          accepted: true,
          clientMsgId: body.clientMsgId,
          sessionId: 'auth-assigned',
        }),
        { status: 202 },
      );
    }
    if (String(path).endsWith('/meta')) return new Response(JSON.stringify({ isHidden: false }));
    return new Response('[]', { status: init?.method === 'POST' ? 503 : 200 });
  });
  const first = cold();
  first.store.getState().restoreAuthentication();
  first.store
    .getState()
    .sendMessage('Discuss original report', { ...selection, sourceSnapshots: [source] });
  await vi.advanceTimersByTimeAsync(0);
  expect(commands).toHaveLength(1);
  first.store.getState().invalidateAuthentication();
  first.store.getState().invalidateAuthentication();
  sessionStorage.clear();
  accepting = true;
  const fresh = cold();
  await vi.advanceTimersByTimeAsync(0);
  expect(commands).toHaveLength(1);
  fresh.store.getState().restoreAuthentication();
  await vi.advanceTimersByTimeAsync(0);
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  await expect(localBriefingConversation(source, selection)).resolves.toBe('auth-assigned');
});

it('reattaches the foreground native receiver and restores events missed before HTTP acknowledgement', async () => {
  vi.useFakeTimers();
  let command: Record<string, unknown>;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (String(path) === url) {
      command = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          accepted: true,
          clientMsgId: command.clientMsgId,
          sessionId: 'foreground',
        }),
        { status: 202 },
      );
    }
    if (String(path).includes('/messages?transcript=1'))
      return new Response(
        JSON.stringify({
          messages: [
            {
              role: 'user',
              messageId: command.clientMsgId,
              text: 'Discuss original report',
              blocks: [
                { blockId: 'intent', blockType: 'text', content: 'Discuss original report' },
              ],
              sourceSnapshots: [source],
            },
          ],
          current: {
            messageId: 'response',
            startedSeq: 2,
            blocks: [
              {
                blockId: 'calendar',
                blockType: 'text',
                content: 'Calendar details emitted before ACK',
                done: false,
              },
            ],
          },
          cursor: 3,
        }),
      );
    return new Response('[]', { status: init?.method === 'POST' ? 503 : 200 });
  });
  const { store, socket } = cold();
  store.getState().restoreAuthentication();
  socket.open();
  store
    .getState()
    .sendMessage('Discuss original report', { ...selection, sourceSnapshots: [source] });
  await vi.advanceTimersByTimeAsync(0);
  expect(store.getState().sessions.active).toBe('foreground');
  expect(socket.sent.filter((message) => message.type === 'send')).toEqual([]);
  expect(socket.sent.filter((message) => message.type === 'switch_session')).toEqual([
    { type: 'switch_session', sessionId: 'foreground' },
    { type: 'switch_session', sessionId: 'foreground', historyCursor: 3 },
  ]);
  expect(store.getState().messages.current?.blocks.get('calendar')?.content).toBe(
    'Calendar details emitted before ACK',
  );
  expect(store.getState().messages.messages[0].sourceSnapshots).toEqual([source]);
});

it('recovers a browser SSE reviewed launch after a fresh context loses sessionStorage', async () => {
  vi.useFakeTimers();
  let accepting = false;
  const commands: Record<string, unknown>[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (String(path) === url) {
      const body = JSON.parse(String(init?.body));
      commands.push(body);
      if (!accepting) return new Promise<Response>(() => {});
      return new Response(
        JSON.stringify({ accepted: true, clientMsgId: body.clientMsgId, sessionId: 'sse-fresh' }),
        { status: 202 },
      );
    }
    if (String(path).endsWith('/meta')) return new Response(JSON.stringify({ isHidden: false }));
    return new Response('[]', { status: init?.method === 'POST' ? 503 : 200 });
  });
  const first = cold(true);
  first.store.getState().restoreAuthentication();
  first.store
    .getState()
    .sendMessage('Discuss original report', { ...selection, sourceSnapshots: [source] });
  await vi.advanceTimersByTimeAsync(0);
  expect(commands).toHaveLength(1);
  sessionStorage.clear();
  accepting = true;
  const fresh = cold(true);
  fresh.store.getState().restoreAuthentication();
  await vi.advanceTimersByTimeAsync(0);
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  await expect(localBriefingConversation(source, selection)).resolves.toBe('sse-fresh');
});
