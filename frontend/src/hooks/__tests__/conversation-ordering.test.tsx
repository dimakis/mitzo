// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionActivity } from '@mitzo/protocol';
import { useSessionOrdering } from '../useSessionOrder';
import { useListBrowsing } from '../useListBrowsing';

const rows = [
  { id: 'a', summary: 'A', lastModified: 300 },
  { id: 'b', summary: 'B', lastModified: 200 },
  { id: 'c', summary: 'C', lastModified: 100 },
];
const live = (
  id: string,
  time: number,
  state: SessionActivity['state'] = 'working',
): SessionActivity => ({
  sessionId: id,
  clientId: id,
  title: id,
  state,
  flags: [],
  lastEventAt: time,
  lastMessageAt: time,
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const tick = (ms: number) => act(() => vi.advanceTimersByTime(ms));

it('promotes one conversation at a time and coalesces repeated updates for the same row', () => {
  const view = renderHook(({ activities }) => useSessionOrdering(rows, activities, false), {
    initialProps: { activities: rows.map((s) => live(s.id, s.lastModified)) },
  });
  view.rerender({ activities: [live('a', 300), live('b', 500), live('c', 600)] });
  tick(600);
  expect(view.result.current.sessions.map((s) => s.id)).toEqual(['c', 'a', 'b']);
  expect(view.result.current.pendingCount).toBe(1);
  view.rerender({ activities: [live('a', 300), live('b', 700), live('c', 600)] });
  tick(1000);
  expect(view.result.current.sessions.map((s) => s.id)).toEqual(['c', 'a', 'b']);
  tick(1500);
  expect(view.result.current.sessions.map((s) => s.id)).toEqual(['b', 'c', 'a']);
});

it('keeps finished sessions below running work and commits completion through the same queue', () => {
  const view = renderHook(
    ({ activities }) => useSessionOrdering(rows, activities, false, { grouped: true }),
    {
      initialProps: { activities: [live('a', 900, 'done'), live('b', 200), live('c', 100)] },
    },
  );
  expect(view.result.current.sessions.map((s) => s.id)).toEqual(['b', 'c', 'a']);
  view.rerender({ activities: [live('a', 900, 'done'), live('b', 1000, 'done'), live('c', 100)] });
  expect(view.result.current.sessions[0].id).toBe('b');
  tick(600);
  expect(view.result.current.sessions.map((s) => s.id)).toEqual(['c', 'b', 'a']);
});

it('holds nested scrolling and keeps the list still while scrolled away from the top', () => {
  function List() {
    const ref = useRef<HTMLDivElement>(null);
    const held = useListBrowsing(ref, false);
    return (
      <div ref={ref} data-testid="panel" data-held={held}>
        <div data-testid="scroll" />
      </div>
    );
  }
  const view = render(<List />);
  const scroll = view.getByTestId('scroll');
  scroll.scrollTop = 200;
  fireEvent.scroll(scroll);
  expect(view.getByTestId('panel').dataset.held).toBe('true');
  tick(10000);
  expect(view.getByTestId('panel').dataset.held).toBe('true');
  scroll.scrollTop = 0;
  fireEvent.scroll(scroll);
  tick(1000);
  expect(view.getByTestId('panel').dataset.held).toBe('false');
});
