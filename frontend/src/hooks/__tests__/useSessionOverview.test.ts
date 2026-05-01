// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the event bus singleton
const mockOn = vi.fn(() => vi.fn()); // returns unsubscribe
const mockOnConnectionChange = vi.fn(() => vi.fn());
const mockConnected = false;

vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: {
    on: (...args: unknown[]) => mockOn(...args),
    onConnectionChange: (...args: unknown[]) => mockOnConnectionChange(...args),
    get connected() {
      return mockConnected;
    },
  },
}));

import { useSessionOverview, type SessionActivity } from '../useSessionOverview';

beforeEach(() => {
  mockOn.mockClear();
  mockOnConnectionChange.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

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
  });

  it('subscribes to session_activity events on mount', () => {
    renderHook(() => useSessionOverview());
    expect(mockOn).toHaveBeenCalledWith('session_activity', expect.any(Function));
  });

  it('subscribes to connection changes', () => {
    renderHook(() => useSessionOverview());
    expect(mockOnConnectionChange).toHaveBeenCalledWith(expect.any(Function));
  });

  it('unsubscribes on unmount', () => {
    const unsubActivity = vi.fn();
    const unsubConnection = vi.fn();
    mockOn.mockReturnValue(unsubActivity);
    mockOnConnectionChange.mockReturnValue(unsubConnection);

    const { unmount } = renderHook(() => useSessionOverview());
    unmount();

    expect(unsubActivity).toHaveBeenCalled();
    expect(unsubConnection).toHaveBeenCalled();
  });

  it('updates activities when session_activity event fires', () => {
    let activityHandler: ((data: unknown) => void) | null = null;
    mockOn.mockImplementation((_event: string, handler: (data: unknown) => void) => {
      activityHandler = handler;
      return vi.fn();
    });

    const { result } = renderHook(() => useSessionOverview());

    const activities = [
      makeActivity({ sessionId: 's1', state: 'working' }),
      makeActivity({ sessionId: 's2', state: 'waiting', waitReason: 'permission' }),
    ];

    act(() => {
      activityHandler!(activities);
    });

    expect(result.current.activities).toHaveLength(2);
    // Waiting (tier 1) should sort before working (tier 3)
    expect(result.current.activities[0].state).toBe('waiting');
    expect(result.current.activities[1].state).toBe('working');
  });

  it('computes attendCount from waiting sessions', () => {
    let activityHandler: ((data: unknown) => void) | null = null;
    mockOn.mockImplementation((_event: string, handler: (data: unknown) => void) => {
      activityHandler = handler;
      return vi.fn();
    });

    const { result } = renderHook(() => useSessionOverview());

    act(() => {
      activityHandler!([
        makeActivity({ sessionId: 's1', state: 'waiting' }),
        makeActivity({ sessionId: 's2', state: 'waiting' }),
        makeActivity({ sessionId: 's3', state: 'working' }),
      ]);
    });

    expect(result.current.attendCount).toBe(2);
  });

  it('sorts by tier then by recency within tier', () => {
    let activityHandler: ((data: unknown) => void) | null = null;
    mockOn.mockImplementation((_event: string, handler: (data: unknown) => void) => {
      activityHandler = handler;
      return vi.fn();
    });

    const { result } = renderHook(() => useSessionOverview());

    const now = Date.now();
    act(() => {
      activityHandler!([
        makeActivity({ sessionId: 's1', state: 'done', lastEventAt: now - 1000 }),
        makeActivity({ sessionId: 's2', state: 'working', lastEventAt: now }),
        makeActivity({ sessionId: 's3', state: 'done', lastEventAt: now }),
        makeActivity({ sessionId: 's4', state: 'waiting', lastEventAt: now }),
      ]);
    });

    const ids = result.current.activities.map((a) => a.sessionId);
    // Tier 1 (waiting) → Tier 2 (done, newest first) → Tier 3 (working)
    expect(ids).toEqual(['s4', 's3', 's1', 's2']);
  });
});
