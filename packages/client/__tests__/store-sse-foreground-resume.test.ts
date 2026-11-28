import { afterEach, expect, it, vi } from 'vitest';
import { createMitzoStore, FOREGROUND_SNAPSHOT_GRACE_MS } from '../src/store.js';

// iOS resume previously read and rebuilt the active chat's complete transcript
// twice: once for `_foreground` (`transcript=1`) and once for the reconnect
// snapshot (`throughSeq=`). These tests drive the real SSE transport and assert
// that resume performs at most one bounded read, and none when already current.

type Snapshot = { cursor: number; offerId: string; state?: string };

function harness(options: {
  snapshotOnReconnect?: (lastSeq: number) => Snapshot | null;
  /** Deliver the stream snapshot this long after the reconnect POST resolves. */
  snapshotDelayMs?: number;
}) {
  let visibility = 'visible';
  const browserListeners = new Map<string, () => void>();
  vi.stubGlobal('document', {
    get visibilityState() {
      return visibility;
    },
    addEventListener: (type: string, listener: () => void) => browserListeners.set(type, listener),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('addEventListener', vi.fn());
  vi.stubGlobal('removeEventListener', vi.fn());
  let welcome!: (event: MessageEvent) => void;
  const source = {
    readyState: 1,
    addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      if (type === 'welcome') welcome = listener;
    },
    removeEventListener: vi.fn(),
    close: vi.fn(),
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as (() => void) | null,
  };
  const emit = (message: Record<string, unknown>) =>
    source.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
  const transcripts: Array<{ url: string; resolve: (response: Response) => void }> = [];
  let offers = 0;
  let holdReconnect = false;
  const heldReconnects: Array<() => void> = [];
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    if (url.includes('/messages'))
      return new Promise<Response>((resolve) => transcripts.push({ url, resolve }));
    if (url.endsWith('/probe'))
      emit({ type: '_probe', nonce: JSON.parse(String(init?.body)).nonce });
    if (url.endsWith('/reconnect')) {
      const body = JSON.parse(String(init?.body));
      // Like handleReconnect, write each snapshot to the stream before answering.
      const deliver = () => {
        for (const entry of body.sessions as Array<{
          sessionId: string;
          lastSeq: number;
          subscriptionId?: string;
        }>) {
          const snapshot = options.snapshotOnReconnect?.(entry.lastSeq);
          if (!snapshot) continue;
          const message = {
            type: 'session_reconnect_snapshot',
            sessionId: entry.sessionId,
            subscriptionId: entry.subscriptionId,
            cursor: snapshot.cursor,
            cursorValid: true,
            offerId: `${snapshot.offerId}-${++offers}`,
            state: snapshot.state ?? 'idle',
          };
          if (options.snapshotDelayMs === undefined) emit(message);
          else setTimeout(() => emit(message), options.snapshotDelayMs);
        }
      };
      if (holdReconnect) {
        holdReconnect = false;
        return new Promise<Response>((resolve) =>
          heldReconnects.push(() => {
            deliver();
            resolve(Response.json({ applied: true }));
          }),
        );
      }
      deliver();
    }
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
  const transcriptReads = () => fetch.mock.calls.filter(([url]) => url.includes('/messages'));
  const background = () => {
    visibility = 'hidden';
    browserListeners.get('visibilitychange')?.();
  };
  const foreground = () => {
    visibility = 'visible';
    browserListeners.get('visibilitychange')?.();
  };
  const text = () =>
    store
      .getState()
      .messages.messages.map((message) => message.blocks.map((block) => block.content).join(''));
  return {
    store,
    fetch,
    source,
    emit,
    transcripts,
    transcriptReads,
    background,
    foreground,
    text,
    holdNextReconnect: () => {
      holdReconnect = true;
    },
    heldReconnects,
    snapshotAcks: () =>
      fetch.mock.calls.filter(([url]) => String(url).endsWith('/reconnect-snapshot-applied')),
    welcome: (connectionId: string) =>
      welcome(new MessageEvent('welcome', { data: JSON.stringify({ connectionId }) })),
  };
}

const userRow = (messageId: string, text: string, startedSeq: number) => ({
  messageId,
  role: 'user' as const,
  blocks: [{ blockId: `${messageId}-text`, blockType: 'text' as const, content: text }],
  startedSeq,
});

const assistantRow = (messageId: string, text: string, startedSeq: number) => ({
  ...userRow(messageId, text, startedSeq),
  role: 'assistant' as const,
});

async function openChat(
  h: ReturnType<typeof harness>,
  prefix: Array<ReturnType<typeof userRow> | ReturnType<typeof assistantRow>> = [
    userRow('u1', 'first', 1),
  ],
) {
  h.welcome('browser');
  const opening = h.store.getState().switchSession('chat');
  await vi.waitFor(() => expect(h.transcripts).toHaveLength(1));
  expect(h.transcripts[0].url).toContain('transcript=1');
  h.transcripts[0].resolve(
    Response.json({ messages: prefix, current: null, currents: [], cursor: 1 }),
  );
  await opening;
  // A live, chained event after the opening prefix advances the applied cursor.
  h.emit({
    type: 'user_message',
    sessionId: 'chat',
    messageId: 'u2',
    text: 'second',
    seq: 2,
    prevSessionSeq: 1,
  });
  expect(h.text()).toEqual([...prefix.map((row) => row.blocks[0].content), 'second']);
  h.fetch.mockClear();
  h.transcripts.length = 0;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('resumes an unchanged chat without reading or rebuilding its transcript', async () => {
  const h = harness({ snapshotOnReconnect: () => ({ cursor: 2, offerId: 'idle-offer' }) });
  try {
    await openChat(h);
    h.background();
    h.foreground();
    await vi.waitFor(() =>
      expect(
        h.fetch.mock.calls.some(([url]) => String(url).endsWith('/reconnect-snapshot-applied')),
      ).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.transcriptReads()).toHaveLength(0);
    expect(h.store.getState().historyLoading).toBe(false);
    expect(h.text()).toEqual(['first', 'second']);
    // Live delivery continues from the acknowledged cursor without duplicates.
    h.emit({
      type: 'user_message',
      sessionId: 'chat',
      messageId: 'u3',
      text: 'third',
      seq: 3,
      prevSessionSeq: 2,
    });
    h.emit({
      type: 'user_message',
      sessionId: 'chat',
      messageId: 'u3',
      text: 'third',
      seq: 3,
      prevSessionSeq: 2,
    });
    expect(h.text()).toEqual(['first', 'second', 'third']);
    expect(h.source.close).not.toHaveBeenCalled();
  } finally {
    h.store.getState().invalidateAuthentication();
  }
});

it('catches up missed events with one bounded read and no foreground full read', async () => {
  const h = harness({ snapshotOnReconnect: () => ({ cursor: 4, offerId: 'missed-offer' }) });
  try {
    await openChat(h);
    h.background();
    h.foreground();
    await vi.waitFor(() => expect(h.transcripts).toHaveLength(1));
    expect(h.transcripts[0].url).toContain('throughSeq=4');
    // A live event after the offered cursor waits behind the restore.
    h.emit({
      type: 'user_message',
      sessionId: 'chat',
      messageId: 'u5',
      text: 'fifth',
      seq: 5,
      prevSessionSeq: 4,
    });
    h.transcripts[0].resolve(
      Response.json({
        messages: [
          userRow('u1', 'first', 1),
          userRow('u2', 'second', 2),
          userRow('u3', 'third', 3),
          userRow('u4', 'fourth', 4),
        ],
        current: null,
        currents: [],
      }),
    );
    await vi.waitFor(() =>
      expect(h.text()).toEqual(['first', 'second', 'third', 'fourth', 'fifth']),
    );
    expect(h.transcriptReads()).toHaveLength(1);
    expect(h.transcriptReads().some(([url]) => String(url).includes('transcript=1'))).toBe(false);
    expect(h.store.getState().historyLoading).toBe(false);
    expect(h.source.close).not.toHaveBeenCalled();
  } finally {
    h.store.getState().invalidateAuthentication();
  }
});

it('applies a missed retraction through the single bounded read', async () => {
  const h = harness({ snapshotOnReconnect: () => ({ cursor: 3, offerId: 'retract-offer' }) });
  try {
    await openChat(h, [userRow('u1', 'first', 1), assistantRow('a1', 'answer', 1)]);
    expect(h.text()).toEqual(['first', 'answer', 'second']);
    h.background();
    h.foreground();
    await vi.waitFor(() => expect(h.transcripts).toHaveLength(1));
    // While backgrounded, the provider retracted the reply and a new input arrived.
    h.transcripts[0].resolve(
      Response.json({
        messages: [
          userRow('u1', 'first', 1),
          userRow('u2', 'second', 2),
          userRow('u3', 'third', 3),
        ],
        current: null,
        currents: [],
        retractions: [{ messageId: 'a1' }],
      }),
    );
    await vi.waitFor(() => expect(h.store.getState().historyLoading).toBe(false));
    expect(h.text()).toEqual(['first', 'second', 'third']);
    expect(h.transcriptReads()).toHaveLength(1);
  } finally {
    h.store.getState().invalidateAuthentication();
  }
});

it('falls back to one full read when the reconnect offers no snapshot', async () => {
  vi.useFakeTimers();
  const h = harness({ snapshotOnReconnect: () => null });
  try {
    await openChat(h);
    h.background();
    h.foreground();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.transcriptReads()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(FOREGROUND_SNAPSHOT_GRACE_MS);
    expect(h.transcriptReads()).toHaveLength(1);
    expect(h.transcriptReads()[0][0]).toContain('transcript=1');
  } finally {
    h.store.getState().invalidateAuthentication();
  }
});

it('keeps the deferral when the stream snapshot arrives after the reconnect POST', async () => {
  vi.useFakeTimers();
  // The snapshot travels on the SSE stream and the POST response on another
  // request, so `_open` can be observed first and start the fallback timer.
  const h = harness({
    snapshotOnReconnect: () => ({ cursor: 2, offerId: 'late-offer' }),
    snapshotDelayMs: 500,
  });
  try {
    await openChat(h);
    h.background();
    h.foreground();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch.mock.calls.some(([url]) => String(url).endsWith('/reconnect'))).toBe(true);
    expect(h.snapshotAcks()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.snapshotAcks()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(FOREGROUND_SNAPSHOT_GRACE_MS * 2);
    expect(h.transcriptReads()).toHaveLength(0);
    expect(h.store.getState().historyError).toBeNull();
  } finally {
    h.store.getState().invalidateAuthentication();
  }
});

it('defers to the snapshot when the stream died while backgrounded', async () => {
  const h = harness({ snapshotOnReconnect: () => ({ cursor: 2, offerId: 'dead-offer' }) });
  try {
    await openChat(h);
    h.background();
    // iOS tore down the stream while suspended. Foreground recreates it, and
    // the replacement replays tracked chats once its welcome arrives.
    h.source.onerror?.();
    h.foreground();
    expect(h.source.close).toHaveBeenCalled();
    expect(h.transcriptReads()).toHaveLength(0);
    h.welcome('replacement');
    await vi.waitFor(() => expect(h.snapshotAcks()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.transcriptReads()).toHaveLength(0);
    expect(h.text()).toEqual(['first', 'second']);
  } finally {
    h.store.getState().invalidateAuthentication();
  }
});

it('defers to a reconnect replay that is already in flight', async () => {
  const h = harness({ snapshotOnReconnect: () => ({ cursor: 3, offerId: 'inflight-offer' }) });
  try {
    await openChat(h);
    // The stream reconnected just before backgrounding; its replay POST is pending.
    h.holdNextReconnect();
    h.welcome('replacement');
    await vi.waitFor(() => expect(h.heldReconnects).toHaveLength(1));
    h.background();
    h.foreground();
    expect(h.transcriptReads()).toHaveLength(0);
    h.heldReconnects[0]();
    await vi.waitFor(() => expect(h.transcripts.length).toBeGreaterThan(0));
    // The foreground marks the pending replay dirty, so it is re-posted once.
    // Every read is the same bounded prefix (coalesced by the server) and none
    // is a full `transcript=1` rebuild.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.transcriptReads().every(([url]) => String(url).includes('throughSeq=3'))).toBe(true);
    for (const read of h.transcripts)
      read.resolve(
        Response.json({
          messages: [
            userRow('u1', 'first', 1),
            userRow('u2', 'second', 2),
            userRow('u3', 'third', 3),
          ],
          current: null,
          currents: [],
        }),
      );
    await vi.waitFor(() => expect(h.text()).toEqual(['first', 'second', 'third']));
    await vi.waitFor(() => expect(h.store.getState().historyLoading).toBe(false));
    expect(h.transcriptReads().some(([url]) => String(url).includes('transcript=1'))).toBe(false);
  } finally {
    h.store.getState().invalidateAuthentication();
  }
});

it('cancels the deferred fallback when authentication is invalidated', async () => {
  vi.useFakeTimers();
  const h = harness({ snapshotOnReconnect: () => null });
  await openChat(h);
  h.background();
  h.foreground();
  await vi.advanceTimersByTimeAsync(0);
  h.store.getState().invalidateAuthentication();
  await vi.advanceTimersByTimeAsync(FOREGROUND_SNAPSHOT_GRACE_MS * 2);
  expect(h.transcriptReads()).toHaveLength(0);
  expect(h.store.getState().historyError).toBeNull();
});
