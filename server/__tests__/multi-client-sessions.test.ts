import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionRegistry } from '../session-registry.js';
import { broadcastToObservers } from '../query-loop.js';
import { MAX_OBSERVERS_PER_SESSION } from '../constants.js';
import type { SessionTransport } from '@mitzo/harness';

function mockTransport(open = true): SessionTransport & { _sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    send: vi.fn((data: Record<string, unknown>) => sent.push(data)),
    isOpen: () => open,
    _sent: sent,
  };
}

describe('SessionRegistry.addObserver', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry();
  });

  afterEach(() => {
    registry.dispose();
  });

  it('adds an observer to a session', () => {
    const transport = mockTransport();
    const obsTransport = mockTransport();
    registry.register('c1', {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: 'sess-1',
    });

    const result = registry.addObserver('sess-1', obsTransport);
    expect(result).toBe('c1');
    expect(registry.get('c1')!.observers.size).toBe(1);
  });

  it('is idempotent — same transport added twice does not increase count', () => {
    const transport = mockTransport();
    const obsTransport = mockTransport();
    registry.register('c1', {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: 'sess-1',
    });

    registry.addObserver('sess-1', obsTransport);
    registry.addObserver('sess-1', obsTransport);
    expect(registry.get('c1')!.observers.size).toBe(1);
  });

  it('caps observers at MAX_OBSERVERS_PER_SESSION', () => {
    const transport = mockTransport();
    registry.register('c1', {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: 'sess-1',
    });

    for (let i = 0; i < MAX_OBSERVERS_PER_SESSION; i++) {
      const result = registry.addObserver('sess-1', mockTransport());
      expect(result).toBe('c1');
    }

    // One more should be rejected
    const overflow = registry.addObserver('sess-1', mockTransport());
    expect(overflow).toBeNull();
    expect(registry.get('c1')!.observers.size).toBe(MAX_OBSERVERS_PER_SESSION);
  });

  it('returns null for unknown sessionId', () => {
    const result = registry.addObserver('nonexistent', mockTransport());
    expect(result).toBeNull();
  });
});

describe('SessionRegistry.removeObserver', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry();
  });

  afterEach(() => {
    registry.dispose();
  });

  it('removes an observer from all sessions', () => {
    const transport = mockTransport();
    const obsTransport = mockTransport();
    registry.register('c1', {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: 'sess-1',
    });
    registry.addObserver('sess-1', obsTransport);
    expect(registry.get('c1')!.observers.size).toBe(1);

    registry.removeObserver(obsTransport);
    expect(registry.get('c1')!.observers.size).toBe(0);
  });

  it('is a no-op when transport is not an observer', () => {
    const transport = mockTransport();
    registry.register('c1', {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: 'sess-1',
    });

    // Should not throw
    registry.removeObserver(mockTransport());
    expect(registry.get('c1')!.observers.size).toBe(0);
  });

  it('restarts detach timer when last observer leaves a detached session', () => {
    vi.useFakeTimers();
    const transport = mockTransport();
    const obsTransport = mockTransport();
    registry.register('c1', {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: 'sess-1',
    });

    // Detach driver, then add observer (cancels timer)
    registry.detach('c1');
    registry.addObserver('sess-1', obsTransport);
    expect(registry.isActive('c1')).toBe(true);

    // Observer leaves — should restart detach timer
    registry.removeObserver(obsTransport);
    expect(registry.get('c1')!.observers.size).toBe(0);
    expect(registry.isActive('c1')).toBe(true); // still alive

    // Fast-forward past TTL — session should be aborted
    vi.advanceTimersByTime(3_600_001);
    expect(registry.isActive('c1')).toBe(false);

    vi.useRealTimers();
  });

  it('does NOT start detach timer when observer leaves an attached session', () => {
    vi.useFakeTimers();
    const transport = mockTransport();
    const obsTransport = mockTransport();
    registry.register('c1', {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: 'sess-1',
    });

    // Driver is attached, add and remove observer
    registry.addObserver('sess-1', obsTransport);
    registry.removeObserver(obsTransport);

    // Fast-forward past TTL — session should still be alive (driver attached)
    vi.advanceTimersByTime(3_600_001);
    expect(registry.isActive('c1')).toBe(true);

    vi.useRealTimers();
  });
});

