import { expect, it, vi } from 'vitest';
import { createMitzoStore } from '../src/store.js';

function fixture(extraFetch?: (url: string, init?: RequestInit) => Promise<Response> | undefined) {
  let welcome!: (event: MessageEvent) => void;
  const source = {
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      if (type === 'welcome') welcome = listener;
    },
    close: vi.fn(),
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null,
  };
  let receipt!: (response: Response) => void;
  let history!: (response: Response) => void;
  let failHistory!: (error: Error) => void;
  let historySignal: AbortSignal | undefined;
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    const overridden = extraFetch?.(url, init);
    if (overridden) return overridden;
    if (url.endsWith('/send'))
      return new Promise<Response>((resolve) => {
        receipt = resolve;
      });
    if (url.includes('throughSeq=')) {
      historySignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve, reject) => {
        history = resolve;
        failHistory = reject;
      });
    }
    if (url.includes('/messages'))
      return Promise.resolve(Response.json({ messages: [], current: null, cursor: 10 }));
    return Promise.resolve(Response.json(url.includes('/api/chat/') ? { applied: true } : []));
  });
  const store = createMitzoStore({
    transport: { fetch, connectWs: vi.fn() },
    wsConfig: {
      buildUrl: () => '',
      createWebSocket: () => {
        throw Error('SSE only');
      },
    },
    sseConfig: { baseUrl: '', fetch, createEventSource: () => source as unknown as EventSource },
  });
  const emit = (data: Record<string, unknown>) =>
    source.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  const connect = (id: string) =>
    welcome(
      new MessageEvent('welcome', {
        data: JSON.stringify({ connectionId: id, eventAckBatchSize: 50 }),
      }),
    );
  connect('browser');
  const posts = (endpoint: string) =>
    fetch.mock.calls
      .filter(([url]) => url.endsWith('/' + endpoint))
      .map(([, init]) => JSON.parse(String(init?.body)));
  return {
    store,
    source,
    fetch,
    emit,
    connect,
    posts,
    receipt: (response: Response) => receipt(response),
    history: (response: Response) => history(response),
    failHistory: (error: Error) => failHistory(error),
    historySignal: () => historySignal,
  };
}

it('does not restore or re-enroll retired chats through five navigation/reconnect cycles', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 5; i++) {
      await f.store.getState().switchSession('old-' + i);
      await f.store.getState().switchSession('selected');
      f.emit({
        type: 'session_reconnect_snapshot',
        sessionId: 'old-' + i,
        cursor: 10,
        offerId: 'retired-' + i,
        state: 'idle',
      });
      f.emit({
        type: 'message_start',
        sessionId: 'old-' + i,
        seq: 11,
        prevSessionSeq: 10,
        messageId: 'old-reply',
      });
      f.store.getState().forceReconnect();
      f.connect('browser-' + i);
      await vi.waitFor(() =>
        expect(
          f
            .posts('reconnect')
            .at(-1)
            ?.sessions.map((x: { sessionId: string }) => x.sessionId),
        ).toEqual(['selected']),
      );
    }
    expect(f.fetch.mock.calls.filter(([url]) => url.includes('throughSeq='))).toHaveLength(0);
    expect(f.posts('reconnect-snapshot-applied')).toHaveLength(0);
  } finally {
    f.store.getState().invalidateAuthentication();
  }
});

