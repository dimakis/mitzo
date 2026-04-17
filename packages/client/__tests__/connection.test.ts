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
});