describe('broadcastToObservers', () => {
  it('sends to all open observers', () => {
    const obs1 = mockTransport(true);
    const obs2 = mockTransport(true);
    const observers = new Set<SessionTransport>([obs1, obs2]);

    broadcastToObservers(observers, { type: 'test', data: 'hello' });

    expect(obs1._sent).toHaveLength(1);
    expect(obs2._sent).toHaveLength(1);
    expect(obs1._sent[0]).toEqual({
      type: 'test',
      data: 'hello',
    });
  });

  it('skips closed observers', () => {
    const openObs = mockTransport(true);
    const closedObs = mockTransport(false);
    const observers = new Set<SessionTransport>([openObs, closedObs]);

    broadcastToObservers(observers, { type: 'test' });

    expect(openObs._sent).toHaveLength(1);
    expect(closedObs._sent).toHaveLength(0);
  });

  it('does not abort loop when a send throws', () => {
    const goodObs = mockTransport(true);
    const badObs = mockTransport(true);
    // Override send to throw
    badObs.send = () => {
      throw new Error('socket closing');
    };
    const afterBadObs = mockTransport(true);
    const observers = new Set<SessionTransport>([goodObs, badObs, afterBadObs]);

    // Should not throw
    broadcastToObservers(observers, { type: 'test' });

    expect(goodObs._sent).toHaveLength(1);
    expect(afterBadObs._sent).toHaveLength(1);
  });

  it('is a no-op for empty observer set', () => {
    const observers = new Set<SessionTransport>();
    // Should not throw
    broadcastToObservers(observers, { type: 'test' });
  });

  it('passes data objects directly to transport.send()', () => {
    const obs = mockTransport(true);
    const observers = new Set<SessionTransport>([obs]);
    const data = { type: 'raw', value: 42 };
    broadcastToObservers(observers, data);
    expect(obs.send).toHaveBeenCalledWith(data);
  });
});

describe('tryRouteToActiveSession gating', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry();
  });

  afterEach(() => {
    registry.dispose();
  });

  it('findBySessionId returns detached sessions (still routable)', () => {
    const transport = mockTransport();
    registry.register('c1', {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: 'sess-1',
    });

    // Session is attached initially
    expect(registry.isAttached('c1')).toBe(true);

    // Detach it
    registry.detach('c1');
    expect(registry.isAttached('c1')).toBe(false);

    // findBySessionId still finds it — detached sessions remain routable
    const found = registry.findBySessionId('sess-1');
    expect(found).not.toBeNull();
    expect(found!.clientId).toBe('c1');
  });

  it('addObserver succeeds when driver is detached', () => {
    const transport = mockTransport();
    const obsTransport = mockTransport();
    registry.register('c1', {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: 'sess-1',
    });

    registry.detach('c1');

    const result = registry.addObserver('sess-1', obsTransport);
    expect(result).toBe('c1');
    expect(registry.get('c1')!.observers.size).toBe(1);
  });
});

describe('observer broadcast when driver is detached', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry();
  });

  afterEach(() => {
    registry.dispose();
  });

  it('observers still receive broadcasts even when driver is detached', () => {
    const driverTransport = mockTransport();
    const obsTransport = mockTransport();
    registry.register('c1', {
      transport: driverTransport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: 'sess-1',
    });
    registry.addObserver('sess-1', obsTransport);
    registry.detach('c1');

    // Even with driver detached, broadcastToObservers works
    const session = registry.get('c1')!;
    broadcastToObservers(session.observers, { type: 'test' });

    expect(obsTransport._sent).toHaveLength(1);
  });

  it('observer receives broadcast via sendToChat path when driver transport is closed', () => {
    const driverTransport = mockTransport(false); // driver transport is closed
    const obsTransport = mockTransport();
    registry.register('c1', {
      transport: driverTransport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: 'sess-1',
    });
    registry.addObserver('sess-1', obsTransport);
    registry.detach('c1');

    // Simulate the broadcastToObservers call that sendToChat makes
    const echo = { type: 'user_message', content: 'hello from observer' };
    broadcastToObservers(registry.get('c1')!.observers, echo);

    // Observer got it
    expect(obsTransport._sent).toHaveLength(1);
    // Driver transport is closed — send is not called (isOpen() returns false)
    expect(driverTransport._sent).toHaveLength(0);
  });
});

describe('addObserver cancels detach timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adding an observer prevents detach TTL from aborting the session', () => {
    const registry = new SessionRegistry();
    const driverTransport = mockTransport();
    const obsTransport = mockTransport();
    const ac = new AbortController();

    registry.register('c1', {
      transport: driverTransport,
      abortController: ac,
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: 'sess-1',
    });

    registry.detach('c1');
    // Observer joins while driver is detached
    registry.addObserver('sess-1', obsTransport);

    // Fast-forward past the detach TTL
    vi.advanceTimersByTime(4_000_000);

    // Session should still exist — timer was cancelled
    expect(registry.get('c1')).not.toBeNull();
    expect(ac.signal.aborted).toBe(false);

    registry.dispose();
  });
});
