import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WsPool } from '../src/ws-connection.js';
import type { WebSocketLike } from '../src/ws-connection.js';
import type { WsMsg } from '../src/server-messages.js';

// ─── Mock WebSocket ──────────────────────────────────────────────────────────

class MockWebSocket implements WebSocketLike {
  readyState = 0; // CONNECTING
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  simulateOpen() {
    this.readyState = 1; // OPEN
    this.onopen?.(null);
  }

  simulateMessage(data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose() {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }
}

// ─── Test helpers ────────────────────────────────────────────────────────────

let lastCreatedWs: MockWebSocket | null = null;

function createPool(): WsPool {
  lastCreatedWs = null;
  return new WsPool({
    buildUrl: () => 'ws://localhost:3100/ws/chat',
    createWebSocket: () => {
      const ws = new MockWebSocket();
      lastCreatedWs = ws;
      return ws;
    },
    reconnectDelayMs: 50,
    reconnectPollMs: 60_000, // disable in tests
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WsPool message delivery', () => {
  let pool: WsPool;

  beforeEach(() => {
    pool = createPool();
  });

  it('delivers messages directly to listeners', () => {
    const received: WsMsg[] = [];
    pool.subscribe('test-deliver-1', (msg) => received.push(msg));
    const ws = lastCreatedWs!;
    ws.simulateOpen();

    ws.simulateMessage({ type: 'block_delta', blockId: 'b1', delta: 'live' });

    expect(received.some((m) => m.type === 'block_delta')).toBe(true);
  });

  it('queues sends issued while the socket is still CONNECTING and flushes on open', () => {
    pool.subscribe('new:queue-1', () => {});
    const ws = lastCreatedWs!;
    // readyState is CONNECTING — nothing has opened yet
    expect(ws.readyState).toBe(0);

    const sent = pool.send('new:queue-1', { type: 'send', prompt: 'hello' });
    expect(sent).toBe(true);
    // Must not have been written to the socket yet — it isn't open
    expect(ws.send).not.toHaveBeenCalled();

    ws.simulateOpen();

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'send', prompt: 'hello' }));
  });

  it('preserves queued message order when multiple sends happen before open', () => {
    pool.subscribe('new:queue-2', () => {});
    const ws = lastCreatedWs!;

    pool.send('new:queue-2', { type: 'send', prompt: 'first' });
    pool.send('new:queue-2', { type: 'send', prompt: 'second' });

    ws.simulateOpen();

    const sentPayloads = ws.send.mock.calls.map((c: string[]) => JSON.parse(c[0]));
    expect(sentPayloads).toEqual([
      { type: 'send', prompt: 'first' },
      { type: 'send', prompt: 'second' },
    ]);
  });

  it('queues sends issued while the socket is closed with a reconnect pending', () => {
    vi.useFakeTimers();
    pool.subscribe('new:reconnect-queue', () => {});
    const ws1 = lastCreatedWs!;
    ws1.simulateOpen();
    // Close — ws becomes null on the entry, reconnectTimer is armed.
    ws1.simulateClose();

    // At this point entry.ws is null but reconnectTimer is set. send()
    // should take the reconnect-pending branch and enqueue the payload.
    const sent = pool.send('new:reconnect-queue', { type: 'send', prompt: 'during-reconnect' });
    expect(sent).toBe(true);

    // Drive the reconnect through and verify the queued payload flushes
    // onto the fresh socket on open.
    vi.advanceTimersByTime(200);
    const ws2 = lastCreatedWs!;
    expect(ws2).not.toBe(ws1);
    ws2.simulateOpen();

    const ws2Sends = ws2.send.mock.calls.map((c: string[]) => JSON.parse(c[0]));
    expect(ws2Sends).toContainEqual({ type: 'send', prompt: 'during-reconnect' });
    vi.useRealTimers();
  });

  it('caps the pending queue at 100 and drops the oldest payload on overflow', () => {
    pool.subscribe('new:queue-cap', () => {});
    const ws = lastCreatedWs!;

    for (let i = 0; i < 105; i++) {
      pool.send('new:queue-cap', { type: 'send', prompt: `m${i}` });
    }

    ws.simulateOpen();

    const flushed = ws.send.mock.calls.map((c: string[]) => JSON.parse(c[0]));
    expect(flushed).toHaveLength(100);
    // Oldest five (m0..m4) were dropped; newest (m104) preserved.
    expect(flushed[0]).toEqual({ type: 'send', prompt: 'm5' });
    expect(flushed[flushed.length - 1]).toEqual({ type: 'send', prompt: 'm104' });
  });

