import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SseConnection } from '../sse-connection.js';
import type { SseConnectionConfig } from '../sse-connection.js';

// ─── Mock EventSource ──────────────────────────────────────────────────────

type ESListener = (e: MessageEvent) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  readyState = 0; // CONNECTING
  private listeners = new Map<string, ESListener[]>();
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: ESListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: ESListener): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((l) => l !== listener),
    );
  }

  close(): void {
    this.readyState = 2; // CLOSED
  }

  // ─── Test helpers ────────────────────────────────────────────────────────

  /** Simulate the server sending an SSE event.
   *  Named events (welcome) go to addEventListener listeners.
   *  All others go to onmessage (matching server behavior). */
  _emit(type: string, data: Record<string, unknown>): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    if (type === 'welcome') {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event);
      }
    } else {
      this.onmessage?.(event);
    }
  }

  _triggerError(): void {
    this.onerror?.();
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function createConfig(overrides?: Partial<SseConnectionConfig>): SseConnectionConfig {
  return {
    baseUrl: 'https://localhost:3100',
    fetch: vi.fn().mockResolvedValue({ ok: true }),
    createEventSource: (url: string) => new MockEventSource(url) as unknown as EventSource,
    ...overrides,
  };
}

function lastES(): MockEventSource {
  return MockEventSource.instances[MockEventSource.instances.length - 1];
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('SseConnection', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Connection lifecycle ────────────────────────────────────────────────

  it('creates EventSource on connect()', () => {
    const conn = new SseConnection(createConfig());
    conn.connect();

    expect(MockEventSource.instances).toHaveLength(1);
    expect(lastES().url).toBe('https://localhost:3100/api/chat/events');
  });

  it('becomes connected after welcome event', () => {
    const conn = new SseConnection(createConfig());
    const listener = vi.fn();
    conn.onMessage(listener);
    conn.connect();

    expect(conn.isConnected()).toBe(false);

    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-abc' });

    expect(conn.isConnected()).toBe(true);
    expect(conn.getConnectionId()).toBe('conn-abc');
    expect(listener).toHaveBeenCalledWith({ type: '_open' });
  });

  it('disconnect() closes EventSource', () => {
    const conn = new SseConnection(createConfig());
    conn.connect();
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-abc' });

    conn.disconnect();

    expect(conn.isConnected()).toBe(false);
    expect(lastES().readyState).toBe(2); // CLOSED
  });

  // ─── Message receiving (server → client) ─────────────────────────────────

  it('dispatches session events to listener', () => {
    const conn = new SseConnection(createConfig());
    const listener = vi.fn();
    conn.onMessage(listener);
    conn.connect();
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-abc' });

    lastES()._emit('block_delta', {
      type: 'block_delta',
      sessionId: 'sess-1',
      seq: 5,
      delta: 'hello',
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'block_delta', delta: 'hello' }),
    );
  });

  it('tracks seq numbers from incoming events', () => {
    const conn = new SseConnection(createConfig());
    conn.connect();
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-abc' });

    lastES()._emit('block_delta', {
      type: 'block_delta',
      sessionId: 'sess-1',
      seq: 42,
      delta: 'x',
    });

    expect(conn.getLastSeq('sess-1')).toBe(42);
  });

  // ─── Message sending (client → server) ─────────────────────────────────

  it('sends messages via POST with X-Connection-ID', () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const conn = new SseConnection(createConfig({ fetch: mockFetch }));
    conn.connect();
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-abc' });

    conn.send({ type: 'send', sessionId: 'sess-1', prompt: 'hello', clientMsgId: 'msg-1' });

    expect(mockFetch).toHaveBeenCalledWith('https://localhost:3100/api/chat/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Connection-ID': 'conn-abc',
      },
      body: JSON.stringify({
        type: 'send',
        sessionId: 'sess-1',
        prompt: 'hello',
        clientMsgId: 'msg-1',
      }),
    });
  });

  it('maps message types to correct endpoints', () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const conn = new SseConnection(createConfig({ fetch: mockFetch }));
    conn.connect();
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-abc' });

    const types: Array<[string, string]> = [
      ['send', 'send'],
      ['stop', 'stop'],
      ['interrupt', 'interrupt'],
      ['permission_response', 'permission'],
      ['set_mode', 'mode'],
      ['watch', 'watch'],
      ['unwatch', 'unwatch'],
      ['switch_session', 'switch'],
      ['session_suspend', 'suspend'],
      ['session_close', 'close'],
      ['reconnect', 'reconnect'],
    ];

    for (const [msgType, endpoint] of types) {
      mockFetch.mockClear();
      conn.send({ type: msgType });
      expect(mockFetch).toHaveBeenCalledWith(
        `https://localhost:3100/api/chat/${endpoint}`,
        expect.any(Object),
      );
    }
  });

  it('returns false for unknown message types', () => {
    const conn = new SseConnection(createConfig());
    conn.connect();
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-abc' });

    expect(conn.send({ type: 'unknown_garbage' })).toBe(false);
  });

  // ─── Pending send queue ──────────────────────────────────────────────────

  it('queues sends before welcome and flushes after', () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const conn = new SseConnection(createConfig({ fetch: mockFetch }));
    conn.connect();

    // Not yet connected — should queue
    const queued = conn.send({ type: 'send', prompt: 'queued', clientMsgId: 'q-1' });
    expect(queued).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();

    // Welcome arrives — should flush
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-abc' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://localhost:3100/api/chat/send',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('drops oldest when queue exceeds MAX_PENDING_SENDS', () => {
    const conn = new SseConnection(createConfig());
    conn.connect();

    for (let i = 0; i < 101; i++) {
      conn.send({ type: 'send', prompt: `msg-${i}`, clientMsgId: `id-${i}` });
    }

    // clearPendingSends exposes queue length indirectly
    // After 101 sends with max 100, oldest should be dropped
    // Flush and check
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    (conn as unknown as { config: { fetch: typeof mockFetch } }).config.fetch = mockFetch;
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-abc' });

    // Should have 100 sends, not 101
    expect(mockFetch).toHaveBeenCalledTimes(100);
  });

  it('clearPendingSends() empties the queue', () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const conn = new SseConnection(createConfig({ fetch: mockFetch }));
    conn.connect();

    conn.send({ type: 'send', prompt: 'will be cleared', clientMsgId: 'c-1' });
    conn.clearPendingSends();

    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-abc' });

    // Only the calls from flush — should be 0 since we cleared
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ─── Reconnect ────────────────────────────────────────────────────────────

  it('notifies _close on error and recovers on next welcome', () => {
    const conn = new SseConnection(createConfig());
    const listener = vi.fn();
    conn.onMessage(listener);
    conn.connect();
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-abc' });

    lastES()._triggerError();

    expect(listener).toHaveBeenCalledWith({ type: '_close' });
    expect(conn.isConnected()).toBe(false);
  });

  it('sends reconnect POST fire-and-forget on reconnect welcome', () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const conn = new SseConnection(createConfig({ fetch: mockFetch }));
    conn.connect();
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-abc' });

    // Track a session
    conn.trackSeq('sess-1', 10);

    // Force reconnect — creates new EventSource
    conn.checkAndReconnect(true);
    mockFetch.mockClear();

    // New welcome arrives — should trigger reconnect POST
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-def' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://localhost:3100/api/chat/reconnect',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          type: 'reconnect',
          sessions: [{ sessionId: 'sess-1', lastSeq: 10 }],
        }),
      }),
    );
  });

  it('marks connected immediately on reconnect welcome', () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const conn = new SseConnection(createConfig({ fetch: mockFetch }));
    const listener = vi.fn();
    conn.onMessage(listener);
    conn.connect();
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-abc' });
    conn.trackSeq('sess-1', 10);

    // Force reconnect
    conn.checkAndReconnect(true);
    listener.mockClear();

    // New welcome — should be connected immediately (fire-and-forget)
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-def' });

    expect(conn.isConnected()).toBe(true);
    expect(listener).toHaveBeenCalledWith({ type: '_open' });
  });

  it('POST failure does not affect connection state', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/reconnect')) {
        return Promise.reject(new Error('network error'));
      }
      return Promise.resolve({ ok: true });
    });
    const conn = new SseConnection(createConfig({ fetch: mockFetch }));
    const listener = vi.fn();
    conn.onMessage(listener);
    conn.connect();
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-abc' });
    conn.trackSeq('sess-1', 10);

    conn.checkAndReconnect(true);
    listener.mockClear();

    // Welcome — reconnect POST fires (and will fail), but connection is immediate
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-def' });

    // Connected immediately regardless of POST outcome
    expect(conn.isConnected()).toBe(true);
    expect(listener).toHaveBeenCalledWith({ type: '_open' });
  });

  it('flushes pending sends immediately on reconnect welcome', () => {
    const postEndpoints: string[] = [];
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const endpoint = url.replace('https://localhost:3100/api/chat/', '');
      postEndpoints.push(endpoint);
      return Promise.resolve({ ok: true });
    });
    const conn = new SseConnection(createConfig({ fetch: mockFetch }));
    conn.connect();
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-abc' });
    conn.trackSeq('sess-1', 10);

    // Force reconnect — sends are now queued
    conn.checkAndReconnect(true);
    conn.send({ type: 'send', prompt: 'queued msg', clientMsgId: 'q-1' });
    postEndpoints.length = 0;

    // Welcome — reconnect POST + queued send both fire immediately
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-def' });

    expect(postEndpoints).toEqual(['reconnect', 'send']);
  });

  it('does not emit _close when checkAndReconnect called while already disconnected', () => {
    const conn = new SseConnection(createConfig());
    const listener = vi.fn();
    conn.onMessage(listener);
    conn.connect();
    // Don't send welcome — _connected stays false

    conn.checkAndReconnect(true);

    // _close should NOT have been emitted since we were never connected
    expect(listener).not.toHaveBeenCalledWith({ type: '_close' });
  });

  it('connects immediately on reconnect when seqBySession is empty', () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const conn = new SseConnection(createConfig({ fetch: mockFetch }));
    const listener = vi.fn();
    conn.onMessage(listener);
    conn.connect();
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-abc' });

    // Track and then clear — simulates all sessions being closed
    conn.trackSeq('sess-1', 10);
    conn.clearSession('sess-1');

    // Force reconnect — _isReconnect=true but seqBySession is empty
    conn.checkAndReconnect(true);
    mockFetch.mockClear();
    listener.mockClear();

    // New welcome — should skip reconnect POST and connect immediately
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-def' });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(conn.isConnected()).toBe(true);
    expect(listener).toHaveBeenCalledWith({ type: '_open' });
  });

  it('does not send reconnect POST on first connection', () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const conn = new SseConnection(createConfig({ fetch: mockFetch }));
    conn.connect();

    // Track a session BEFORE welcome (simulating a pre-existing session)
    conn.trackSeq('sess-1', 5);

    // First welcome — _isReconnect is false, so no reconnect POST
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-abc' });

    expect(mockFetch).not.toHaveBeenCalledWith(
      'https://localhost:3100/api/chat/reconnect',
      expect.any(Object),
    );
  });

  it('reconnect URL never includes sessions query param', () => {
    const conn = new SseConnection(createConfig());
    conn.connect();
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-abc' });
    conn.trackSeq('sess-1', 10);

    // Force reconnect
    conn.checkAndReconnect(true);

    // URL should be clean — reconnect is handled via POST, not query param
    const newES = lastES();
    expect(newES.url).toBe('https://localhost:3100/api/chat/events');
  });

  it('checkAndReconnect(false) is no-op when connected', () => {
    const conn = new SseConnection(createConfig());
    conn.connect();
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-abc' });

    const count = MockEventSource.instances.length;
    conn.checkAndReconnect(false);

    // Should NOT create a new EventSource
    expect(MockEventSource.instances.length).toBe(count);
  });

  // ─── Session tracking ──────────────────────────────────────────────────

  it('trackSeq / getLastSeq / clearSession', () => {
    const conn = new SseConnection(createConfig());

    conn.trackSeq('sess-1', 5);
    expect(conn.getLastSeq('sess-1')).toBe(5);
    expect(conn.getLastSeq('nonexistent')).toBe(0);

    conn.clearSession('sess-1');
    expect(conn.getLastSeq('sess-1')).toBe(0);
  });

  it('getTrackedSessions returns all tracked session IDs', () => {
    const conn = new SseConnection(createConfig());
    conn.trackSeq('sess-1', 1);
    conn.trackSeq('sess-2', 2);

    expect(conn.getTrackedSessions()).toEqual(expect.arrayContaining(['sess-1', 'sess-2']));
  });

  // ─── Suspend ──────────────────────────────────────────────────────────────

  it('sendSuspend posts to suspend endpoint when connected', () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const conn = new SseConnection(createConfig({ fetch: mockFetch }));
    conn.connect();
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-abc' });
    conn.trackSeq('sess-1', 42);

    conn.sendSuspend();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://localhost:3100/api/chat/suspend',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('sess-1'),
      }),
    );
  });

  it('sendSuspend is no-op with no tracked sessions', () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const conn = new SseConnection(createConfig({ fetch: mockFetch }));
    conn.connect();
    lastES()._emit('welcome', { type: 'welcome', protocolVersion: 2, connectionId: 'conn-abc' });

    conn.sendSuspend();

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
