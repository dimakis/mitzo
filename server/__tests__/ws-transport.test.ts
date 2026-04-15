import { describe, it, expect, vi } from 'vitest';
import { WsTransport } from '../ws-transport.js';
import type { WebSocket } from 'ws';

/** Create a fake WebSocket with controllable readyState */
function fakeWs(readyState: number = 1): WebSocket {
  return {
    OPEN: 1,
    readyState,
    send: vi.fn(),
  } as unknown as WebSocket;
}

describe('WsTransport', () => {
  describe('send()', () => {
    it('sends JSON-stringified data when the socket is OPEN', () => {
      const ws = fakeWs(1); // OPEN
      const transport = new WsTransport(ws);
      const data = { type: 'test', value: 42 };

      transport.send(data);

      expect(ws.send).toHaveBeenCalledOnce();
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify(data));
    });

    it('does not send when the socket is CONNECTING', () => {
      const ws = fakeWs(0); // CONNECTING
      const transport = new WsTransport(ws);

      transport.send({ type: 'test' });

      expect(ws.send).not.toHaveBeenCalled();
    });

    it('does not send when the socket is CLOSING', () => {
      const ws = fakeWs(2); // CLOSING
      const transport = new WsTransport(ws);

      transport.send({ type: 'test' });

      expect(ws.send).not.toHaveBeenCalled();
    });

    it('does not send when the socket is CLOSED', () => {
      const ws = fakeWs(3); // CLOSED
      const transport = new WsTransport(ws);

      transport.send({ type: 'test' });

      expect(ws.send).not.toHaveBeenCalled();
    });

    it('serializes nested objects correctly', () => {
      const ws = fakeWs(1);
      const transport = new WsTransport(ws);
      const data = {
        type: 'block_delta',
        nested: { a: [1, 2, 3], b: { c: true } },
      };

      transport.send(data);

      const sent = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(JSON.parse(sent)).toEqual(data);
    });

    it('handles multiple sequential sends', () => {
      const ws = fakeWs(1);
      const transport = new WsTransport(ws);

      transport.send({ seq: 1 });
      transport.send({ seq: 2 });
      transport.send({ seq: 3 });

      expect(ws.send).toHaveBeenCalledTimes(3);
    });

    it('respects readyState changes between sends', () => {
      const ws = fakeWs(1);
      const transport = new WsTransport(ws);

      transport.send({ seq: 1 });
      expect(ws.send).toHaveBeenCalledTimes(1);

      // Socket transitions to CLOSING
      (ws as unknown as { readyState: number }).readyState = 2;
      transport.send({ seq: 2 });
      expect(ws.send).toHaveBeenCalledTimes(1); // no additional call
    });
  });

  describe('isOpen()', () => {
    it('returns true when the socket is OPEN', () => {
      const transport = new WsTransport(fakeWs(1));
      expect(transport.isOpen()).toBe(true);
    });

    it('returns false when the socket is CONNECTING', () => {
      const transport = new WsTransport(fakeWs(0));
      expect(transport.isOpen()).toBe(false);
    });

    it('returns false when the socket is CLOSING', () => {
      const transport = new WsTransport(fakeWs(2));
      expect(transport.isOpen()).toBe(false);
    });

    it('returns false when the socket is CLOSED', () => {
      const transport = new WsTransport(fakeWs(3));
      expect(transport.isOpen()).toBe(false);
    });

    it('reflects readyState changes dynamically', () => {
      const ws = fakeWs(1);
      const transport = new WsTransport(ws);

      expect(transport.isOpen()).toBe(true);

      (ws as unknown as { readyState: number }).readyState = 3;
      expect(transport.isOpen()).toBe(false);
    });
  });

  describe('ws property', () => {
    it('exposes the underlying WebSocket', () => {
      const ws = fakeWs(1);
      const transport = new WsTransport(ws);
      expect(transport.ws).toBe(ws);
    });
  });
});
