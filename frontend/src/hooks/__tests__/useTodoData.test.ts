// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useTodoData } from '../useTodoData';

const mockItems = [
  {
    id: 'abc123',
    summary: '[dimakis/mitzo#1] Fix bug',
    profile: 'centaur',
    urgency: 0.5,
    status: 'active' as const,
    ageDays: 3,
    sources: [
      {
        type: 'github',
        url: 'https://github.com/dimakis/mitzo/issues/1',
        title: 'Fix bug',
        author: 'dimakis',
        snippet: '',
      },
    ],
    contextHints: {
      repos: ['dimakis/mitzo'],
      paths: [],
      issues: ['dimakis/mitzo#1'],
      docIds: [],
      people: [],
      jiraKeys: [],
      keywords: [],
      taskHint: 'Fix bug',
    },
  },
];

const mockResponse = {
  profiles: ['centaur', 'work', 'personal'],
  items: mockItems,
};

beforeEach(() => {
  vi.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(mockResponse),
  } as Response);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useTodoData', () => {
  it('fetches todo items on mount', async () => {
    const { result } = renderHook(() => useTodoData());

    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.items).toHaveLength(1);
    expect(result.current.profiles).toEqual(['centaur', 'work', 'personal']);
    expect(fetch).toHaveBeenCalledWith('/api/todos');
  });

  it('fetches with profile filter', async () => {
    const { result } = renderHook(() => useTodoData('centaur'));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetch).toHaveBeenCalledWith('/api/todos?profile=centaur');
  });

  it('handles fetch errors gracefully', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.items).toEqual([]);
    expect(result.current.profiles).toEqual([]);
  });

  it('performs action and removes item from list', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    await act(async () => {
      await result.current.ack('abc123');
    });

    expect(result.current.items).toHaveLength(0);
    expect(fetch).toHaveBeenCalledWith('/api/todos/abc123/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ack' }),
    });
  });

  it('performs done action', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    await act(async () => {
      await result.current.done('abc123');
    });

    expect(result.current.items).toHaveLength(0);
  });

  it('performs snooze action with days parameter', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    await act(async () => {
      await result.current.snooze('abc123', 5);
    });

    expect(result.current.items).toHaveLength(0);
    expect(fetch).toHaveBeenCalledWith('/api/todos/abc123/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'snooze', days: 5 }),
    });
  });

  it('refresh triggers a re-fetch', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetch).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('handles network error in performAction gracefully', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network error'));

    await act(async () => {
      await result.current.ack('abc123');
    });

    // Item should still be in the list since action failed
    expect(result.current.items).toHaveLength(1);
  });
});
