// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../lib/api-fetch';
import { useSessionSearch } from '../useSessionSearch';

function mockSearchResponse(results: unknown[] = []) {
  vi.mocked(apiFetch).mockResolvedValue({
    json: () => Promise.resolve({ results }),
  } as Response);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(apiFetch).mockReset();
  mockSearchResponse();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useSessionSearch', () => {
  it('starts with empty state', () => {
    const { result } = renderHook(() => useSessionSearch());
    expect(result.current.query).toBe('');
    expect(result.current.results).toEqual([]);
    expect(result.current.searching).toBe(false);
    expect(result.current.active).toBe(false);
  });

  it('updates query immediately on setQuery', () => {
    const { result } = renderHook(() => useSessionSearch());
    act(() => result.current.setQuery('auth'));
    expect(result.current.query).toBe('auth');
    expect(result.current.active).toBe(true);
  });

  it('debounces API call by 300ms', () => {
    const { result } = renderHook(() => useSessionSearch());
    act(() => result.current.setQuery('test'));

    // Not called yet — still within debounce window
    expect(apiFetch).not.toHaveBeenCalled();

    // Advance past debounce
    act(() => vi.advanceTimersByTime(300));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/sessions/search?q=test',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('resets debounce on rapid input', () => {
    const { result } = renderHook(() => useSessionSearch());

    act(() => result.current.setQuery('a'));
    act(() => vi.advanceTimersByTime(200));
    act(() => result.current.setQuery('ab'));
    act(() => vi.advanceTimersByTime(200));
    act(() => result.current.setQuery('abc'));
    act(() => vi.advanceTimersByTime(300));

    // Only the final query should have triggered a fetch
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/search?q=abc', expect.any(Object));
  });

  it('sets searching=true while request is in-flight', async () => {
    // Use real timers for async resolution, manually control debounce
    vi.useRealTimers();

    let resolveJson!: (v: unknown) => void;
    vi.mocked(apiFetch).mockReturnValue(
      Promise.resolve({
        json: () =>
          new Promise((r) => {
            resolveJson = r;
          }),
      } as Response),
    );

    const { result } = renderHook(() => useSessionSearch());
    act(() => result.current.setQuery('test'));

    // Wait for debounce (real 300ms)
    await act(async () => new Promise((r) => setTimeout(r, 350)));

    expect(result.current.searching).toBe(true);

    await act(async () => resolveJson({ results: [] }));
    expect(result.current.searching).toBe(false);

    vi.useFakeTimers();
  });

  it('populates results from API response', async () => {
    const mockResults = [
      { sessionId: 'abc', summary: 'Test', snippet: '...match...', matchedAt: 1, updatedAt: 1 },
    ];
    mockSearchResponse(mockResults);

    const { result } = renderHook(() => useSessionSearch());
    act(() => result.current.setQuery('match'));
    await act(async () => vi.advanceTimersByTime(300));

    expect(result.current.results).toEqual(mockResults);
  });

  it('does not fetch for whitespace-only query', () => {
    const { result } = renderHook(() => useSessionSearch());
    act(() => result.current.setQuery('   '));
    act(() => vi.advanceTimersByTime(300));

    expect(apiFetch).not.toHaveBeenCalled();
    expect(result.current.active).toBe(false);
  });

  it('aborts previous request when new query fires', () => {
    const abortSpy = vi.fn();
    vi.mocked(apiFetch).mockImplementation((_url, opts) => {
      const signal = (opts as RequestInit).signal!;
      signal.addEventListener('abort', abortSpy);
      return new Promise(() => {}); // never resolves
    });

    const { result } = renderHook(() => useSessionSearch());
    act(() => result.current.setQuery('first'));
    act(() => vi.advanceTimersByTime(300));

    act(() => result.current.setQuery('second'));
    act(() => vi.advanceTimersByTime(300));

    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  it('clear resets all state', async () => {
    const mockResults = [
      { sessionId: 'x', summary: 'X', snippet: '...', matchedAt: 1, updatedAt: 1 },
    ];
    mockSearchResponse(mockResults);

    const { result } = renderHook(() => useSessionSearch());
    act(() => result.current.setQuery('test'));
    await act(async () => vi.advanceTimersByTime(300));

    expect(result.current.results).toHaveLength(1);

    act(() => result.current.clear());

    expect(result.current.query).toBe('');
    expect(result.current.results).toEqual([]);
    expect(result.current.searching).toBe(false);
    expect(result.current.active).toBe(false);
  });

  it('cleans up timer and abort on unmount', () => {
    const abortSpy = vi.fn();
    vi.mocked(apiFetch).mockImplementation((_url, opts) => {
      const signal = (opts as RequestInit).signal!;
      signal.addEventListener('abort', abortSpy);
      return new Promise(() => {});
    });

    const { result, unmount } = renderHook(() => useSessionSearch());
    act(() => result.current.setQuery('test'));
    act(() => vi.advanceTimersByTime(300));

    unmount();
    expect(abortSpy).toHaveBeenCalled();
  });
});
