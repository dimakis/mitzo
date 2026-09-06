// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { SessionActivity } from '@mitzo/protocol';

// Mock the event bus singleton
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockOn: any = vi.fn(() => vi.fn());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockOnConnectionChange: any = vi.fn(() => vi.fn());

vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: {
    on: (...args: unknown[]) => mockOn(...args),
    onConnectionChange: (...args: unknown[]) => mockOnConnectionChange(...args),
    get connected() {
      return true;
    },
  },
}));

import { useSessionFeed } from '../useSessionFeed';

beforeEach(() => {
  mockOn.mockClear();
  mockOnConnectionChange.mockClear();
  localStorage.clear();
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

function fireActivities(activities: SessionActivity[]) {
  // Find the session_activity handler and call it
  const call = mockOn.mock.calls.find((c: unknown[]) => c[0] === 'session_activity');
  if (call) call[1](activities);
}

describe('useSessionFeed', () => {
  it('starts with empty items and needs_me as default filter', () => {
    const { result } = renderHook(() => useSessionFeed());
    expect(result.current.items).toEqual([]);
    expect(result.current.filter).toBe('needs_me');
    expect(result.current.counts).toEqual({
      all: 0,
      needsMe: 0,
      inProgress: 0,
      done: 0,
    });
  });

  it('filters working batch correctly (excludes idle/init/paused)', () => {
    const { result } = renderHook(() => useSessionFeed());

    act(() => {
      fireActivities([
        makeActivity({ sessionId: 's1', state: 'working' }),
        makeActivity({ sessionId: 's2', state: 'idle' }),
        makeActivity({ sessionId: 's3', state: 'init' }),
        makeActivity({ sessionId: 's4', state: 'waiting' }),
      ]);
    });

    // All filter should show working + waiting but not idle or init
    act(() => result.current.setFilter('all'));
    expect(result.current.counts.all).toBe(2);
  });

  it('includes awaiting-reply sessions in working batch regardless of state', () => {
    const { result } = renderHook(() => useSessionFeed());

    act(() => {
      fireActivities([
        makeActivity({
          sessionId: 's1',
          state: 'done',
          awaitingReply: true,
          lastEventAt: Date.now(),
        }),
      ]);
    });

    act(() => result.current.setFilter('all'));
    expect(result.current.counts.all).toBe(1);
  });

  it('excludes old done sessions beyond 48h', () => {
    const { result } = renderHook(() => useSessionFeed());
    const oldTime = Date.now() - 49 * 60 * 60 * 1000; // 49 hours ago

    act(() => {
      fireActivities([
        makeActivity({ sessionId: 's1', state: 'done', lastEventAt: oldTime }),
        makeActivity({ sessionId: 's2', state: 'done', lastEventAt: Date.now() }),
      ]);
    });

    act(() => result.current.setFilter('all'));
    expect(result.current.counts.all).toBe(1);
    expect(result.current.items[0].sessionId).toBe('s2');
  });

  it('needs_me filter shows awaiting reply + waiting + uncommitted', () => {
    const { result } = renderHook(() => useSessionFeed());

    act(() => {
      fireActivities([
        makeActivity({ sessionId: 's1', state: 'working', awaitingReply: true }),
        makeActivity({ sessionId: 's2', state: 'waiting', waitReason: 'permission' }),
        makeActivity({ sessionId: 's3', state: 'working', uncommittedWork: true }),
        makeActivity({ sessionId: 's4', state: 'working' }), // doesn't need me
      ]);
    });

    // Default is needs_me
    expect(result.current.filter).toBe('needs_me');
    expect(result.current.items).toHaveLength(3);
    expect(result.current.counts.needsMe).toBe(3);
  });

  it('in_progress filter shows only working sessions', () => {
    const { result } = renderHook(() => useSessionFeed());

    act(() => {
      fireActivities([
        makeActivity({ sessionId: 's1', state: 'working' }),
        makeActivity({ sessionId: 's2', state: 'waiting' }),
        makeActivity({ sessionId: 's3', state: 'done', lastEventAt: Date.now() }),
      ]);
    });

    act(() => result.current.setFilter('in_progress'));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].sessionId).toBe('s1');
  });

  it('done filter shows only done sessions', () => {
    const { result } = renderHook(() => useSessionFeed());

    act(() => {
      fireActivities([
        makeActivity({ sessionId: 's1', state: 'working' }),
        makeActivity({ sessionId: 's2', state: 'done', lastEventAt: Date.now() }),
      ]);
    });

    act(() => result.current.setFilter('done'));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].sessionId).toBe('s2');
  });

  it('sorts oldest first (longest waiting gets attention first)', () => {
    const { result } = renderHook(() => useSessionFeed());
    const now = Date.now();

    act(() => {
      fireActivities([
        makeActivity({ sessionId: 's-new', state: 'working', lastEventAt: now }),
        makeActivity({ sessionId: 's-old', state: 'working', lastEventAt: now - 60000 }),
        makeActivity({ sessionId: 's-mid', state: 'working', lastEventAt: now - 30000 }),
      ]);
    });

    act(() => result.current.setFilter('all'));
    const ids = result.current.items.map((a) => a.sessionId);
    expect(ids).toEqual(['s-old', 's-mid', 's-new']);
  });

  it('persists filter to localStorage', () => {
    const { result } = renderHook(() => useSessionFeed());

    act(() => result.current.setFilter('done'));
    expect(localStorage.getItem('mitzo:feedFilter')).toBe('done');
  });

  it('restores filter from localStorage', () => {
    localStorage.setItem('mitzo:feedFilter', 'in_progress');
    const { result } = renderHook(() => useSessionFeed());
    expect(result.current.filter).toBe('in_progress');
  });

  it('falls back to needs_me for invalid localStorage value', () => {
    localStorage.setItem('mitzo:feedFilter', 'bogus');
    const { result } = renderHook(() => useSessionFeed());
    expect(result.current.filter).toBe('needs_me');
  });
});
