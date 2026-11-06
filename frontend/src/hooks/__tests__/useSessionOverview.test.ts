// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useSessionOverview, type SessionActivity } from '../useSessionOverview';

const bus = vi.hoisted(() => {
  const events = new Map<string, (data: unknown) => void>();
  let connection: (connected: boolean) => void;
  return {
    connected: false,
    on: vi.fn((event: string, handler: (data: unknown) => void) => {
      events.set(event, handler);
      return vi.fn();
    }),
    onConnectionChange: vi.fn((handler: (connected: boolean) => void) => {
      connection = handler;
      return vi.fn();
    }),
    activity: (data: unknown) => events.get('session_activity')!(data),
    connection: (connected: boolean) => connection(connected),
  };
});
vi.mock('../../lib/event-bus-singleton', () => ({ eventBus: bus }));

beforeEach(() => {
  window.dispatchEvent(new Event('mitzo:auth-restored'));
});
afterEach(cleanup);

function makeActivity(overrides: Partial<SessionActivity> = {}): SessionActivity {
  return {
    sessionId: 'session-1',
    clientId: 'client-1',
    title: 'Test Session',
    state: 'working',
    flags: [],
    lastEventAt: Date.now(),
    ...overrides,
  };
}

describe('useSessionOverview', () => {
  it('starts with empty activities', () => {
    const { result } = renderHook(() => useSessionOverview());
    expect(result.current.activities).toEqual([]);
    expect(result.current.attendCount).toBe(0);
    expect(result.current.connected).toBe(false);
  });

  it('uses one activity and connection subscription for all mounted consumers', () => {
    renderHook(() => useSessionOverview());
    renderHook(() => useSessionOverview());
    expect(bus.on).toHaveBeenCalledExactlyOnceWith('session_activity', expect.any(Function));
    expect(bus.onConnectionChange).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
  });

  it('retains the current phase and clock for consumers mounting after the activity event', () => {
    const activity = makeActivity({ phase: 'command', turnStartedAt: 1000 });
    act(() => {
      bus.connection(true);
      bus.activity([activity]);
    });
    const first = renderHook(() => useSessionOverview());
    expect(first.result.current.activities).toEqual([activity]);
    first.unmount();
    const second = renderHook(() => useSessionOverview());
    expect(second.result.current.activities).toEqual([activity]);
    expect(second.result.current.connected).toBe(true);
  });

  it('keeps other subscribers live when one consumer unmounts', () => {
    const first = renderHook(() => useSessionOverview());
    const second = renderHook(() => useSessionOverview());
    first.unmount();
    const activity = makeActivity();
    act(() => bus.activity([activity]));
    expect(second.result.current.activities).toEqual([activity]);
  });

  it('clears live activity on disconnect, retains display evidence, and waits for fresh hydration', () => {
    const { result } = renderHook(() => useSessionOverview());
    const previous = makeActivity({ state: 'done' });
    act(() => bus.activity([previous]));
    expect(result.current.activities).toEqual([previous]);
    act(() => bus.connection(false));
    expect(result.current.activities).toEqual([]);
    expect(result.current.lastKnownActivities).toEqual([previous]);
    const late = renderHook(() => useSessionOverview());
    expect(late.result.current.activities).toEqual([]);
    expect(late.result.current.lastKnownActivities).toEqual([previous]);
    act(() => bus.connection(true));
    expect(result.current.activities).toEqual([]);
    const current = makeActivity({ state: 'working' });
    act(() => bus.activity([current]));
    expect(result.current.activities).toEqual([current]);
    expect(late.result.current.activities).toEqual([current]);
  });

  it.each(['mitzo:auth-lost', 'mitzo:auth-restored'])(
    'clears the shared evidence at the %s boundary, including for later consumers',
    (event) => {
      act(() => bus.activity([makeActivity()]));
      window.dispatchEvent(new Event(event));
      const { result } = renderHook(() => useSessionOverview());
      expect(result.current.activities).toEqual([]);
      expect(result.current.lastKnownActivities).toEqual([]);
      expect(result.current.connected).toBe(false);
    },
  );

  it('ignores late activity and connection callbacks after authentication is lost', () => {
    window.dispatchEvent(new Event('mitzo:auth-lost'));
    act(() => {
      bus.connection(true);
      bus.activity([makeActivity()]);
    });
    const { result } = renderHook(() => useSessionOverview());
    expect(result.current.activities).toEqual([]);
    expect(result.current.lastKnownActivities).toEqual([]);
    expect(result.current.connected).toBe(false);
  });

  it('updates activities and sorts waiting sessions ahead of working sessions', () => {
    const { result } = renderHook(() => useSessionOverview());
    act(() =>
      bus.activity([
        makeActivity({ sessionId: 's1', state: 'working' }),
        makeActivity({ sessionId: 's2', state: 'waiting', waitReason: 'permission' }),
      ]),
    );
    expect(result.current.activities.map((a) => a.state)).toEqual(['waiting', 'working']);
  });

  it('counts explicit user requests without treating every wait as actionable', () => {
    const { result } = renderHook(() => useSessionOverview());
    act(() =>
      bus.activity([
        makeActivity({ sessionId: 's1', state: 'waiting', waitReason: 'permission' }),
        makeActivity({ sessionId: 's2', state: 'waiting', waitReason: 'review' }),
        makeActivity({ sessionId: 's3', state: 'working' }),
        makeActivity({ sessionId: 's4', state: 'waiting', waitReason: 'blocked' }),
        makeActivity({ sessionId: 's5', state: 'waiting' }),
        makeActivity({
          sessionId: 's6',
          state: 'done',
          awaitingReply: true,
          uncommittedWork: true,
        }),
      ]),
    );
    expect(result.current.attendCount).toBe(2);
  });

  it('sorts by tier then by recency within tier', () => {
    const { result } = renderHook(() => useSessionOverview());
    const now = Date.now();
    act(() =>
      bus.activity([
        makeActivity({ sessionId: 's1', state: 'done', lastEventAt: now - 1000 }),
        makeActivity({ sessionId: 's2', state: 'working', lastEventAt: now }),
        makeActivity({ sessionId: 's3', state: 'done', lastEventAt: now }),
        makeActivity({ sessionId: 's4', state: 'waiting', lastEventAt: now }),
      ]),
    );
    expect(result.current.activities.map((a) => a.sessionId)).toEqual(['s4', 's3', 's1', 's2']);
  });
});
