import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WS_MAX_BUFFER_SIZE as MAX_BUFFER_SIZE } from '../constants';

// Mock WebSocket so the pool module doesn't try real connections
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  CONNECTING = MockWebSocket.CONNECTING;
  OPEN = MockWebSocket.OPEN;
  CLOSING = MockWebSocket.CLOSING;
  CLOSED = MockWebSocket.CLOSED;

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

let lastCreatedWs: MockWebSocket | null = null;

Object.defineProperty(globalThis, 'WebSocket', {
  value: class extends MockWebSocket {
    constructor() {
      super();
      lastCreatedWs = this; // eslint-disable-line @typescript-eslint/no-this-alias
    }
  },
  writable: true,
});
Object.defineProperty(globalThis, 'location', {
  value: { protocol: 'http:', host: 'localhost:3100' },
  writable: true,
});

// Import after mocks are set up
const { wsSubscribe, wsDrainBuffer } = await import('../ws-pool.js');
type WsMsg = import('../ws-pool.js').WsMsg;

describe('ws-pool message buffering', () => {
  beforeEach(() => {
    lastCreatedWs = null;
  });

  it('buffers messages when no listeners are subscribed', () => {
    const unsub = wsSubscribe('test-buf-1', () => {});
    const ws = lastCreatedWs!;
    ws.simulateOpen();

    // Remove the listener — simulate unmount
    unsub();

    // Server sends v2 protocol messages while component is unmounted
    ws.simulateMessage({ type: 'block_delta', blockId: 'b1', delta: 'hello' });
    ws.simulateMessage({
      type: 'block_end',
      blockId: 'b2',
      blockType: 'tool_use',
      toolName: 'Read',
      toolId: 't1',
    });
    ws.simulateMessage({ type: 'session_end', sessionId: 'sess-1' });

    const buffered = wsDrainBuffer('test-buf-1');
    expect(buffered).toHaveLength(3);
    expect(buffered[0]).toEqual({ type: 'block_delta', blockId: 'b1', delta: 'hello' });
    expect(buffered[2]).toEqual({ type: 'session_end', sessionId: 'sess-1' });
  });

  it('does not buffer non-UI messages like _open, _close, client_id', () => {
    const unsub = wsSubscribe('test-buf-2', () => {});
    const ws = lastCreatedWs!;
    ws.simulateOpen();
    unsub();

    ws.simulateMessage({ type: 'client_id', clientId: 'c1' });
    // _open and _close are generated internally, not via simulateMessage

    const buffered = wsDrainBuffer('test-buf-2');
    expect(buffered).toHaveLength(0);
  });

  it('drains buffer and clears it', () => {
    const unsub = wsSubscribe('test-buf-3', () => {});
    const ws = lastCreatedWs!;
    ws.simulateOpen();
    unsub();

    ws.simulateMessage({ type: 'message_end', messageId: 'm1' });

    const first = wsDrainBuffer('test-buf-3');
    expect(first).toHaveLength(1);

    const second = wsDrainBuffer('test-buf-3');
    expect(second).toHaveLength(0);
  });

  it('caps buffer at MAX_BUFFER_SIZE', () => {
    const unsub = wsSubscribe('test-buf-4', () => {});
    const ws = lastCreatedWs!;
    ws.simulateOpen();
    unsub();

    for (let i = 0; i < MAX_BUFFER_SIZE + 50; i++) {
      ws.simulateMessage({ type: 'block_delta', blockId: 'b1', delta: `chunk-${i}` });
    }

    const buffered = wsDrainBuffer('test-buf-4');
    expect(buffered).toHaveLength(MAX_BUFFER_SIZE);
    const first = buffered[0];
    const last = buffered[MAX_BUFFER_SIZE - 1];
    expect(first.type === 'block_delta' && first.delta).toBe('chunk-0');
    expect(last.type === 'block_delta' && last.delta).toBe(`chunk-${MAX_BUFFER_SIZE - 1}`);
  });

  it('delivers messages directly when listeners exist (no buffering)', () => {
    const received: Array<WsMsg> = [];
    wsSubscribe('test-buf-5', (msg) => received.push(msg));
    const ws = lastCreatedWs!;
    ws.simulateOpen();

    ws.simulateMessage({ type: 'block_delta', blockId: 'b1', delta: 'live' });

    expect(received.some((m) => m.type === 'block_delta')).toBe(true);
    const buffered = wsDrainBuffer('test-buf-5');
    expect(buffered).toHaveLength(0);
  });

  it('replays buffered messages on re-subscribe', () => {
    const unsub = wsSubscribe('test-buf-6', () => {});
    const ws = lastCreatedWs!;
    ws.simulateOpen();
    unsub();

    ws.simulateMessage({ type: 'block_delta', blockId: 'b1', delta: 'missed-1' });
    ws.simulateMessage({ type: 'message_end', messageId: 'm1' });

    // Re-subscribe and drain
    const replayed: Array<WsMsg> = [];
    wsSubscribe('test-buf-6', (msg) => replayed.push(msg));
    const buffered = wsDrainBuffer('test-buf-6');
    for (const msg of buffered) replayed.push(msg);

    expect(replayed.some((m) => m.type === 'block_delta')).toBe(true);
    expect(replayed.some((m) => m.type === 'message_end')).toBe(true);
  });

  it('returns empty array for unknown keys', () => {
    expect(wsDrainBuffer('nonexistent')).toEqual([]);
  });
});
