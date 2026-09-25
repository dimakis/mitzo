import { describe, expect, it, vi } from 'vitest';
import { AppliedDelivery } from '../applied-delivery.js';

function harness() {
  const cursors = new Map<string, number>([['a', 2]]);
  const received: number[] = [];
  const acks: number[] = [];
  const overflow = vi.fn();
  const tracker = new AppliedDelivery({
    getCursor: (sessionId) => cursors.get(sessionId) ?? 0,
    setCursor: (sessionId, seq) => cursors.set(sessionId, seq),
    deliver: (event) => {
      received.push(event.seq as number);
      return true;
    },
    ackEvent: (_sessionId, seq) => acks.push(seq),
    ackSnapshot: vi.fn(),
    resync: overflow,
  });
  return { tracker, cursors, received, acks, overflow };
}

describe('AppliedDelivery', () => {
  it('uses session predecessors across interleaved global IDs and drains a missing event once', () => {
    const h = harness();
    h.tracker.receive({ sessionId: 'a', seq: 9, prevSessionSeq: 5, type: 'block_delta' });
    expect(h.received).toEqual([]);
    h.tracker.receive({ sessionId: 'a', seq: 5, prevSessionSeq: 2, type: 'block_delta' });
    h.tracker.receive({ sessionId: 'a', seq: 9, prevSessionSeq: 5, type: 'block_delta' });
    expect(h.received).toEqual([5, 9]);
    expect(h.acks).toEqual([5, 9, 9]);
    expect(h.cursors.get('a')).toBe(9);
  });

  it('re-acknowledges a durable duplicate after the prior acknowledgement is lost', () => {
    const h = harness();
    const event = { sessionId: 'a', seq: 5, prevSessionSeq: 2, type: 'block_delta' };
    h.tracker.receive(event);
    h.tracker.receive(event);
    expect(h.received).toEqual([5]);
    expect(h.acks).toEqual([5, 5]);
  });

  it('does not advance or acknowledge when the synchronous reducer rejects an event', () => {
    const h = harness();
    h.tracker.setDeliver(() => false);
    h.tracker.receive({ sessionId: 'a', seq: 5, prevSessionSeq: 2, type: 'block_delta' });
    expect(h.acks).toEqual([]);
    expect(h.cursors.get('a')).toBe(2);
    expect(h.overflow).toHaveBeenCalledWith('a');
    h.tracker.setDeliver(() => true);
    h.tracker.receive({ sessionId: 'a', seq: 5, prevSessionSeq: 2, type: 'block_delta' });
    expect(h.acks).toEqual([5]);
  });

  it('requires explicit application and keeps a thrown callback unacknowledged', () => {
    const h = harness();
    h.tracker.setDeliver(() => undefined);
    h.tracker.receive({ sessionId: 'a', seq: 5, prevSessionSeq: 2, type: 'block_delta' });
    expect(h.cursors.get('a')).toBe(2);
    expect(h.acks).toEqual([]);
    expect(h.overflow).not.toHaveBeenCalled();
    h.tracker.setDeliver(() => {
      throw new Error('reducer failed');
    });
    h.tracker.receive({ sessionId: 'a', seq: 5, prevSessionSeq: 2, type: 'block_delta' });
    expect(h.cursors.get('a')).toBe(2);
    expect(h.acks).toEqual([]);
    expect(h.overflow).toHaveBeenCalledWith('a');
  });

  it('fences snapshot callbacks and applies buffered suffix only after restore', () => {
    const h = harness();
    h.tracker.offerSnapshot('a', 5, 'old', 'conn-1');
    h.tracker.offerSnapshot('a', 7, 'new', 'conn-1');
    h.tracker.receive({ sessionId: 'a', seq: 9, prevSessionSeq: 7, type: 'block_delta' });
    expect(h.tracker.acknowledgeSnapshot('a', 5, 'old', 'conn-1')).toBe(false);
    expect(h.tracker.acknowledgeSnapshot('a', 7, 'new', 'conn-2')).toBe(false);
    expect(h.received).toEqual([]);
    expect(h.tracker.acknowledgeSnapshot('a', 7, 'new', 'conn-1')).toBe(true);
    expect(h.received).toEqual([9]);
    expect(h.cursors.get('a')).toBe(9);
  });

  it('does not claim replayed events before the durable transcript is applied', () => {
    const h = harness();
    h.tracker.holdReplay('a');
    h.tracker.receive({ sessionId: 'a', seq: 5, prevSessionSeq: 2, type: 'block_delta' });
    h.tracker.offerSnapshot('a', 5, 'offer', 'conn-1');
    expect(h.received).toEqual([]);
    expect(h.acks).toEqual([]);
    expect(h.cursors.get('a')).toBe(2);
    h.tracker.acknowledgeSnapshot('a', 5, 'offer', 'conn-1');
    expect(h.received).toEqual([]);
    expect(h.cursors.get('a')).toBe(5);
  });

  it('holds post-cursor events arriving across a large snapshot restore and applies each once', () => {
    const h = harness();
    h.tracker.holdReplay('a');
    h.tracker.receive({ sessionId: 'a', seq: 271, prevSessionSeq: 270, type: 'block_delta' });
    h.tracker.offerSnapshot('a', 270, 'offer', 'conn-1');
    h.tracker.receive({ sessionId: 'a', seq: 275, prevSessionSeq: 271, type: 'block_end' });
    expect(h.received).toEqual([]);
    expect(h.cursors.get('a')).toBe(2);
    expect(h.tracker.acknowledgeSnapshot('a', 270, 'offer', 'conn-1')).toBe(true);
    expect(h.received).toEqual([271, 275]);
    expect(h.acks).toEqual([271, 275]);
    expect(h.cursors.get('a')).toBe(275);
    expect(h.overflow).not.toHaveBeenCalled();
  });

  it('requests resync instead of retaining an unbounded out-of-order suffix', () => {
    const h = harness();
    for (let i = 0; i < 260; i++)
      h.tracker.receive({
        sessionId: 'a',
        seq: 100 + i,
        prevSessionSeq: 99 + i,
        type: 'block_delta',
      });
    expect(h.overflow).toHaveBeenCalledWith('a');
    expect(h.cursors.get('a')).toBe(2);
  });

  it('requests resync when a single predecessor gap remains unresolved', () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.tracker.receive({ sessionId: 'a', seq: 9, prevSessionSeq: 5, type: 'block_delta' });
      expect(h.overflow).not.toHaveBeenCalled();
      vi.advanceTimersByTime(15_000);
      expect(h.overflow).toHaveBeenCalledWith('a');
      expect(h.cursors.get('a')).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries when a snapshot offer remains unapplied', () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.tracker.offerSnapshot('a', 5, 'offer', 'conn-1');
      vi.advanceTimersByTime(30_000);
      expect(h.overflow).toHaveBeenCalledWith('a');
      expect(h.cursors.get('a')).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
