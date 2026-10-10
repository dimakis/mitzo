// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { createMitzoStore, type MitzoStoreOptions } from '@mitzo/client';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { usePendingLaunch } from '../usePendingLaunch';
import { useBriefingChat } from '../useBriefingChat';
import * as receipts from '../../lib/briefing-registration';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
  getApiBaseUrl: () => '',
  AUTH_LOST_EVENT: 'mitzo:auth-lost',
}));
vi.mock('../useHomePreferences', () => ({ useHomePreferences: () => ({ preferences: null }) }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});
const source = {
  kind: 'briefing' as const,
  date: '2026-10-09',
  revision: 'a'.repeat(64),
  content: 'Full exact original report kept only in the send outbox.',
};
const selection = { accountId: 'work', model: 'luna', reasoningEffort: 'low' };
class InertEvents {
  readyState = 0;
  onerror = null;
  onmessage = null;
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
function options(fetch: typeof apiFetch): MitzoStoreOptions {
  return {
    transport: { fetch },
    wsConfig: {
      buildUrl: () => 'ws://unused.test',
      createWebSocket: () => {
        throw new Error('Default SSE regression must never open WebSocket');
      },
    },
    sseConfig: {
      baseUrl: '',
      fetch,
      outboxStorage: sessionStorage,
      createEventSource: () => new InertEvents() as unknown as EventSource,
    },
    sendHandoff: receipts.briefingCommandHandoff,
  };
}

it.each(['before ACK', 'accepted response lost'] as const)(
  'restores original default-SSE briefing handoff after reload %s without an observer or another model command',
  async (failure) => {
    vi.useFakeTimers();
    const delivered: Record<string, unknown>[] = [];
    let accept = false;
    let registered = false;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/api/chat/send')) {
        const body = JSON.parse(String(init?.body));
        delivered.push(body);
        if (!accept) {
          if (failure === 'accepted response lost')
            throw new Error('Server accepted this command but response was lost');
          return new Promise<Response>(() => {});
        }
        return new Response(
          JSON.stringify({ accepted: true, clientMsgId: body.clientMsgId, sessionId: 'assigned' }),
          { status: 202 },
        );
      }
      if (init?.method === 'POST' && String(url).includes('/home/briefing-chats'))
        return new Response(
          JSON.stringify({
            date: source.date,
            revision: source.revision,
            ...selection,
            reasoningEffort: undefined,
            sessionId: 'assigned',
            createdAt: '2026-10-09T07:00:00Z',
          }),
          { status: registered ? 201 : 503 },
        );
      return new Response('[]');
    });
    const firstStore = createMitzoStore(options(apiFetch));
    firstStore.getState().setPendingSession({
      prompt: 'Discuss the report',
      context: 'Briefing',
      briefing: { date: source.date, revision: source.revision },
      sourceSnapshots: [source],
      accountSelection: selection,
    });
    const first = renderHook(usePendingLaunch, {
      wrapper: ({ children }) => (
        <MitzoStoreProvider value={firstStore}>{children}</MitzoStoreProvider>
      ),
    });
    act(() => first.result.current.sendLaunch());
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toHaveLength(1);
    const original = delivered[0];
    expect(original.sourceSnapshots).toEqual([source]);
    expect(Object.values(localStorage).join('')).not.toContain(source.content);
    first.unmount();
    // Browser process restart restores only the durable default-SSE outbox, never observers or PendingSession.
    accept = true;
    const restoredStore = createMitzoStore(options(apiFetch));
    expect(restoredStore.getState().pendingSession).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toEqual(original);
    expect(JSON.parse(sessionStorage.getItem('mitzo-send-outbox:/api/chat/send')!)).toEqual([]);
    restoredStore.setState({
      sessions: { ...restoredStore.getState().sessions, active: 'assigned' },
    });
    const restored = renderHook(
      () => ({ launch: usePendingLaunch(), chat: useBriefingChat('assigned') }),
      {
        wrapper: ({ children }) => (
          <MitzoStoreProvider value={restoredStore}>{children}</MitzoStoreProvider>
        ),
      },
    );
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(restored.result.current.chat.source).toMatchObject({
      date: source.date,
      revision: source.revision,
      accountId: 'work',
      model: 'luna',
    });
    expect(restored.result.current.chat.selectionLocked).toBe(true);
    expect(restored.result.current.launch.registrationError).toBeTruthy();
    restored.unmount();
    // A second reload after ACK has an empty send outbox but still retains its exact registration receipt.
    const thirdStore = createMitzoStore(options(apiFetch));
    thirdStore.setState({ sessions: { ...thirdStore.getState().sessions, active: 'assigned' } });
    const third = renderHook(
      () => ({ launch: usePendingLaunch(), chat: useBriefingChat('assigned') }),
      {
        wrapper: ({ children }) => (
          <MitzoStoreProvider value={thirdStore}>{children}</MitzoStoreProvider>
        ),
      },
    );
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(third.result.current.chat.selectionLocked).toBe(true);
    expect(third.result.current.launch.registrationError).toBeTruthy();
    expect(delivered).toHaveLength(2);
    registered = true;
    await act(async () => third.result.current.launch.retryRegistration());
    expect(third.result.current.launch.registrationError).toBe('');
    expect(delivered).toHaveLength(2);
    const posts = vi
      .mocked(apiFetch)
      .mock.calls.filter(
        ([url, init]) => String(url).includes('/home/briefing-chats') && init?.method === 'POST',
      );
    expect(posts.map(([, init]) => JSON.parse(String(init?.body)))).toEqual(
      Array(posts.length).fill({
        sessionId: 'assigned',
        date: source.date,
        revision: source.revision,
        accountId: 'work',
        model: 'luna',
      }),
    );
  },
);