  it('carries queued sends across a CONNECTING → CLOSED → reconnect cycle', () => {
    vi.useFakeTimers();
    pool.subscribe('new:queue-survives', () => {});
    const ws1 = lastCreatedWs!;

    // Queue a send while still CONNECTING, then close before it ever opens.
    pool.send('new:queue-survives', { type: 'send', prompt: 'stubborn' });
    ws1.simulateClose();

    // Advance past the reconnect delay to let WsPool reopen the socket.
    vi.advanceTimersByTime(200);
    const ws2 = lastCreatedWs!;
    expect(ws2).not.toBe(ws1);
    ws2.simulateOpen();

    const ws2Sends = ws2.send.mock.calls.map((c: string[]) => JSON.parse(c[0]));
    expect(ws2Sends).toContainEqual({ type: 'send', prompt: 'stubborn' });
    vi.useRealTimers();
  });

  it('still broadcasts _open and preserves remaining queued sends when a flush send throws', () => {
    vi.useFakeTimers();
    const received: WsMsg[] = [];
    pool.subscribe('new:flush-throws', (msg) => received.push(msg));
    const ws1 = lastCreatedWs!;

    pool.send('new:flush-throws', { type: 'send', prompt: 'first' });
    pool.send('new:flush-throws', { type: 'send', prompt: 'second' });
    pool.send('new:flush-throws', { type: 'send', prompt: 'third' });

    // Make the second ws.send() throw; the first succeeds, the remaining
    // payloads must stay queued so the next reconnect can drain them.
    let callCount = 0;
    ws1.send = vi.fn(() => {
      callCount++;
      if (callCount === 2) throw new Error('simulated send failure');
    });

    ws1.simulateOpen();

    // _open must still be broadcast to listeners even though a send threw.
    expect(received.some((m) => m.type === '_open')).toBe(true);

    // Close and reconnect — the surviving payloads should flush onto ws2.
    ws1.simulateClose();
    vi.advanceTimersByTime(200);
    const ws2 = lastCreatedWs!;
    expect(ws2).not.toBe(ws1);
    ws2.simulateOpen();

    const ws2Sends = ws2.send.mock.calls.map((c: string[]) => JSON.parse(c[0]));
    expect(ws2Sends).toEqual(
      expect.arrayContaining([
        { type: 'send', prompt: 'second' },
        { type: 'send', prompt: 'third' },
      ]),
    );
    vi.useRealTimers();
  });

  it('drops messages when no listeners are subscribed', () => {
    const unsub = pool.subscribe('test-deliver-2', () => {});
    const ws = lastCreatedWs!;
    ws.simulateOpen();
    unsub();

    ws.simulateMessage({ type: 'block_delta', blockId: 'b1', delta: 'hello' });

    const received: WsMsg[] = [];
    pool.subscribe('test-deliver-2', (msg) => received.push(msg));
    expect(received).toHaveLength(0);
  });
});

describe('WsPool subscribe for session keys', () => {
  let pool: WsPool;

  beforeEach(() => {
    pool = createPool();
  });

  it('sends subscribe message for session: keys after client_id', () => {
    pool.subscribe('session:sdk-test-123', () => {});
    const ws = lastCreatedWs!;
    ws.simulateOpen();

    ws.simulateMessage({ type: 'client_id', clientId: 'new-client' });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribe', sessionId: 'sdk-test-123' }),
    );
  });

  it('does NOT send subscribe for non-session keys', () => {
    pool.subscribe('new:abc123', () => {});
    const ws = lastCreatedWs!;
    ws.simulateOpen();
    ws.simulateMessage({ type: 'client_id', clientId: 'c1' });

    const calls = ws.send.mock.calls.map((c: string[]) => JSON.parse(c[0]));
    expect(calls.some((c: Record<string, unknown>) => c.type === 'subscribe')).toBe(false);
  });

  it('broadcasts _open after subscribed response', () => {
    const received: WsMsg[] = [];
    pool.subscribe('session:sdk-sub-test', (msg) => received.push(msg));
    const ws = lastCreatedWs!;
    ws.simulateOpen();
    ws.simulateMessage({ type: 'client_id', clientId: 'c2' });

    const opensBefore = received.filter((m) => m.type === '_open').length;

    ws.simulateMessage({ type: 'subscribed', sessionId: 'sdk-sub-test', running: true });

    const opensAfter = received.filter((m) => m.type === '_open').length;
    expect(opensAfter).toBeGreaterThan(opensBefore);
  });

  it('sets wasRunning when subscribed with running: true', () => {
    pool.subscribe('session:sdk-running-test', () => {});
    const ws = lastCreatedWs!;
    ws.simulateOpen();
    ws.simulateMessage({ type: 'client_id', clientId: 'c3' });
    ws.simulateMessage({ type: 'subscribed', sessionId: 'sdk-running-test', running: true });

    // Simulate disconnect + reconnect
    ws.simulateClose();

    // Wait for reconnect timer
    vi.useFakeTimers();
    vi.advanceTimersByTime(100);
    vi.useRealTimers();

    const ws2 = lastCreatedWs!;
    ws2.simulateOpen();
    ws2.simulateMessage({ type: 'client_id', clientId: 'c4' });

    const calls = ws2.send.mock.calls.map((c: string[]) => JSON.parse(c[0]));
    expect(calls.some((c: Record<string, unknown>) => c.type === 'reattach')).toBe(true);
  });
});

