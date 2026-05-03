// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useServiceHealth } from '../useServiceHealth';

// Capture the listener registered via eventBus.on('health', ...)
let healthListener: ((data: unknown) => void) | null = null;
const mockUnsub = vi.fn();

vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: {
    on: vi.fn((event: string, listener: (data: unknown) => void) => {
      if (event === 'health') healthListener = listener;
      return mockUnsub;
    }),
    onConnectionChange: vi.fn(() => vi.fn()),
    connected: false,
  },
}));

describe('useServiceHealth', () => {
  beforeEach(() => {
    healthListener = null;
    mockUnsub.mockClear();
  });

  it('starts with empty services and checkedAt=0', () => {
    const { result } = renderHook(() => useServiceHealth());
    expect(result.current.services).toEqual([]);
    expect(result.current.yapper).toBeNull();
    expect(result.current.contexgin).toBeNull();
    expect(result.current.checkedAt).toBe(0);
  });

  it('subscribes to health event on mount', () => {
    renderHook(() => useServiceHealth());
    expect(healthListener).not.toBeNull();
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useServiceHealth());
    unmount();
    expect(mockUnsub).toHaveBeenCalled();
  });

  it('updates state when health event fires', () => {
    const { result } = renderHook(() => useServiceHealth());

    act(() => {
      healthListener?.({
        services: [
          { name: 'yapper', ok: true, detail: { stt: true, tts: true } },
          { name: 'contexgin', ok: false },
        ],
        checkedAt: 1234567890,
      });
    });

    expect(result.current.services).toHaveLength(2);
    expect(result.current.yapper).toEqual({
      name: 'yapper',
      ok: true,
      detail: { stt: true, tts: true },
    });
    expect(result.current.contexgin).toEqual({ name: 'contexgin', ok: false });
    expect(result.current.checkedAt).toBe(1234567890);
  });

  it('returns null for unknown service names', () => {
    const { result } = renderHook(() => useServiceHealth());

    act(() => {
      healthListener?.({
        services: [{ name: 'unknown-service', ok: true }],
        checkedAt: 1000,
      });
    });

    expect(result.current.yapper).toBeNull();
    expect(result.current.contexgin).toBeNull();
  });

  it('updates when payload changes', () => {
    const { result } = renderHook(() => useServiceHealth());

    act(() => {
      healthListener?.({
        services: [{ name: 'yapper', ok: true }],
        checkedAt: 1000,
      });
    });
    expect(result.current.yapper?.ok).toBe(true);

    act(() => {
      healthListener?.({
        services: [{ name: 'yapper', ok: false }],
        checkedAt: 2000,
      });
    });
    expect(result.current.yapper?.ok).toBe(false);
    expect(result.current.checkedAt).toBe(2000);
  });
});
