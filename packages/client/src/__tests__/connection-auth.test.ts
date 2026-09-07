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
    connection.disconnect();
  });
});
