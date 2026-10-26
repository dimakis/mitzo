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
    ackSnapshot: vi.fn(() => true),
    resync: overflow,
  });
  return { tracker, cursors, received, acks, overflow };
}

describe('AppliedDelivery', () => {
  it.each(['before', 'after'] as const)(
    'acknowledges REST-covered events arriving %s snapshot confirmation without rendering twice',
    async (arrival) => {
      let cursor = 2;
      let confirm!: (applied: boolean) => void;
      const deliver = vi.fn(() => true);
      const ackEvent = vi.fn();
      const tracker = new AppliedDelivery({
        getCursor: () => cursor,
        setCursor: (_, seq) => {
          cursor = seq;
        },
        deliver,
        ackEvent,
        ackSnapshot: () =>
          new Promise<boolean>((resolve) => {
            confirm = resolve;
          }),
        resync: vi.fn(),
      });
      tracker.offerSnapshot('a', 5, 'offer', 'conn');
      tracker.acknowledgeSnapshot('a', 5, 'offer', 'conn');
      // The renderer installs REST history while the offer's HTTP ACK is in flight.
      tracker.commitTranscript('a', 9);
      expect(cursor).toBe(2);
      expect(ackEvent).not.toHaveBeenCalled();
      const receivePrefix = () => {
        tracker.receive({ sessionId: 'a', seq: 7, prevSessionSeq: 5 });
        tracker.receive({ sessionId: 'a', seq: 9, prevSessionSeq: 7 });
      };
      if (arrival === 'before') receivePrefix();
      confirm(true);
      await Promise.resolve();
      if (arrival === 'after') receivePrefix();
      expect(cursor).toBe(9);
      expect(deliver).not.toHaveBeenCalled();
      expect(ackEvent.mock.calls).toEqual([
        ['a', 7],
        ['a', 9],
      ]);
      tracker.receive({ sessionId: 'a', seq: 12, prevSessionSeq: 9 });
      expect(deliver).toHaveBeenCalledExactlyOnceWith({
        sessionId: 'a',
        seq: 12,
        prevSessionSeq: 9,
      });
      expect(cursor).toBe(12);
    },
  );

  it('uses the latest installed prefix when a bounded restore replaces newer history', () => {
    const h = harness();
    h.tracker.offerSnapshot('a', 5, 'offer', 'conn');
    h.tracker.commitTranscript('a', 9);
    h.tracker.commitTranscript('a', 5);
    h.tracker.receive({ sessionId: 'a', seq: 7, prevSessionSeq: 5 });
    h.tracker.acknowledgeSnapshot('a', 5, 'offer', 'conn');
    expect(h.received).toEqual([7]);
    expect(h.acks).toEqual([7]);
  });

  it('does not skip predecessor gaps in REST-covered events', () => {
    const h = harness();
    h.tracker.offerSnapshot('a', 5, 'offer', 'conn');
    h.tracker.commitTranscript('a', 9);
    h.tracker.receive({ sessionId: 'a', seq: 9, prevSessionSeq: 7 });
    h.tracker.acknowledgeSnapshot('a', 5, 'offer', 'conn');
    expect(h.cursors.get('a')).toBe(5);
    expect(h.acks).toEqual([]);
    h.tracker.receive({ sessionId: 'a', seq: 7, prevSessionSeq: 5 });
    expect(h.cursors.get('a')).toBe(9);
    expect(h.received).toEqual([]);
    expect(h.acks).toEqual([7, 9]);
  });

  it.each(['offer', 'session', 'connection', 'replay'] as const)(
    'discards installed coverage after replacing the %s',
    (replacement) => {
      const h = harness();
      h.tracker.offerSnapshot('a', 5, 'old', 'conn');
      h.tracker.commitTranscript('a', 9);
      if (replacement === 'session') h.tracker.clearSession('a');
      if (replacement === 'connection') h.tracker.clearPending();
      if (replacement === 'replay') {
        h.tracker.acknowledgeSnapshot('a', 5, 'old', 'conn');
        h.tracker.holdReplay('a');
        h.tracker.releaseReplay('a');
        h.tracker.receive({ sessionId: 'a', seq: 7, prevSessionSeq: 5 });
      } else {
        h.tracker.offerSnapshot('a', 5, 'new', 'conn-2');
        h.tracker.receive({ sessionId: 'a', seq: 7, prevSessionSeq: 5 });
        expect(h.tracker.confirmSnapshot('a', 5, 'old', 'conn')).toBe(false);
        h.tracker.acknowledgeSnapshot('a', 5, 'new', 'conn-2');
      }
      expect(h.received).toEqual([7]);
      expect(h.acks).toEqual([7]);
    },
  );

  it('keeps installed history fenced when the server rejects its snapshot ACK', async () => {
    const setCursor = vi.fn();
    const deliver = vi.fn();
    const ackEvent = vi.fn();
    const resync = vi.fn();
    const rejected = new AppliedDelivery({
      getCursor: () => 2,
      setCursor,
      deliver,
      ackEvent,
      ackSnapshot: () => Promise.resolve(false),
      resync,
    });
    rejected.offerSnapshot('a', 5, 'offer', 'conn');
    rejected.commitTranscript('a', 9);
    rejected.receive({ sessionId: 'a', seq: 7, prevSessionSeq: 5 });
    rejected.acknowledgeSnapshot('a', 5, 'offer', 'conn');
    await Promise.resolve();
    expect(resync).toHaveBeenCalledExactlyOnceWith('a');
    expect(setCursor).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(ackEvent).not.toHaveBeenCalled();
    rejected.clearPending();
  });

  it('retains an offered cursor until exact server confirmation and reconnects after silent ACK loss', () => {
    vi.useFakeTimers();
    try {
      const cursors = new Map([['a', 2]]);
      const delivered = vi.fn(() => true);
      const resync = vi.fn();
      const ackSnapshot = vi.fn(() => undefined);
      const tracker = new AppliedDelivery({
        getCursor: (id) => cursors.get(id) ?? 0,
        setCursor: (id, seq) => {
          cursors.set(id, seq);
        },
        deliver: delivered,
        ackEvent: vi.fn(),
        ackSnapshot,
        resync,
      });
      tracker.offerSnapshot('a', 5, 'offer', 'conn-1');
      tracker.receive({ sessionId: 'a', seq: 6, prevSessionSeq: 5 });
      expect(tracker.acknowledgeSnapshot('a', 5, 'offer', 'conn-1')).toBe(true);
      expect(cursors.get('a')).toBe(2);
      expect(delivered).not.toHaveBeenCalled();
      expect(tracker.confirmSnapshot('a', 5, 'wrong', 'conn-1')).toBe(false);
      vi.advanceTimersByTime(30_000);
      expect(resync).toHaveBeenCalledWith('a');
      expect(ackSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
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
