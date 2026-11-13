// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSessionOrdering } from '../useSessionOrder';
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it('keeps successive promotions five seconds apart while updating metadata immediately', () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const rows = [
    { id: 'a', summary: 'A', lastModified: 300 },
    { id: 'b', summary: 'B', lastModified: 200 },
    { id: 'c', summary: 'C', lastModified: 100 },
  ];
  const view = renderHook(({ sessions }) => useSessionOrdering(sessions, [], false), {
    initialProps: { sessions: rows },
  });
  view.rerender({
    sessions: rows.map((s) => ({
      ...s,
      lastModified: s.id === 'b' ? 500 : s.id === 'c' ? 600 : s.lastModified,
    })),
  });
  act(() => vi.advanceTimersByTime(600));
  expect(view.result.current.sessions[0].id).toBe('c');
  act(() => vi.advanceTimersByTime(4999));
  expect(view.result.current.sessions[0].id).toBe('c');
  expect(view.result.current.pendingCount).toBe(1);
  act(() => vi.advanceTimersByTime(1));
  expect(view.result.current.pendingCount).toBe(0);
  expect(view.result.current.sessions.find((s) => s.id === 'b')?.lastModified).toBe(500);
});
