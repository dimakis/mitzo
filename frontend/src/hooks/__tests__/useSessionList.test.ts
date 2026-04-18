// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../../lib/rename-session', () => ({
  renameSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../lib/api-fetch';
import { useSessionList } from '../useSessionList';

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();

  // Default: all fetches succeed with empty data
  vi.mocked(apiFetch).mockImplementation((url: string) => {
    if (url === '/api/sessions')
      return Promise.resolve({ json: () => Promise.resolve([]) }) as Promise<Response>;
    if (url === '/api/config')
      return Promise.resolve({ json: () => Promise.resolve({}) }) as Promise<Response>;
    if (url === '/api/version')
      return Promise.resolve({ json: () => Promise.resolve({}) }) as Promise<Response>;
    return Promise.resolve({ json: () => Promise.resolve({}) }) as Promise<Response>;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useSessionList', () => {
  it('starts in loading state', () => {
    const { result } = renderHook(() => useSessionList());
    expect(result.current.loading).toBe(true);
  });

  it('fetches sessions on mount', async () => {
    const sessions = [{ id: 'abc', summary: 'Test', lastModified: Date.now() }];
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      if (url === '/api/sessions')
        return Promise.resolve({ json: () => Promise.resolve(sessions) }) as Promise<Response>;
      if (url === '/api/config')
        return Promise.resolve({ json: () => Promise.resolve({}) }) as Promise<Response>;
      if (url === '/api/version')
        return Promise.resolve({ json: () => Promise.resolve({}) }) as Promise<Response>;
      return Promise.resolve({ json: () => Promise.resolve({}) }) as Promise<Response>;
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
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      if (url === '/api/sessions')
        return Promise.resolve({ json: () => Promise.resolve(sessions) }) as Promise<Response>;
      if (url === '/api/config')
        return Promise.resolve({ json: () => Promise.resolve({}) }) as Promise<Response>;
      if (url === '/api/version')
        return Promise.resolve({ json: () => Promise.resolve({}) }) as Promise<Response>;
      return Promise.resolve({ json: () => Promise.resolve({}) }) as Promise<Response>;
    });

    const { result } = renderHook(() => useSessionList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.dismissSession('a');
    });

    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0].id).toBe('b');
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/a', { method: 'DELETE' });
  });

  it('clearAll empties sessions and calls DELETE', async () => {
    const sessions = [{ id: 'a', summary: 'A', lastModified: Date.now() }];
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      if (url === '/api/sessions')
        return Promise.resolve({ json: () => Promise.resolve(sessions) }) as Promise<Response>;
      if (url === '/api/config')
        return Promise.resolve({ json: () => Promise.resolve({}) }) as Promise<Response>;
      if (url === '/api/version')
        return Promise.resolve({ json: () => Promise.resolve({}) }) as Promise<Response>;
      return Promise.resolve({ json: () => Promise.resolve({}) }) as Promise<Response>;
    });

    const { result } = renderHook(() => useSessionList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.clearAll();
    });

    expect(result.current.sessions).toHaveLength(0);
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions', { method: 'DELETE' });
  });

  it('handleRename does optimistic update', async () => {
    const sessions = [{ id: 'a', summary: 'Old', lastModified: Date.now() }];
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      if (url === '/api/sessions')
        return Promise.resolve({ json: () => Promise.resolve(sessions) }) as Promise<Response>;
      if (url === '/api/config')
        return Promise.resolve({ json: () => Promise.resolve({}) }) as Promise<Response>;
      if (url === '/api/version')
        return Promise.resolve({ json: () => Promise.resolve({}) }) as Promise<Response>;
      return Promise.resolve({ json: () => Promise.resolve({}) }) as Promise<Response>;
    });

    const { result } = renderHook(() => useSessionList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.handleRename('a', 'New Name');
    });

    expect(result.current.sessions[0].summary).toBe('New Name');
  });

  it('builds quick actions from config', async () => {
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      if (url === '/api/sessions')
        return Promise.resolve({ json: () => Promise.resolve([]) }) as Promise<Response>;
      if (url === '/api/config')
        return Promise.resolve({
          json: () => Promise.resolve({ quickActions: [{ label: 'Test', desc: 'Test action' }] }),
        }) as Promise<Response>;
      if (url === '/api/version')
        return Promise.resolve({ json: () => Promise.resolve({}) }) as Promise<Response>;
      return Promise.resolve({ json: () => Promise.resolve({}) }) as Promise<Response>;
    });

    const { result } = renderHook(() => useSessionList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.quickActions).toHaveLength(3); // Chat + server action + Files
    expect(result.current.quickActions[1].label).toBe('Test');
  });
});
