import { describe, expect, it, vi } from 'vitest';
import { MitzoConnection } from '../connection.js';
import type { WebSocketLike } from '../ws-connection.js';

class MockWebSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
}

describe('MitzoConnection authentication loss', () => {
  it('reconnects when a snapshot ACK is silently lost on an open socket', () => {
    vi.useFakeTimers();
    try {
      const sockets: MockWebSocket[] = [];
      const connection = new MitzoConnection({
        buildUrl: () => '/ws/chat',
        createWebSocket: () => {
          const socket = new MockWebSocket();
          sockets.push(socket);
          return socket;
        },
      });
      connection.onMessage((message) => {
        if (message.type === 'session_reconnect_snapshot')
          connection.acknowledgeReconnectSnapshot('sess-1', 5, 'offer-1');
        return true;
      });
      connection.connect();
      const socket = sockets[0];
      socket.readyState = 1;
      socket.onopen?.({});
      socket.onmessage?.({ data: JSON.stringify({ type: 'welcome', connectionId: 'conn-1' }) });
      connection.trackSeq('sess-1', 2);
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'session_reconnect_snapshot',
          sessionId: 'sess-1',
          cursor: 5,
          offerId: 'offer-1',
        }),
      });
      expect(
        socket.sent
          .map((value) => JSON.parse(value))
          .some((value) => value.type === 'reconnect_snapshot_applied'),
      ).toBe(true);
      expect(connection.getLastSeq('sess-1')).toBe(2);
      vi.advanceTimersByTime(30_000);
      expect(sockets).toHaveLength(2);
      connection.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });
  it('clears the prior connection identity when authentication is invalidated', () => {
    const socket = new MockWebSocket();
    const connection = new MitzoConnection({
      buildUrl: () => '/ws/chat',
      createWebSocket: () => socket,
    });
    connection.connect();
    socket.onopen?.({});
    socket.onmessage?.({
      data: JSON.stringify({ type: 'welcome', protocolVersion: 2, connectionId: 'old-context' }),
    });
    expect(connection.getConnectionId()).toBe('old-context');

    connection.invalidateAuthentication();

    expect(connection.getConnectionId()).toBeNull();
    connection.disconnect();
  });

  it('detects an authentication rejection before opening a socket', async () => {
    const sockets: MockWebSocket[] = [];
    const listener = vi.fn();
    const connection = new MitzoConnection({
      buildUrl: () => '/ws/chat?token=expired',
      createWebSocket: () => {
        const socket = new MockWebSocket();
        sockets.push(socket);
        return socket;
      },
      checkAuth: vi.fn().mockResolvedValue({ status: 401 }),
    });
    connection.onMessage(listener);

    connection.connect();
    expect(
      connection.send({ type: 'send', sessionId: null, clientMsgId: 'first', prompt: 'secret' }),
    ).toBe(true);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({ type: '_auth_lost' }));

    expect(sockets).toHaveLength(0);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: '_send_failed', clientMsgId: 'first' }),
    );
    connection.disconnect();
  });

  it('does not replay a queued first prompt after an authentication close', () => {
    const sockets: MockWebSocket[] = [];
    const listener = vi.fn();
    const connection = new MitzoConnection({
      buildUrl: () => '/ws/chat?token=expired',
      createWebSocket: () => {
        const socket = new MockWebSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectDelayMs: 1,
    });
    connection.onMessage(listener);
    connection.connect();
    connection.send({
      type: 'send',
      sessionId: null,
      clientMsgId: 'first',
      prompt: 'sensitive',
    });

    sockets[0].onclose?.({ code: 4401 });

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: '_auth_lost' }));
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: '_send_failed', clientMsgId: 'first' }),
    );
    expect(sockets).toHaveLength(1);

    connection.checkAndReconnect(true);
    expect(sockets).toHaveLength(1);

    connection.restoreAuthentication();
    expect(sockets).toHaveLength(2);
    connection.disconnect();
  });
});
