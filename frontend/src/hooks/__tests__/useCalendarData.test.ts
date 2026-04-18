// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../lib/api-fetch';
import { useCalendarData } from '../useCalendarData';

const MOCK_DATA = {
  startDate: '2026-04-10',
  endDate: '2026-04-16',
  events: [
    {
      id: 'evt-1',
      type: 'meeting',
      title: 'Standup',
      start: '2026-04-10T10:00:00Z',
      end: '2026-04-10T10:30:00Z',
      allDay: false,
      attendees: ['alice@example.com'],
      attendeeCount: 2,
    },
    {
      id: 'milestone-3.4-cf',
      type: 'milestone',
      title: '3.4 Code Freeze',
      start: '2026-04-10',
      end: '2026-04-10',
      allDay: true,
      version: '3.4',
      milestone: 'cf',
      label: 'Code Freeze',
      daysAway: 0,
      ourFeatures: 24,
      totalFeatures: 66,
    },
  ],
  sprints: [
    {
      id: 'sprint-8',
      type: 'sprint',
      title: 'Sprint 2026-08',
      start: '2026-04-14',
      end: '2026-04-27',
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(MOCK_DATA),
  } as Response);
});

afterEach(() => {
  cleanup();
});

describe('useCalendarData', () => {
  it('fetches calendar data on mount', async () => {
    const { result } = renderHook(() => useCalendarData('2026-04-10'));

    expect(result.current.loading).toBe(true);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.events).toHaveLength(2);
    expect(result.current.sprints).toHaveLength(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/calendar?date=2026-04-10&days=7');
  });

  it('passes days parameter to API', async () => {
    const { result } = renderHook(() => useCalendarData('2026-04-10', 3));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(apiFetch).toHaveBeenCalledWith('/api/calendar?date=2026-04-10&days=3');
    expect(result.current.events).toHaveLength(2);
  });

  it('refetches when date changes', async () => {
    const { rerender } = renderHook(({ date }) => useCalendarData(date), {
      initialProps: { date: '2026-04-10' },
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);

    rerender({ date: '2026-04-11' });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch).toHaveBeenLastCalledWith('/api/calendar?date=2026-04-11&days=7');
  });

  it('handles non-ok HTTP responses as errors', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Unauthorized' }),
    } as Response);

    const { result } = renderHook(() => useCalendarData('2026-04-10'));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.events).toEqual([]);
    expect(result.current.sprints).toEqual([]);
  });

  it('handles fetch errors gracefully', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useCalendarData('2026-04-10'));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.events).toEqual([]);
    expect(result.current.sprints).toEqual([]);
  });

  it('separates events by type', async () => {
    const { result } = renderHook(() => useCalendarData('2026-04-10'));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.meetings).toHaveLength(1);
    expect(result.current.milestones).toHaveLength(1);
    expect(result.current.meetings[0].type).toBe('meeting');
    expect(result.current.milestones[0].type).toBe('milestone');
  });
});