it.each(['resolve', 'reject'] as const)(
  'retires and aborts an offscreen read before its late %s without disrupting the foreground',
  async (completion) => {
    const f = fixture();
    try {
      await f.store.getState().switchSession('pending');
      f.store.getState().sendMessage('Pending command');
      const id = f.store.getState().messages.messages.at(-1)!.messageId;
      await vi.waitFor(() => expect(f.posts('send')).toHaveLength(1));
      await f.store.getState().switchSession('selected');
      f.emit({
        type: 'session_reconnect_snapshot',
        sessionId: 'pending',
        cursor: 10,
        offerId: 'owned',
        state: 'running',
      });
      await vi.waitFor(() => expect(f.historySignal()).toBeDefined());
      f.receipt(
        Response.json({ accepted: true, clientMsgId: id, sessionId: 'pending' }, { status: 202 }),
      );
      await vi.waitFor(() => expect(f.historySignal()?.aborted).toBe(true));
      const selected = f.store.getState().messages;
      if (completion === 'resolve')
        f.history(Response.json({ messages: [], current: null, cursor: 10 }));
      else f.failHistory(Error('obsolete request'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(f.source.close).not.toHaveBeenCalled();
      expect(f.store.getState().messages).toBe(selected);
      expect(f.posts('reconnect-snapshot-applied')).toHaveLength(0);
      f.store.getState().sendSuspend();
      await vi.waitFor(() =>
        expect(
          f
            .posts('suspend')
            .at(-1)
            ?.sessions.map((x: { sessionId: string }) => x.sessionId),
        ).toEqual(['selected']),
      );
    } finally {
      f.store.getState().invalidateAuthentication();
    }
  },
);

it('reselects only after an in-flight unwatch completes on the same connection', async () => {
  let finish!: (response: Response) => void;
  const f = fixture((url, init) => {
    if (url.endsWith('/unwatch') && JSON.parse(String(init?.body)).sessionId === 'a')
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
  });
  try {
    await f.store.getState().switchSession('a');
    await f.store.getState().switchSession('b');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const before = f.posts('switch').length;
    await f.store.getState().switchSession('a');
    expect(f.posts('switch')).toHaveLength(before);
    finish(Response.json({ ok: true }));
    await vi.waitFor(() =>
      expect(f.posts('switch').at(-1)).toMatchObject({
        sessionId: 'a',
        clientManagedWatches: true,
      }),
    );
  } finally {
    f.store.getState().invalidateAuthentication();
  }
});

it('ignores an old subscription snapshot after the same chat is retired and reselected', async () => {
  const f = fixture();
  try {
    await f.store.getState().switchSession('a');
    f.store.getState().forceReconnect();
    f.connect('successor');
    await vi.waitFor(() =>
      expect(f.posts('reconnect').at(-1)?.sessions[0]?.subscriptionId).toBeTypeOf('string'),
    );
    const subscriptionId = f.posts('reconnect').at(-1).sessions[0].subscriptionId;
    await f.store.getState().switchSession('b');
    await f.store.getState().switchSession('a');
    const selected = f.store.getState().messages;
    const closes = f.source.close.mock.calls.length;
    f.emit({
      type: 'session_reconnect_snapshot',
      sessionId: 'a',
      subscriptionId,
      cursor: 4,
      offerId: 'old-lifetime',
      state: 'idle',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.fetch.mock.calls.filter(([url]) => url.includes('throughSeq='))).toHaveLength(0);
    expect(f.posts('reconnect-snapshot-applied')).toHaveLength(0);
    expect(f.store.getState().messages).toBe(selected);
    expect(f.source.close).toHaveBeenCalledTimes(closes);
  } finally {
    f.store.getState().invalidateAuthentication();
  }
});

it('keeps a correlated late launch assignment offscreen after its draft was left', async () => {
  const f = fixture();
  try {
    f.store.getState().sendMessage('Old draft command');
    const id = f.store.getState().messages.messages.at(-1)!.messageId;
    await vi.waitFor(() => expect(f.posts('send')).toHaveLength(1));
    f.store.getState().newSession();
    f.emit({ type: 'session_id', sessionId: 'old-launch', clientMsgId: id });
    expect(f.store.getState().sessions.active).toBeNull();
    f.receipt(
      Response.json({ accepted: true, clientMsgId: id, sessionId: 'old-launch' }, { status: 202 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.store.getState().sessions.active).toBeNull();
  } finally {
    f.store.getState().invalidateAuthentication();
  }
});

it('ignores a rejected ACK after receipt settlement retires its exact offer', async () => {
  let finishAck!: (response: Response) => void;
  const f = fixture((url) =>
    url.endsWith('/reconnect-snapshot-applied')
      ? new Promise<Response>((resolve) => {
          finishAck = resolve;
        })
      : undefined,
  );
  try {
    await f.store.getState().switchSession('pending');
    f.store.getState().sendMessage('Pending command');
    const id = f.store.getState().messages.messages.at(-1)!.messageId;
    await vi.waitFor(() => expect(f.posts('send')).toHaveLength(1));
    await f.store.getState().switchSession('selected');
    f.emit({
      type: 'session_reconnect_snapshot',
      sessionId: 'pending',
      cursor: 10,
      offerId: 'retiring',
      state: 'running',
    });
    await vi.waitFor(() => expect(f.historySignal()).toBeDefined());
    f.history(Response.json({ messages: [], current: null, cursor: 10 }));
    await vi.waitFor(() => expect(finishAck).toBeTypeOf('function'));
    f.receipt(
      Response.json({ accepted: true, clientMsgId: id, sessionId: 'pending' }, { status: 202 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishAck(Response.json({ applied: false }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.source.close).not.toHaveBeenCalled();
    expect(f.store.getState().sessions.active).toBe('selected');
  } finally {
    f.store.getState().invalidateAuthentication();
  }
});
