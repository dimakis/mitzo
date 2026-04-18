// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../../lib/rename-session', () => ({
  renameSession: vi.fn().mockResolvedValue(undefined),
}));

import { useSessionList } from '../useSessionList';

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);

  // Default: all fetches succeed with empty data
  mockFetch.mockImplementation((url: string) => {
    if (url === '/api/sessions') return Promise.resolve({ json: () => Promise.resolve([]) });
    if (url === '/api/config') return Promise.resolve({ json: () => Promise.resolve({}) });
    if (url === '/api/version') return Promise.resolve({ json: () => Promise.resolve({}) });
    return Promise.resolve({ json: () => Promise.resolve({}) });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSessionList', () => {
  it('starts in loading state', () => {
    const { result } = renderHook(() => useSessionList());
    expect(result.current.loading).toBe(true);
  });

  it('fetches sessions on mount', async () => {
    const sessions = [{ id: 'abc', summary: 'Test', lastModified: Date.now() }];
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/sessions')
        return Promise.resolve({ json: () => Promise.resolve(sessions) });
      if (url === '/api/config') return Promise.resolve({ json: () => Promise.resolve({}) });
      if (url === '/api/version') return Promise.resolve({ json: () => Promise.resolve({}) });
      return Promise.resolve({ json: () => Promise.resolve({}) });
    });

    const { result } = renderHook(() => useSessionList());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.sessions).toEqual(sessions);
  });

  it('dismissSession removes from list and calls DELETE', async () => {
    const sessions = [
      { id: 'a', summary: 'A', lastModified: Date.now() },
      { id: 'b', summary: 'B', lastModified: Date.now() },
    ];
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/sessions')
        return Promise.resolve({ json: () => Promise.resolve(sessions) });
      if (url === '/api/config') return Promise.resolve({ json: () => Promise.resolve({}) });
      if (url === '/api/version') return Promise.resolve({ json: () => Promise.resolve({}) });
      return Promise.resolve({ json: () => Promise.resolve({}) });
    });

    const { result } = renderHook(() => useSessionList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.dismissSession('a');
    });

    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0].id).toBe('b');
    expect(mockFetch).toHaveBeenCalledWith('/api/sessions/a', { method: 'DELETE' });
  });

  it('clearAll empties sessions and calls DELETE', async () => {
    const sessions = [{ id: 'a', summary: 'A', lastModified: Date.now() }];
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/sessions')
        return Promise.resolve({ json: () => Promise.resolve(sessions) });
      if (url === '/api/config') return Promise.resolve({ json: () => Promise.resolve({}) });
      if (url === '/api/version') return Promise.resolve({ json: () => Promise.resolve({}) });
      return Promise.resolve({ json: () => Promise.resolve({}) });
    });

    const { result } = renderHook(() => useSessionList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.clearAll();
    });

    expect(result.current.sessions).toHaveLength(0);
    expect(mockFetch).toHaveBeenCalledWith('/api/sessions', { method: 'DELETE' });
  });

  it('handleRename does optimistic update', async () => {
    const sessions = [{ id: 'a', summary: 'Old', lastModified: Date.now() }];
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/sessions')
        return Promise.resolve({ json: () => Promise.resolve(sessions) });
      if (url === '/api/config') return Promise.resolve({ json: () => Promise.resolve({}) });
      if (url === '/api/version') return Promise.resolve({ json: () => Promise.resolve({}) });
      return Promise.resolve({ json: () => Promise.resolve({}) });
    });

    const { result } = renderHook(() => useSessionList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.handleRename('a', 'New Name');
    });

    expect(result.current.sessions[0].summary).toBe('New Name');
  });

  it('builds quick actions from config', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/sessions') return Promise.resolve({ json: () => Promise.resolve([]) });
      if (url === '/api/config')
        return Promise.resolve({
          json: () => Promise.resolve({ quickActions: [{ label: 'Test', desc: 'Test action' }] }),
        });
      if (url === '/api/version') return Promise.resolve({ json: () => Promise.resolve({}) });
      return Promise.resolve({ json: () => Promise.resolve({}) });
    });

    const { result } = renderHook(() => useSessionList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.quickActions).toHaveLength(3); // Chat + server action + Files
    expect(result.current.quickActions[1].label).toBe('Test');
  });
});
