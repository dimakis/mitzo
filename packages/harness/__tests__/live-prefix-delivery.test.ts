import { expect, it, vi } from 'vitest';
import { ConnectionRegistry } from '../src/connection-registry.js';
import { AppliedDelivery } from '../../client/src/applied-delivery.js';

function fixture(count = 5) {
  const events = Array.from({ length: count }, (_, index) => ({
    sessionId: 'chat',
    seq: index + 1,
    type: index === 0 ? 'ordinary_reply_source' : 'block_delta',
    payload: index === 0 ? { providerThreadId: 'private' } : { delta: 'text' },
  }));
  const registry = new ConnectionRegistry();
  const store = {
    getEventsAfter: vi.fn((_id: string, after: number, limit = 50) =>
      events.filter((e) => e.seq > after).slice(0, limit),
    ),
    getSessionPredecessorSeq: (_id: string, seq: number) => seq - 1,
  };
  registry.setEventStore(store);
  let cursor = 0;
  const delivered: Record<string, unknown>[] = [];
  const client = new AppliedDelivery({
    getCursor: () => cursor,
    setCursor: (_id, seq) => {
      cursor = seq;
    },
    deliver: (event) => {
      delivered.push(event);
      return true;
    },
    ackEvent: () => {},
    ackSnapshot: () => true,
    resync: vi.fn(),
  });
  const send = vi.fn((event: Record<string, unknown>) => {
    client.receive(event);
  });
  registry.register('phone', { send, isOpen: () => true });
  registry.watch('phone', 'chat');
  registry.enableAppliedCursor('phone', 'chat', 0);
  return { registry, store, delivered, send, client, cursor: () => cursor };
}

it('delivers a missing private predecessor before live text without waiting for periodic retry', () => {
  const f = fixture();
  try {
    f.registry.broadcast('chat', { type: 'block_delta', seq: 4, delta: 'text' });
    expect(f.delivered.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(f.delivered[0]).not.toHaveProperty('providerThreadId');
    expect(f.cursor()).toBe(5);
    expect(f.registry.ackAppliedEvents('phone', 'chat', [1, 2, 3, 4, 5])).toBe(true);
  } finally {
    f.client.clearPending();
    f.registry.dispose();
  }
});

it('does not reread the durable prefix for each delta while HTTP acknowledgements are in flight', () => {
  const f = fixture();
  try {
    f.registry.broadcast('chat', { type: 'block_delta', seq: 4 });
    f.store.getEventsAfter.mockClear();
    f.registry.broadcast('chat', { type: 'block_delta', seq: 5 });
    expect(f.store.getEventsAfter).not.toHaveBeenCalled();
  } finally {
    f.client.clearPending();
    f.registry.dispose();
  }
});

it('keeps live catch-up bounded and continues only after an exact applied batch', () => {
  const f = fixture(110);
  try {
    f.registry.broadcast('chat', { type: 'block_delta', seq: 110 });
    expect(f.send).toHaveBeenCalledTimes(50);
    expect(f.cursor()).toBe(50);
    f.registry.broadcast('chat', { type: 'block_delta', seq: 110 });
    expect(f.send).toHaveBeenCalledTimes(50);
    expect(
      f.registry.ackAppliedEvents(
        'phone',
        'chat',
        Array.from({ length: 50 }, (_, i) => i + 1),
      ),
    ).toBe(true);
    expect(f.cursor()).toBe(100);
    expect(
      f.registry.ackAppliedEvents(
        'phone',
        'chat',
        Array.from({ length: 50 }, (_, i) => i + 51),
      ),
    ).toBe(true);
    expect(f.cursor()).toBe(110);
  } finally {
    f.client.clearPending();
    f.registry.dispose();
  }
});

it('does not confuse a failed write with a forwarded prefix', () => {
  const f = fixture();
  try {
    f.send.mockImplementationOnce(() => {
      throw Error('connection lost');
    });
    f.registry.broadcast('chat', { type: 'block_delta', seq: 4 });
    expect(f.cursor()).toBe(0);
    f.registry.broadcast('chat', { type: 'block_delta', seq: 5 });
    expect(f.cursor()).toBe(5);
    expect(f.delivered.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
  } finally {
    f.client.clearPending();
    f.registry.dispose();
  }
});