describe('WsPool reattach_failed handling', () => {
  let pool: WsPool;

  beforeEach(() => {
    pool = createPool();
  });

  it('broadcasts _open after reattach_failed', () => {
    const received: WsMsg[] = [];
    pool.subscribe('test-reattach-fail-1', (msg) => received.push(msg));
    const ws1 = lastCreatedWs!;
    ws1.simulateOpen();

    ws1.simulateMessage({ type: 'client_id', clientId: 'old-id' });
    pool.setRunning('test-reattach-fail-1', true);

    received.length = 0;

    // Simulate disconnect + reconnect
    ws1.simulateClose();
    vi.useFakeTimers();
    vi.advanceTimersByTime(100);
    vi.useRealTimers();

    const ws2 = lastCreatedWs!;
    ws2.simulateOpen();

    ws2.simulateMessage({ type: 'client_id', clientId: 'new-id' });

    const openCountBefore = received.filter((m) => m.type === '_open').length;

    ws2.simulateMessage({ type: 'reattach_failed', reason: 'no session' });

    const types = received.map((m) => m.type);
    expect(types).toContain('reattach_failed');
    const openCountAfter = received.filter((m) => m.type === '_open').length;
    expect(openCountAfter).toBeGreaterThan(openCountBefore);
  });
});

describe('WsPool utility methods', () => {
  let pool: WsPool;

  beforeEach(() => {
    pool = createPool();
  });

  it('isOpen returns true for open connections', () => {
    pool.subscribe('test-open', () => {});
    const ws = lastCreatedWs!;
    expect(pool.isOpen('test-open')).toBe(false);
    ws.simulateOpen();
    expect(pool.isOpen('test-open')).toBe(true);
  });

  it('send returns false when connection is not open', () => {
    expect(pool.send('nonexistent', { type: 'test' })).toBe(false);
  });

  it('send returns true and sends when connection is open', () => {
    pool.subscribe('test-send', () => {});
    const ws = lastCreatedWs!;
    ws.simulateOpen();
    const result = pool.send('test-send', { type: 'test', data: 42 });
    expect(result).toBe(true);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'test', data: 42 }));
  });

  it('removeIfIdle removes idle entries', () => {
    const unsub = pool.subscribe('test-idle', () => {});
    unsub();
    expect(pool.removeIfIdle('test-idle')).toBe(true);
    expect(pool.isOpen('test-idle')).toBe(false);
  });

  it('removeIfIdle does not remove running entries', () => {
    pool.subscribe('test-running', () => {});
    pool.setRunning('test-running', true);
    expect(pool.removeIfIdle('test-running')).toBe(false);
  });

  it('removeIfIdle does not remove entries with listeners', () => {
    pool.subscribe('test-listeners', () => {});
    expect(pool.removeIfIdle('test-listeners')).toBe(false);
  });

  it('destroy closes all connections', () => {
    pool.subscribe('test-destroy-1', () => {});
    pool.subscribe('test-destroy-2', () => {});
    pool.destroy();
    expect(pool.isOpen('test-destroy-1')).toBe(false);
    expect(pool.isOpen('test-destroy-2')).toBe(false);
  });
});

describe('WsPool session key aliasing', () => {
  let pool: WsPool;

  beforeEach(() => {
    pool = createPool();
  });

  it('registers session key alias on session_id', () => {
    pool.subscribe('new:abc', () => {});
    const ws = lastCreatedWs!;
    ws.simulateOpen();
    ws.simulateMessage({ type: 'client_id', clientId: 'c1' });
    ws.simulateMessage({ type: 'session_id', sessionId: 'real-sid' });

    // The pool should now respond to 'session:real-sid' too
    expect(pool.isOpen('session:real-sid')).toBe(true);
  });
});
