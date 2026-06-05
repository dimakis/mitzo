import { describe, it, expect, vi } from 'vitest';
import { MitzoConnection } from '../src/connection.js';
import type { WebSocketLike } from '../src/ws-connection.js';

// ─── Mock WebSocket ──────────────────────────────────────────────────────────

class MockWebSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  simulateOpen() {
    this.readyState = 1;
    this.onopen?.(null);
  }

  simulateMessage(data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose() {
    this.readyState = 3;
    this.onclose?.();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let lastWs: MockWebSocket | null = null;

function createConnection() {
  lastWs = null;
  return new MitzoConnection({
    buildUrl: () => 'ws://localhost:3100/ws/chat',
    createWebSocket: () => {
      const ws = new MockWebSocket();
      lastWs = ws;
      return ws;
    },
    reconnectDelayMs: 50,
  });
}

function openWithHandshake(conn: MitzoConnection): MockWebSocket {
  conn.connect();
  const ws = lastWs!;
  ws.simulateOpen();
  // hello is sent automatically
  ws.simulateMessage({ type: 'welcome', protocolVersion: 2, connectionId: 'conn-1' });
  return ws;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MitzoConnection', () => {
  describe('hello handshake', () => {
    it('sends hello on WS open', () => {
      const conn = createConnection();
      conn.connect();
      const ws = lastWs!;
      ws.simulateOpen();

      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'hello', protocolVersion: 2 }));
    });

    it('fires _open to listener after welcome response', () => {
      const conn = createConnection();
      const received: Record<string, unknown>[] = [];
      conn.onMessage((msg) => received.push(msg));

      const ws = openWithHandshake(conn);

      expect(received.some((m) => m.type === '_open')).toBe(true);
      expect(conn.isConnected()).toBe(true);
      void ws; // suppress unused
    });

    it('stores connectionId from welcome', () => {
      const conn = createConnection();
      conn.onMessage(() => {});
      openWithHandshake(conn);

      expect(conn.getConnectionId()).toBe('conn-1');
    });

    it('does not fire _open before welcome arrives', () => {
      const conn = createConnection();
      const received: Record<string, unknown>[] = [];
      conn.onMessage((msg) => received.push(msg));
      conn.connect();
      const ws = lastWs!;
      ws.simulateOpen();

      // Only hello sent, no _open yet
      expect(received.some((m) => m.type === '_open')).toBe(false);
      expect(conn.isConnected()).toBe(false);
    });
  });

  describe('send and queue', () => {
    it('sends message when connected', () => {
      const conn = createConnection();
      conn.onMessage(() => {});
      const ws = openWithHandshake(conn);

      const sent = conn.send({ type: 'send', sessionId: null, prompt: 'hi', clientMsgId: 'u1' });
      expect(sent).toBe(true);
      // hello + the send message
      expect(ws.send).toHaveBeenLastCalledWith(
        JSON.stringify({ type: 'send', sessionId: null, prompt: 'hi', clientMsgId: 'u1' }),
      );
    });

    it('queues sends before handshake completes and flushes after welcome', () => {
      const conn = createConnection();
      conn.onMessage(() => {});
      conn.connect();
      const ws = lastWs!;

      const sent = conn.send({ type: 'send', prompt: 'queued' });
      expect(sent).toBe(true);
      // Only hello should be on the wire after open, not the queued send
      ws.simulateOpen();
      const callsBeforeWelcome = ws.send.mock.calls.length;

      ws.simulateMessage({ type: 'welcome', protocolVersion: 2, connectionId: 'c1' });

      // After welcome, queued message should be flushed
      expect(ws.send.mock.calls.length).toBeGreaterThan(callsBeforeWelcome);
      const lastPayload = JSON.parse(ws.send.mock.calls[ws.send.mock.calls.length - 1][0]);
      expect(lastPayload).toEqual({ type: 'send', prompt: 'queued' });
    });

    it('returns false when disconnected with no reconnect pending', () => {
      const conn = createConnection();
      expect(conn.send({ type: 'test' })).toBe(false);
    });
  });

  describe('message delivery', () => {
    it('forwards inbound messages to the listener', () => {
      const conn = createConnection();
      const received: Record<string, unknown>[] = [];
      conn.onMessage((msg) => received.push(msg));
      const ws = openWithHandshake(conn);

      ws.simulateMessage({ v: 2, type: 'block_delta', sessionId: 's1', delta: 'hi' });

      expect(received.some((m) => m.type === 'block_delta')).toBe(true);
    });

    it('does not deliver welcome to the listener as a protocol event', () => {
      const conn = createConnection();
      const received: Record<string, unknown>[] = [];
      conn.onMessage((msg) => received.push(msg));
      openWithHandshake(conn);

      // welcome should be consumed internally, not forwarded
      expect(received.filter((m) => m.type === 'welcome')).toHaveLength(0);
    });
  });

  describe('seq tracking', () => {
    it('tracks lastSeq from inbound events', () => {
      const conn = createConnection();
      conn.onMessage(() => {});
      const ws = openWithHandshake(conn);

      ws.simulateMessage({ v: 2, type: 'block_delta', sessionId: 's1', seq: 5 });
      ws.simulateMessage({ v: 2, type: 'block_delta', sessionId: 's1', seq: 8 });
      ws.simulateMessage({ v: 2, type: 'block_delta', sessionId: 's2', seq: 3 });

      expect(conn.getLastSeq('s1')).toBe(8);
      expect(conn.getLastSeq('s2')).toBe(3);
      expect(conn.getLastSeq('unknown')).toBe(0);
    });

    it('allows manual seq tracking via trackSeq', () => {
      const conn = createConnection();
      conn.trackSeq('s1', 10);
      expect(conn.getLastSeq('s1')).toBe(10);
    });

    it('clears session seq on clearSession', () => {
      const conn = createConnection();
      conn.trackSeq('s1', 10);
      conn.clearSession('s1');
      expect(conn.getLastSeq('s1')).toBe(0);
    });
  });

  describe('reconnect', () => {
    it('reconnects after close and sends hello + reconnect with tracked sessions', () => {
      vi.useFakeTimers();
      const conn = createConnection();
      const received: Record<string, unknown>[] = [];
      conn.onMessage((msg) => received.push(msg));

      const ws1 = openWithHandshake(conn);
      ws1.simulateMessage({ v: 2, type: 'block_delta', sessionId: 's1', seq: 5 });
      ws1.simulateMessage({ v: 2, type: 'block_delta', sessionId: 's2', seq: 3 });

      // Disconnect
      ws1.simulateClose();
      expect(received.some((m) => m.type === '_close')).toBe(true);

      // Advance past reconnect delay
      vi.advanceTimersByTime(100);

      const ws2 = lastWs!;
      expect(ws2).not.toBe(ws1);
      ws2.simulateOpen();

      // hello should be sent
      expect(ws2.send).toHaveBeenCalledWith(JSON.stringify({ type: 'hello', protocolVersion: 2 }));

      // Simulate welcome
      ws2.simulateMessage({ type: 'welcome', protocolVersion: 2, connectionId: 'conn-2' });

      // reconnect should be sent with both tracked sessions
      const calls = ws2.send.mock.calls.map((c: string[]) => JSON.parse(c[0]));
      const reconnectMsg = calls.find((c: Record<string, unknown>) => c.type === 'reconnect');
      expect(reconnectMsg).toBeDefined();
      expect(reconnectMsg.sessions).toEqual(
        expect.arrayContaining([
          { sessionId: 's1', lastSeq: 5 },
          { sessionId: 's2', lastSeq: 3 },
        ]),
      );

      vi.useRealTimers();
    });

    it('does not send reconnect if no sessions are tracked', () => {
      vi.useFakeTimers();
      const conn = createConnection();
      conn.onMessage(() => {});

      const ws1 = openWithHandshake(conn);
      ws1.simulateClose();
      vi.advanceTimersByTime(100);

      const ws2 = lastWs!;
      ws2.simulateOpen();
      ws2.simulateMessage({ type: 'welcome', protocolVersion: 2, connectionId: 'conn-2' });

      const calls = ws2.send.mock.calls.map((c: string[]) => JSON.parse(c[0]));
      expect(calls.some((c: Record<string, unknown>) => c.type === 'reconnect')).toBe(false);

      vi.useRealTimers();
    });

    it('flushes pending sends after reconnect handshake', () => {
      vi.useFakeTimers();
      const conn = createConnection();
      conn.onMessage(() => {});
      const ws1 = openWithHandshake(conn);
      ws1.simulateClose();

      // Queue a send during disconnect
      conn.send({ type: 'send', prompt: 'pending' });

      vi.advanceTimersByTime(100);
      const ws2 = lastWs!;
      ws2.simulateOpen();
      ws2.simulateMessage({ type: 'welcome', protocolVersion: 2, connectionId: 'conn-2' });

      const calls = ws2.send.mock.calls.map((c: string[]) => JSON.parse(c[0]));
      expect(calls).toContainEqual({ type: 'send', prompt: 'pending' });

      vi.useRealTimers();
    });
  });

  describe('disconnect', () => {
    it('closes the WS and clears reconnect timer', () => {
      vi.useFakeTimers();
      const conn = createConnection();
      conn.onMessage(() => {});
      const ws = openWithHandshake(conn);
      ws.simulateClose();

      // Reconnect is pending
      conn.disconnect();

      // Advance timer — no new WS should be created
      const wsBefore = lastWs;
      vi.advanceTimersByTime(200);
      expect(lastWs).toBe(wsBefore);

      vi.useRealTimers();
    });
  });

  describe('iOS reconnect resilience', () => {
    it('reconnects when heartbeat detects dead socket', () => {
      vi.useFakeTimers();
      const conn = createConnection();
      conn.onMessage(() => {});
      const ws = openWithHandshake(conn);

      // Simulate iOS silent death — readyState changes without onclose firing
      ws.readyState = 3; // CLOSED

      // Heartbeat fires every 5s
      vi.advanceTimersByTime(5_000);

      // A new WS should have been created
      expect(lastWs).not.toBe(ws);

      vi.useRealTimers();
    });

    // Browser-specific tests (visibilitychange, pageshow) require a DOM
    // environment and are covered by the frontend test suite. Here we verify
    // the heartbeat path which works in Node.

    it('emits _close when heartbeat detects dead socket', () => {
      vi.useFakeTimers();
      const conn = createConnection();
      const received: Record<string, unknown>[] = [];
      conn.onMessage((msg) => received.push(msg));
      openWithHandshake(conn);

      // Kill socket silently
      lastWs!.readyState = 3;
      vi.advanceTimersByTime(5_000);

      expect(received.some((m) => m.type === '_close')).toBe(true);
      vi.useRealTimers();
    });

    it('skips browser listeners in non-browser environment', () => {
      // In Node, document is undefined — connect should not throw
      const conn = createConnection();
      conn.onMessage(() => {});
      openWithHandshake(conn);
      conn.disconnect();
    });

    it('defuses old WS handlers so delayed onclose does not trash new connection', () => {
      vi.useFakeTimers();
      const conn = createConnection();
      const received: Record<string, unknown>[] = [];
      conn.onMessage((msg) => received.push(msg));
      const oldWs = openWithHandshake(conn);

      // Simulate iOS silent death — heartbeat detects it
      oldWs.readyState = 3;
      vi.advanceTimersByTime(5_000);

      // A new WS was created
      const newWs = lastWs!;
      expect(newWs).not.toBe(oldWs);

      // Old WS handlers should be nulled (defused)
      expect(oldWs.onclose).toBeNull();
      expect(oldWs.onmessage).toBeNull();
      expect(oldWs.onerror).toBeNull();

      // Complete handshake on new WS
      newWs.simulateOpen();
      newWs.simulateMessage({ type: 'welcome', protocolVersion: 2, connectionId: 'conn-2' });
      expect(conn.isConnected()).toBe(true);

      // Connection should still be connected via new WS
      expect(conn.getConnectionId()).toBe('conn-2');

      vi.useRealTimers();
    });
  });

  describe('getTrackedSessions', () => {
    it('returns all session IDs tracked via seq numbers', () => {
      const conn = createConnection();
      openWithHandshake(conn);
      const ws = lastWs!;

      ws.simulateMessage({ type: 'message_start', sessionId: 'sess-a', seq: 1, messageId: 'm1' });
      ws.simulateMessage({ type: 'message_start', sessionId: 'sess-b', seq: 2, messageId: 'm2' });

      const tracked = conn.getTrackedSessions();
      expect(tracked).toContain('sess-a');
      expect(tracked).toContain('sess-b');
      expect(tracked).toHaveLength(2);
    });

    it('returns empty array when no sessions tracked', () => {
      const conn = createConnection();
      openWithHandshake(conn);
      expect(conn.getTrackedSessions()).toHaveLength(0);
    });

    it('excludes cleared sessions', () => {
      const conn = createConnection();
      openWithHandshake(conn);
      const ws = lastWs!;

      ws.simulateMessage({ type: 'message_start', sessionId: 'sess-a', seq: 1, messageId: 'm1' });
      ws.simulateMessage({ type: 'message_start', sessionId: 'sess-b', seq: 2, messageId: 'm2' });

      conn.clearSession('sess-a');

      const tracked = conn.getTrackedSessions();
      expect(tracked).toContain('sess-b');
      expect(tracked).not.toContain('sess-a');
      expect(tracked).toHaveLength(1);
    });
  });

  describe('checkAndReconnect', () => {
    it('forces reconnect even when WS appears OPEN (iOS stale socket)', () => {
      vi.useFakeTimers();
      const conn = createConnection();
      conn.onMessage(() => {});
      const ws1 = openWithHandshake(conn);
      expect(ws1.readyState).toBe(1); // OPEN

      // Force reconnect — simulates iOS foreground return
      conn.checkAndReconnect(true);

      // Old socket should be closed and defused
      expect(ws1.close).toHaveBeenCalled();
      expect(ws1.onclose).toBeNull();

      // New socket should be created
      const ws2 = lastWs!;
      expect(ws2).not.toBe(ws1);
      expect(conn.isConnected()).toBe(false);

      vi.useRealTimers();
    });

    it('preserves healthy socket when force=false (default)', () => {
      const conn = createConnection();
      conn.onMessage(() => {});
      const ws = openWithHandshake(conn);

      conn.checkAndReconnect(); // default: force=false

      // Same socket, still connected
      expect(lastWs).toBe(ws);
      expect(conn.isConnected()).toBe(true);
    });

    it('reconnects when WS is dead and force=false', () => {
      vi.useFakeTimers();
      const conn = createConnection();
      conn.onMessage(() => {});
      const ws1 = openWithHandshake(conn);

      // Simulate dead socket (readyState updated)
      ws1.readyState = 3;
      conn.checkAndReconnect(false);

      expect(lastWs).not.toBe(ws1);
      expect(conn.isConnected()).toBe(false);

      vi.useRealTimers();
    });

    it('is a no-op when reconnectTimer is already set', () => {
      vi.useFakeTimers();
      const conn = createConnection();
      conn.onMessage(() => {});
      const ws1 = openWithHandshake(conn);

      // Trigger a close to start the reconnect timer
      ws1.simulateClose();
      const wsAfterClose = lastWs;

      // Force check — should be a no-op because timer is pending
      conn.checkAndReconnect(true);
      expect(lastWs).toBe(wsAfterClose);

      vi.useRealTimers();
    });

    it('queues sends during forced reconnect and flushes after welcome', () => {
      vi.useFakeTimers();
      const conn = createConnection();
      conn.onMessage(() => {});
      openWithHandshake(conn);

      // Force reconnect (iOS resume)
      conn.checkAndReconnect(true);

      // Send while reconnecting — should queue
      const sent = conn.send({ type: 'send', prompt: 'first message' });
      expect(sent).toBe(true);

      // Complete handshake on new socket
      const ws2 = lastWs!;
      ws2.simulateOpen();
      ws2.simulateMessage({ type: 'welcome', protocolVersion: 2, connectionId: 'conn-2' });

      // Queued message should have been flushed
      const calls = ws2.send.mock.calls.map((c: string[]) => JSON.parse(c[0]));
      expect(calls).toContainEqual({ type: 'send', prompt: 'first message' });

      vi.useRealTimers();
    });

    it('closes the old socket to prevent server-side connection leak', () => {
      vi.useFakeTimers();
      const conn = createConnection();
      conn.onMessage(() => {});
      const ws = openWithHandshake(conn);

      conn.checkAndReconnect(true);

      // ws.close() must have been called — not just handler-nulled
      expect(ws.close).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('sendSuspend', () => {
    it('sends session_suspend via WS with all tracked sessions', () => {
      const conn = createConnection();
      conn.onMessage(() => {});
      const ws = openWithHandshake(conn);

      // Track two sessions
      ws.simulateMessage({ v: 2, type: 'block_delta', sessionId: 's1', seq: 5 });
      ws.simulateMessage({ v: 2, type: 'block_delta', sessionId: 's2', seq: 3 });

      conn.sendSuspend();

      const calls = ws.send.mock.calls.map((c: string[]) => JSON.parse(c[0]));
      const suspendMsg = calls.find((c: Record<string, unknown>) => c.type === 'session_suspend');
      expect(suspendMsg).toBeDefined();
      expect(suspendMsg.sessions).toEqual(
        expect.arrayContaining([
          { sessionId: 's1', lastSeq: 5 },
          { sessionId: 's2', lastSeq: 3 },
        ]),
      );
    });

    it('is a no-op when no sessions are tracked', () => {
      const conn = createConnection();
      conn.onMessage(() => {});
      const ws = openWithHandshake(conn);

      const callsBefore = ws.send.mock.calls.length;
      conn.sendSuspend();

      // No additional sends
      expect(ws.send.mock.calls.length).toBe(callsBefore);
    });

    it('does not throw when WS is closed', () => {
      const conn = createConnection();
      conn.onMessage(() => {});
      const ws = openWithHandshake(conn);

      ws.simulateMessage({ v: 2, type: 'block_delta', sessionId: 's1', seq: 1 });
      ws.readyState = 3; // CLOSED

      expect(() => conn.sendSuspend()).not.toThrow();
    });

    it('catches WS send errors gracefully', () => {
      const conn = createConnection();
      conn.onMessage(() => {});
      const ws = openWithHandshake(conn);

      ws.simulateMessage({ v: 2, type: 'block_delta', sessionId: 's1', seq: 1 });
      ws.send.mockImplementation(() => {
        throw new Error('Socket dying');
      });

      // Should not throw — sendBeacon fallback handles it
      expect(() => conn.sendSuspend()).not.toThrow();
    });
  });
});
