// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

let changeHandler: ((e: { matches: boolean }) => void) | null = null;
let currentMatches = false;

beforeEach(() => {
  changeHandler = null;
  currentMatches = false;
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: currentMatches,
      media: query,
      addEventListener: (_event: string, handler: (e: { matches: boolean }) => void) => {
        changeHandler = handler;
      },
      removeEventListener: vi.fn(),
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Import after mocks are set up
const load = async () => import('../useMediaQuery');

describe('useMediaQuery', () => {
  it('returns false when query does not match', async () => {
    currentMatches = false;
    const { useMediaQuery } = await load();
    const { result } = renderHook(() => useMediaQuery('(min-width: 768px)'));
    expect(result.current).toBe(false);
  });

  it('returns true when query matches', async () => {
    currentMatches = true;
    const { useMediaQuery } = await load();
    const { result } = renderHook(() => useMediaQuery('(min-width: 768px)'));
    expect(result.current).toBe(true);
  });

  it('updates when media query changes', async () => {
    currentMatches = false;
    const { useMediaQuery } = await load();
    const { result } = renderHook(() => useMediaQuery('(min-width: 768px)'));
    expect(result.current).toBe(false);

    act(() => {
      changeHandler?.({ matches: true });
    });
    expect(result.current).toBe(true);

    act(() => {
      changeHandler?.({ matches: false });
    });
    expect(result.current).toBe(false);
  });

  it('cleans up listener on unmount', async () => {
    const removeListener = vi.fn();
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: (_event: string, handler: (e: { matches: boolean }) => void) => {
          changeHandler = handler;
        },
        removeEventListener: removeListener,
      })),
    );

    const { useMediaQuery } = await load();
    const { unmount } = renderHook(() => useMediaQuery('(min-width: 768px)'));
    unmount();
    expect(removeListener).toHaveBeenCalledWith('change', expect.any(Function));
  });
});

describe('useIsDesktop', () => {
  it('returns result of min-width 768px query', async () => {
    currentMatches = true;
    const { useIsDesktop } = await load();
    const { result } = renderHook(() => useIsDesktop());
    expect(result.current).toBe(true);
  });
});
