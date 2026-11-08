// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSessionOrdering } from '../useSessionOrder';
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it('keeps Chats stationary through delayed hydration and completion until Show latest', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const rows = [
    { id: 'recent', summary: '', lastModified: 500 },
    { id: 'older', summary: '', lastModified: 100 },
  ];
  const view = renderHook(
    ({ activities }) => useSessionOrdering(rows, activities, false, { manual: true }),
    { initialProps: { activities: [] as never[] } },
  );
  view.rerender({
    activities: [
      { sessionId: 'older', state: 'done', completedAt: 900, lastEventAt: 900 } as never,
    ],
  });
  act(() => vi.advanceTimersByTime(60000));
  expect(view.result.current.sessions.map((s) => s.id)).toEqual(['recent', 'older']);
  expect(view.result.current.pendingCount).toBe(1);
  act(() => view.result.current.showLatest());
  expect(view.result.current.sessions.map((s) => s.id)).toEqual(['older', 'recent']);
});
it('appends successive pages without rearranging earlier additions by their IDs', () => {
  const initial = [{ id: 'start', summary: '', lastModified: 500 }];
  const view = renderHook(({ rows }) => useSessionOrdering(rows, [], false, { manual: true }), {
    initialProps: { rows: initial },
  });
  const next = [...initial, { id: 'z-older', summary: '', lastModified: 100 }];
  view.rerender({ rows: next });
  view.rerender({ rows: [...next, { id: 'a-oldest', summary: '', lastModified: 50 }] });
  expect(view.result.current.sessions.map((s) => s.id)).toEqual(['start', 'z-older', 'a-oldest']);
});
