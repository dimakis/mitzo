// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../lib/api-fetch';
import { useTodoData } from '../useTodoData';

const mockItems = [
  {
    id: 'abc123',
    summary: '[dimakis/mitzo#1] Fix bug',
    profile: 'centaur',
    urgency: 0.5,
    starred: false,
    status: 'active' as const,
    ageDays: 3,
    parentId: null,
    children: [],
    childCount: 0,
    completedChildCount: 0,
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
  vi.clearAllMocks();
  vi.mocked(apiFetch).mockResolvedValue({
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
    expect(apiFetch).toHaveBeenCalledWith('/api/todos');
  });

  it('fetches with profile filter', async () => {
    const { result } = renderHook(() => useTodoData('centaur'));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(apiFetch).toHaveBeenCalledWith('/api/todos?profile=centaur');
  });

  it('handles fetch errors gracefully', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.items).toEqual([]);
    expect(result.current.profiles).toEqual([]);
  });

  it('performs action and removes item from list', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    await act(async () => {
      await result.current.ack('abc123');
    });

    expect(result.current.items).toHaveLength(0);
    expect(apiFetch).toHaveBeenCalledWith('/api/todos/abc123/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ack' }),
    });
  });

  it('performs done action', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.mocked(apiFetch).mockResolvedValueOnce({
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

    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    await act(async () => {
      await result.current.snooze('abc123', 5);
    });

    expect(result.current.items).toHaveLength(0);
    expect(apiFetch).toHaveBeenCalledWith('/api/todos/abc123/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'snooze', days: 5 }),
    });
  });

  it('refresh triggers a re-fetch', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(apiFetch).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('handles network error in performAction gracefully', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('Network error'));

    await act(async () => {
      await result.current.ack('abc123');
    });

    // Item should still be in the list since action failed
    expect(result.current.items).toHaveLength(1);
  });

  it('create posts to /api/todos and triggers refresh', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(apiFetch).toHaveBeenCalledTimes(1);

    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    await act(async () => {
      await result.current.create('New task', 'work');
    });

    expect(apiFetch).toHaveBeenCalledWith('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 'New task', profile: 'work' }),
    });
  });

  it('create passes parentId when provided', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    await act(async () => {
      await result.current.create('Sub task', 'work', 'parent-123');
    });

    expect(apiFetch).toHaveBeenCalledWith('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 'Sub task', profile: 'work', parentId: 'parent-123' }),
    });
  });

  it('create handles network error gracefully', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('Network error'));

    await act(async () => {
      await result.current.create('New task', 'work');
    });

    // Should not throw — items unchanged
    expect(result.current.items).toHaveLength(1);
  });

  it('star optimistically toggles starred state', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items[0].starred).toBe(false);

    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    await act(async () => {
      await result.current.star('abc123');
    });

    // Optimistic toggle: starred should now be true
    expect(result.current.items[0].starred).toBe(true);
  });

  it('star sends correct action based on current state', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    // First star: item is unstarred, so action should be 'star'
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    await act(async () => {
      await result.current.star('abc123');
    });

    expect(apiFetch).toHaveBeenCalledWith('/api/todos/abc123/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'star' }),
    });

    // Second star: item is now starred, so action should be 'unstar'
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    await act(async () => {
      await result.current.star('abc123');
    });

    expect(apiFetch).toHaveBeenCalledWith('/api/todos/abc123/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'unstar' }),
    });
  });

  it('star handles network error gracefully — optimistic update persists', async () => {
    const { result } = renderHook(() => useTodoData());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items[0].starred).toBe(false);

    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('Network error'));

    await act(async () => {
      await result.current.star('abc123');
    });

    // Optimistic toggle persists despite network error
    expect(result.current.items[0].starred).toBe(true);
  });
});
