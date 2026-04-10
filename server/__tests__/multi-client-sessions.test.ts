import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionRegistry } from '../session-registry.js';
import { broadcastToObservers } from '../query-loop.js';
import { MAX_OBSERVERS_PER_SESSION } from '../constants.js';

function mockWs(open = true) {
  return {
    readyState: open ? 1 : 3,
    OPEN: 1,
    send: (() => {
      const fn = function (this: unknown, _data: string) {
        fn.calls.push(_data);
      };
      fn.calls = [] as string[];
      return fn;
    })(),
  } as unknown as import('ws').WebSocket;
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
    const ws = mockWs();
    const obsWs = mockWs();
    registry.register('c1', {
      ws,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: 'sess-1',
    });

    const result = registry.addObserver('sess-1', obsWs);
    expect(result).toBe('c1');
    expect(registry.get('c1')!.observers.size).toBe(1);
  });

  it('is idempotent — same ws added twice does not increase count', () => {
    const ws = mockWs();
    const obsWs = mockWs();
    registry.register('c1', {
      ws,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: 'sess-1',
    });

    registry.addObserver('sess-1', obsWs);
    registry.addObserver('sess-1', obsWs);
    expect(registry.get('c1')!.observers.size).toBe(1);
  });

  it('caps observers at MAX_OBSERVERS_PER_SESSION', () => {
    const ws = mockWs();
    registry.register('c1', {
      ws,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: 'sess-1',
    });

    for (let i = 0; i < MAX_OBSERVERS_PER_SESSION; i++) {
      const result = registry.addObserver('sess-1', mockWs());
      expect(result).toBe('c1');
    }

    // One more should be rejected
    const overflow = registry.addObserver('sess-1', mockWs());
    expect(overflow).toBeNull();
    expect(registry.get('c1')!.observers.size).toBe(MAX_OBSERVERS_PER_SESSION);
  });

  it('returns null for unknown sessionId', () => {
    const result = registry.addObserver('nonexistent', mockWs());
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
    const ws = mockWs();
    const obsWs = mockWs();
    registry.register('c1', {
      ws,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: 'sess-1',
    });
    registry.addObserver('sess-1', obsWs);
    expect(registry.get('c1')!.observers.size).toBe(1);

    registry.removeObserver(obsWs);
    expect(registry.get('c1')!.observers.size).toBe(0);
  });

  it('is a no-op when ws is not an observer', () => {
    const ws = mockWs();
    registry.register('c1', {
      ws,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: 'sess-1',
    });

    // Should not throw
    registry.removeObserver(mockWs());
    expect(registry.get('c1')!.observers.size).toBe(0);
  });
});

describe('broadcastToObservers', () => {
  it('sends to all open observers', () => {
    const obs1 = mockWs(true);
    const obs2 = mockWs(true);
    const observers = new Set([obs1, obs2]);

    broadcastToObservers(observers, { type: 'test', data: 'hello' });

    expect((obs1.send as unknown as { calls: string[] }).calls).toHaveLength(1);
    expect((obs2.send as unknown as { calls: string[] }).calls).toHaveLength(1);
    expect(JSON.parse((obs1.send as unknown as { calls: string[] }).calls[0])).toEqual({
      type: 'test',
      data: 'hello',
    });
  });

  it('skips closed observers', () => {
    const openObs = mockWs(true);
    const closedObs = mockWs(false);
    const observers = new Set([openObs, closedObs]);

    broadcastToObservers(observers, { type: 'test' });

    expect((openObs.send as unknown as { calls: string[] }).calls).toHaveLength(1);
    expect((closedObs.send as unknown as { calls: string[] }).calls).toHaveLength(0);
  });

  it('does not abort loop when a send throws', () => {
    const goodObs = mockWs(true);
    const badObs = mockWs(true);
    // Override send to throw
    badObs.send = () => {
      throw new Error('socket closing');
    };
    const afterBadObs = mockWs(true);
    const observers = new Set([goodObs, badObs, afterBadObs]);

    // Should not throw
    broadcastToObservers(observers, { type: 'test' });

    expect((goodObs.send as unknown as { calls: string[] }).calls).toHaveLength(1);
    expect((afterBadObs.send as unknown as { calls: string[] }).calls).toHaveLength(1);
  });

  it('is a no-op for empty observer set', () => {
    const observers = new Set<import('ws').WebSocket>();
    // Should not throw
    broadcastToObservers(observers, { type: 'test' });
  });

  it('accepts a pre-serialized string', () => {
    const obs = mockWs(true);
    const observers = new Set([obs]);
    broadcastToObservers(observers, '{"type":"raw"}');
    expect((obs.send as unknown as { calls: string[] }).calls[0]).toBe('{"type":"raw"}');
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

  it('findBySessionId returns detached sessions but isAttached filters them', () => {
    const ws = mockWs();
    registry.register('c1', {
      ws,
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

    // findBySessionId still finds it
    const found = registry.findBySessionId('sess-1');
    expect(found).not.toBeNull();
    expect(found!.clientId).toBe('c1');

    // But isAttached returns false — tryRouteToActiveSession should bail
    expect(registry.isAttached(found!.clientId)).toBe(false);
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
    const driverWs = mockWs();
    const obsWs = mockWs();
    registry.register('c1', {
      ws: driverWs,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: 'sess-1',
    });
    registry.addObserver('sess-1', obsWs);
    registry.detach('c1');

    // Even with driver detached, broadcastToObservers works
    const session = registry.get('c1')!;
    broadcastToObservers(session.observers, { type: 'test' });

    expect((obsWs.send as unknown as { calls: string[] }).calls).toHaveLength(1);
  });
});
