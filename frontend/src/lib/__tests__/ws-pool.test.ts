import { describe, it, expect, beforeEach, vi } from 'vitest';

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
const { wsSubscribe, wsSetRunning } = await import('../ws-pool.js');
type WsMsg = import('../ws-pool.js').WsMsg;

describe('ws-pool message delivery', () => {
  beforeEach(() => {
    lastCreatedWs = null;
  });

  it('delivers messages directly to listeners', () => {
    const received: Array<WsMsg> = [];
    wsSubscribe('test-deliver-1', (msg) => received.push(msg));
    const ws = lastCreatedWs!;
    ws.simulateOpen();

    ws.simulateMessage({ type: 'block_delta', blockId: 'b1', delta: 'live' });

    expect(received.some((m) => m.type === 'block_delta')).toBe(true);
  });

  it('drops messages when no listeners are subscribed (no buffering)', () => {
    const unsub = wsSubscribe('test-deliver-2', () => {});
    const ws = lastCreatedWs!;
    ws.simulateOpen();
    unsub();

    // Messages sent while unmounted are dropped — recovery via seq-based replay
    ws.simulateMessage({ type: 'block_delta', blockId: 'b1', delta: 'hello' });

    // Re-subscribe — should not receive the dropped message
    const received: Array<WsMsg> = [];
    wsSubscribe('test-deliver-2', (msg) => received.push(msg));
    expect(received).toHaveLength(0);
  });
});

describe('ws-pool reattach_failed handling', () => {
  it('broadcasts _open after reattach_failed so component knows connection is live', () => {
    const received: Array<WsMsg> = [];
    wsSubscribe('test-reattach-fail-1', (msg) => received.push(msg));
    const ws1 = lastCreatedWs!;
    ws1.simulateOpen();

    // Simulate an active session: client_id assigned, marked as running
    ws1.simulateMessage({ type: 'client_id', clientId: 'old-id' });
    wsSetRunning('test-reattach-fail-1', true);

    // Clear initial messages
    received.length = 0;

    // Simulate disconnect + reconnect
    ws1.simulateClose();
    const ws2 = lastCreatedWs!;
    ws2.simulateOpen();

    // Server sends new client_id — pool sees wasRunning=true + prevClientId='old-id'
    // so it sends reattach and does NOT broadcast _open yet
    ws2.simulateMessage({ type: 'client_id', clientId: 'new-id' });

    // At this point, _open should NOT have been sent (waiting for reattach result)
    const typesBeforeReattach = received.filter((m) => m.type === '_open');
    // _open from ws2.simulateOpen is there (ws.onopen always fires), but the
    // client_id handler should NOT add another _open
    const openCountBefore = typesBeforeReattach.length;

    // Server responds with reattach_failed — pool should broadcast _open now
    ws2.simulateMessage({ type: 'reattach_failed', reason: 'no session' });

    const types = received.map((m) => m.type);
    expect(types).toContain('reattach_failed');
    // Must have an _open AFTER the reattach_failed to signal connection is live
    const openCountAfter = received.filter((m) => m.type === '_open').length;
    expect(openCountAfter).toBeGreaterThan(openCountBefore);
  });
});
