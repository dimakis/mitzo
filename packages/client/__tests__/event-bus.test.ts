import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus } from '../src/event-bus.js';

// ─── Mock EventSource ───────────────────────────────────────────────────────

class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  readyState = MockEventSource.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private handlers = new Map<string, ((e: MessageEvent) => void)[]>();

  close = vi.fn(() => {
    this.readyState = MockEventSource.CLOSED;
  });

  addEventListener(type: string, handler: (e: MessageEvent) => void) {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  removeEventListener(type: string, handler: (e: MessageEvent) => void) {
    const list = this.handlers.get(type);
    if (!list) return;
    this.handlers.set(
      type,
      list.filter((h) => h !== handler),
    );
  }

  // Test helpers
  simulateOpen() {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.(null);
  }

  simulateEvent(type: string, data: unknown) {
    const handlers = this.handlers.get(type) ?? [];
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const h of handlers) h(event);
  }

  simulateError() {
    this.readyState = MockEventSource.CONNECTING; // EventSource reconnects
    this.onerror?.(new Event('error'));
  }
}

// ─── Setup ──────────────────────────────────────────────────────────────────

let lastSource: MockEventSource | null = null;

function createBus(): EventBus {
  lastSource = null;
  return new EventBus((_url: string) => {
    const source = new MockEventSource();
    lastSource = source;
    return source as unknown as EventSource;
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = createBus();
  });

  afterEach(() => {
    bus.disconnect();
  });

  it('starts disconnected', () => {
    expect(bus.connected).toBe(false);
  });

  it('connects and reports connected state', () => {
    bus.connect('/api/events');
    lastSource!.simulateOpen();
    expect(bus.connected).toBe(true);
  });

  it('dispatches typed events to subscribers', () => {
    const handler = vi.fn();
    bus.on('session_activity', handler);
    bus.connect('/api/events');
    lastSource!.simulateOpen();

    lastSource!.simulateEvent('session_activity', [{ id: 's1', state: 'working' }]);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith([{ id: 's1', state: 'working' }]);
  });

  it('supports multiple listeners per event type', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('todo_update', h1);
    bus.on('todo_update', h2);
    bus.connect('/api/events');
    lastSource!.simulateOpen();

    lastSource!.simulateEvent('todo_update', { action: 'refresh' });

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('supports multiple event types independently', () => {
    const sessionHandler = vi.fn();
    const todoHandler = vi.fn();
    bus.on('session_activity', sessionHandler);
    bus.on('todo_update', todoHandler);
    bus.connect('/api/events');
    lastSource!.simulateOpen();

    lastSource!.simulateEvent('session_activity', []);
    expect(sessionHandler).toHaveBeenCalledOnce();
    expect(todoHandler).not.toHaveBeenCalled();

    lastSource!.simulateEvent('todo_update', { action: 'refresh' });
    expect(todoHandler).toHaveBeenCalledOnce();
  });

  it('unsubscribes via returned function', () => {
    const handler = vi.fn();
    const unsub = bus.on('loop_status', handler);
    bus.connect('/api/events');
    lastSource!.simulateOpen();

    lastSource!.simulateEvent('loop_status', { state: 'running' });
    expect(handler).toHaveBeenCalledOnce();

    unsub();
    lastSource!.simulateEvent('loop_status', { state: 'idle' });
    expect(handler).toHaveBeenCalledOnce(); // not called again
  });

  it('subscribes after connect — late listeners work', () => {
    bus.connect('/api/events');
    lastSource!.simulateOpen();

    const handler = vi.fn();
    bus.on('health', handler);

    lastSource!.simulateEvent('health', { yapper: 'ok' });
    expect(handler).toHaveBeenCalledWith({ yapper: 'ok' });
  });

  it('disconnect closes the EventSource', () => {
    bus.connect('/api/events');
    lastSource!.simulateOpen();
    const src = lastSource!;

    bus.disconnect();
    expect(src.close).toHaveBeenCalledOnce();
    expect(bus.connected).toBe(false);
  });

  it('disconnect is safe to call when not connected', () => {
    expect(() => bus.disconnect()).not.toThrow();
  });

  it('ensureConnected recreates a CLOSED EventSource', () => {
    bus.connect('/api/events');
    lastSource!.simulateOpen();
    const firstSource = lastSource;

    // Simulate EventSource giving up (CLOSED state)
    firstSource!.readyState = MockEventSource.CLOSED;

    bus.ensureConnected();
    expect(lastSource).not.toBe(firstSource); // new instance created
  });

  it('ensureConnected no-ops when still connected', () => {
    bus.connect('/api/events');
    lastSource!.simulateOpen();
    const firstSource = lastSource;

    bus.ensureConnected();
    expect(lastSource).toBe(firstSource); // same instance
  });

  it('ensureConnected no-ops when reconnecting (CONNECTING)', () => {
    bus.connect('/api/events');
    // readyState is still CONNECTING (0) — EventSource is trying to connect
    const firstSource = lastSource;

    bus.ensureConnected();
    expect(lastSource).toBe(firstSource); // same instance
  });

  it('fires onConnectionChange callback on open', () => {
    const onChange = vi.fn();
    bus.onConnectionChange(onChange);
    bus.connect('/api/events');
    lastSource!.simulateOpen();
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('fires onConnectionChange callback on error', () => {
    const onChange = vi.fn();
    bus.onConnectionChange(onChange);
    bus.connect('/api/events');
    lastSource!.simulateOpen();
    onChange.mockClear();

    lastSource!.simulateError();
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('preserves listeners across reconnect', () => {
    const handler = vi.fn();
    bus.on('task_state', handler);
    bus.connect('/api/events');
    lastSource!.simulateOpen();

    // Simulate EventSource dying and being recreated
    lastSource!.readyState = MockEventSource.CLOSED;
    bus.ensureConnected();
    lastSource!.simulateOpen();

    lastSource!.simulateEvent('task_state', { tasks: [] });
    expect(handler).toHaveBeenCalledWith({ tasks: [] });
  });
});
