// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

const mockWsSubscribe = vi.fn().mockReturnValue(vi.fn());

vi.mock('../../lib/ws-pool', () => ({
  wsSubscribe: (...args: unknown[]) => mockWsSubscribe(...args),
}));

import { useTabBadges } from '../useTabBadges';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url === '/api/inbox') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ id: '1' }]) });
      }
      if (url === '/api/todos') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ items: [{ id: 'a' }, { id: 'b' }] }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useTabBadges', () => {
  it('fetches inbox and todo counts on mount', async () => {
    const { result } = renderHook(() => useTabBadges());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.inboxCount).toBe(1);
    expect(result.current.todoCount).toBe(2);
  });

  it('returns 0 when APIs fail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network'))),
    );

    const { result } = renderHook(() => useTabBadges());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.inboxCount).toBe(0);
    expect(result.current.todoCount).toBe(0);
  });
});