it('acknowledges an ordinary default-SSE message when briefing storage is unavailable', async () => {
  vi.useFakeTimers();
  const originalRead = Storage.prototype.getItem;
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, name: string) {
    if (this === localStorage) throw new Error('Briefing storage unavailable');
    return originalRead.call(this, name);
  });
  vi.mocked(apiFetch).mockImplementation(async (url, init) =>
    String(url).endsWith('/api/chat/send')
      ? new Response(
          JSON.stringify({
            accepted: true,
            clientMsgId: JSON.parse(String(init?.body)).clientMsgId,
            sessionId: 'ordinary',
          }),
          { status: 202 },
        )
      : new Response('[]'),
  );
  const store = createMitzoStore(options(apiFetch));
  act(() => store.getState().sendMessage('Ordinary question', selection));
  await vi.advanceTimersByTimeAsync(0);
  expect(JSON.parse(sessionStorage.getItem('mitzo-send-outbox:/api/chat/send')!)).toEqual([]);
  expect(store.getState().sessions.active).toBe('ordinary');
  expect(store.getState().sendStatus).toBeNull();
});

it('retains the same accepted command until assigned identity is durably transferred', async () => {
  vi.useFakeTimers();
  const delivered: Record<string, unknown>[] = [];
  let storageBlocked = true;
  const originalWrite = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, value) {
    if (this === localStorage && name.endsWith(':barrier-assigned') && storageBlocked)
      throw new Error('Assigned receipt quota failure');
    originalWrite.call(this, name, value);
  });
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/api/chat/send')) {
      const body = JSON.parse(String(init?.body));
      delivered.push(body);
      return new Response(
        JSON.stringify({
          accepted: true,
          clientMsgId: body.clientMsgId,
          sessionId: 'barrier-assigned',
        }),
        { status: 202 },
      );
    }
    return new Response('[]', { status: init?.method === 'POST' ? 503 : 200 });
  });
  const store = createMitzoStore(options(apiFetch));
  act(() =>
    store
      .getState()
      .sendMessage('Discuss captured report', { ...selection, sourceSnapshots: [source] }),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(delivered).toHaveLength(1);
  const original = delivered[0];
  const pending = JSON.parse(sessionStorage.getItem('mitzo-send-outbox:/api/chat/send')!);
  expect(pending).toHaveLength(1);
  expect(pending[0].body).toEqual(original);
  expect(Object.keys(localStorage).some((name) => name.includes('-commands:'))).toBe(true);
  storageBlocked = false;
  await vi.advanceTimersByTimeAsync(1000);
  expect(delivered).toHaveLength(2);
  expect(delivered[1]).toEqual(original);
  expect(JSON.parse(sessionStorage.getItem('mitzo-send-outbox:/api/chat/send')!)).toEqual([]);
  expect(Object.keys(localStorage).some((name) => name.includes('-commands:'))).toBe(false);
  const assigned = JSON.parse(
    Object.entries(localStorage).find(([name]) => name.endsWith(':barrier-assigned'))![1],
  );
  expect(assigned.binding).toEqual({
    sessionId: 'barrier-assigned',
    date: source.date,
    revision: source.revision,
    accountId: selection.accountId,
    model: selection.model,
  });
});
